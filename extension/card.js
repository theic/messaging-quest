// The card renderer. Ported from the predecessor's panel (messaging-quest,
// extension/sidepanel/card.js) with the extensions this product's deck needs:
// an actions row beyond two buttons (the reply card is a control panel), links
// that open elsewhere without writing anything, a disabled button that says
// WHY it is disabled — the gate's reason is the product, so it is never just
// greyed out — and, from 0.8.0, TABS: the three drafts the writer always
// writes, each with its own edits, the field showing the one selected, the
// answer saying which one the button was pressed from.
//
// Built with createElement rather than a template string: every label on a
// card is server-supplied text, some of it originally written by strangers on
// Reddit, and the one thing a panel must never do is parse it as markup.
//
// The panel has no render loop, so the card holds its selection, its tab and
// its field text internally and hands back a finished answer when a button
// is pressed:
//   onAnswer({ action, choice, choices, text, tab })
// where `action` is the pressed button's ID (never its slot — the server
// dispatches on ids like "watch" and "posted", not on "primary") and `tab`
// is the id of the draft on screen, when the card had tabs.

export function renderCard(host, card, onAnswer) {
  const picked = [];
  let text = card.field ? card.field.value || "" : "";

  const el = (tag, className, textContent) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (textContent) node.textContent = textContent;
    return node;
  };

  const article = el("article", "es-card");
  article.setAttribute("role", "region");

  if (card.eyebrow) article.append(el("p", "es-eyebrow", card.eyebrow));
  article.append(el("h2", "es-q", card.question));
  if (card.help) {
    const help = el("p", "es-help", card.help);
    help.style.whiteSpace = "pre-wrap"; // reply cards carry the person's own paragraphs
    article.append(help);
  }

  // What a paused worker saw: the screenshot the runtime took when it
  // stopped for a person. An image, never markup — the src is the server's.
  if (card.image) {
    const img = el("img", "es-shot");
    img.src = card.image;
    img.alt = "what the task sees in its tab";
    article.append(img);
  }

  if (card.choices?.length) {
    const list = el("ul", "es-choices");
    const buttons = [];
    for (const option of card.choices) {
      const button = el("button", "es-choice");
      button.type = "button";
      button.setAttribute("aria-pressed", "false");
      button.append(el("span", "es-choice-label", option.label));
      if (option.specimen) button.append(el("span", "es-choice-specimen", option.specimen));
      if (option.note) button.append(el("span", "es-choice-note", option.note));
      button.addEventListener("click", () => {
        if (card.multi) {
          const at = picked.indexOf(option.id);
          if (at < 0) picked.push(option.id); else picked.splice(at, 1);
          button.setAttribute("aria-pressed", String(at < 0));
          return;
        }
        picked.length = 0;
        picked.push(option.id);
        for (const other of buttons) other.setAttribute("aria-pressed", String(other === button));
      });
      buttons.push(button);
      const row = el("li");
      row.append(button);
      list.append(row);
    }
    article.append(list);
  }

  // The tabs (0.8.0): one per draft. Each keeps the operator's edits to it,
  // so switching back and forth loses nothing; the field below shows the
  // selected one, and its flags are said in words under the field.
  const tabs = Array.isArray(card.tabs) ? card.tabs.filter((t) => t && t.id) : [];
  let tab = tabs[0]?.id ?? null;
  const edits = new Map(tabs.map((t) => [t.id, String(t.value ?? "")]));
  if (tabs.length && card.field) text = edits.get(tab) ?? text;
  let field = null, grow = null, warn = null, tabButtons = [];

  const showWarnings = () => {
    if (!warn) return;
    const t = tabs.find((x) => x.id === tab);
    const words = t?.warnings?.length ? t.warnings : [];
    warn.textContent = words.length ? `Check before posting: ${words.join(" · ")}.` : "";
    warn.hidden = !words.length;
  };

  const select = (id) => {
    if (id === tab || !edits.has(id)) return;
    edits.set(tab, text);
    tab = id;
    text = edits.get(id) ?? "";
    if (field) { field.value = text; grow?.setAttribute("data-value", text); }
    for (const [tid, b] of tabButtons) b.setAttribute("aria-selected", String(tid === id));
    showWarnings();
  };

  if (tabs.length > 1) {
    const strip = el("div", "es-tabs-strip");
    strip.setAttribute("role", "tablist");
    strip.setAttribute("aria-label", "drafts");
    for (const t of tabs) {
      const b = el("button", "es-tab", t.label || t.id);
      b.type = "button";
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", String(t.id === tab));
      if (t.warnings?.length) b.append(el("span", "es-tab-dot", "•"));
      b.addEventListener("click", () => select(t.id));
      strip.append(b);
      tabButtons.push([t.id, b]);
    }
    article.append(strip);
  }

  const answer = (action) =>
    onAnswer({ action, choice: picked.length ? picked[picked.length - 1] : null, choices: [...picked], text, tab });

  if (card.field) {
    // Always a textarea inside the growing wrapper: the CSS sizes the box to
    // its own content off data-value, so a long draft is never hidden behind a
    // scrollbar — the predecessor learned that on a 167-character pitch shown
    // in a one-line input. `multiline` only decides what Enter does. `secret`
    // is for the key card: the value must not sit readable on a shared screen.
    grow = el("div", "es-grow");
    grow.setAttribute("data-value", text);
    field = el("textarea", "es-field");
    field.rows = 1;
    field.placeholder = card.field.placeholder || "";
    field.value = text;
    field.setAttribute("aria-label", card.question);
    if (card.field.secret) field.classList.add("es-secret");
    field.addEventListener("input", () => {
      text = field.value;
      grow.setAttribute("data-value", card.field.secret ? "•".repeat(text.length) : text);
    });
    if (!card.field.multiline) {
      field.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" || event.shiftKey) return;
        event.preventDefault();
        answer(card.primary.id);
      });
    }
    grow.append(field);
    article.append(grow);
  }

  if (tabs.length) {
    warn = el("p", "es-warn");
    warn.hidden = true;
    article.append(warn);
    showWarnings();
  }

  if (card.links?.length) {
    const links = el("div", "es-links");
    for (const l of card.links) {
      const a = el("a", "es-link", l.label + " ↗");
      a.href = l.href;
      a.target = "_blank";
      a.rel = "noreferrer noopener";
      links.append(a);
    }
    article.append(links);
  }

  const actions = el("div", "es-actions");
  const button = (spec, className) => {
    const b = el("button", className, spec.label);
    b.type = "button";
    if (spec.disabled) {
      b.disabled = true;
      if (spec.why) b.title = spec.why;
    } else {
      b.addEventListener("click", () => answer(spec.id));
    }
    return b;
  };
  if (card.secondary) actions.append(button(card.secondary, "es-secondary"));
  for (const extra of card.actions ?? []) actions.append(button(extra, "es-secondary"));
  actions.append(button(card.primary, "es-primary"));
  article.append(actions);

  // A disabled button's reason, said out loud under the row — a title attribute
  // alone hides the gate's answer behind a hover nobody does on purpose.
  const blocked = (card.actions ?? []).find((a) => a.disabled && a.why);
  if (blocked) article.append(el("p", "es-blocked", `The gate says not yet: ${blocked.why}.`));

  if (card.progress) {
    const bar = el("div", "es-progress");
    bar.setAttribute("aria-hidden", "true");
    for (let i = 0; i < card.progress.of; i += 1) bar.append(el("span", i < card.progress.step ? "on" : ""));
    article.append(bar);
  }

  host.replaceChildren(article);
}
