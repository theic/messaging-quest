// The chat: one transcript (the engine's /api/chat, lib/chat.mjs on disk),
// polled, and one box to add to it. Everything anybody wrote reaches the page
// as text nodes — a post a stranger wrote passes through here, and the only
// safe way to show it is never to parse it as markup.

(function () {
  var log = document.getElementById("log");
  var thinking = document.getElementById("thinking");
  var thinkingText = document.getElementById("thinking-text");
  var who = document.getElementById("who");
  var form = document.getElementById("say");
  var text = document.getElementById("text");
  var send = document.getElementById("send");
  var found = document.getElementById("found-list");
  var foundEmpty = document.getElementById("found-empty");
  var seen = null;   // what was last painted, so a poll that brings nothing new costs nothing
  var pick = {};     // which reply style each opportunity card is showing

  var el = function (tag, cls, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  };
  var clock = function (iso) {
    var d = new Date(iso);
    return isNaN(d) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  };
  var ago = function (iso) {
    var t = Date.parse(iso);
    if (!isFinite(t)) return "";
    var m = Math.max(1, Math.round((Date.now() - t) / 60000));
    return m < 90 ? m + " min ago" : m < 36 * 60 ? Math.round(m / 60) + " h ago" : Math.round(m / 1440) + " d ago";
  };

  /** Text with its web addresses made into links, as nodes. */
  function linked(node, s) {
    var re = /https?:\/\/[^\s<>"')]+/g, at = 0, m;
    while ((m = re.exec(s))) {
      var url = m[0].replace(/[.,;:!?]+$/, "");
      if (m.index > at) node.appendChild(document.createTextNode(s.slice(at, m.index)));
      var a = el("a", null, url);
      a.href = url; a.target = "_blank"; a.rel = "noopener noreferrer";
      node.appendChild(a);
      at = m.index + url.length;
    }
    if (at < s.length) node.appendChild(document.createTextNode(s.slice(at)));
  }

  function paragraphs(node, s) {
    String(s || "").split(/\n{2,}/).forEach(function (para) {
      if (!para.trim()) return;
      var p = el("p");
      para.split("\n").forEach(function (line, i) {
        if (i) p.appendChild(el("br"));
        linked(p, line);
      });
      node.appendChild(p);
    });
  }

  function post(path, body) {
    return fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      .then(function (r) { return r.json(); })
      .then(function (d) { if (d.error) throw new Error(d.error); return d; });
  }

  function act(m, action, button) {
    if (action === "change") {
      text.placeholder = "What should change? For example: it's for agencies, not founders";
      text.focus();
      return;
    }
    if (button) button.disabled = true;
    return post("/api/chat/act", { id: m.id, action: action })
      .then(poll)
      .catch(function (e) { window.alert(e.message); if (button) button.disabled = false; });
  }

  /* ------------------------------------------------------------ cards */

  /** The confirm card's buttons while it is open; what became of it after. */
  function offerFoot(m) {
    var c = m.card;
    if (c.state === "open") {
      var row = el("div", "acts");
      (c.actions || []).forEach(function (a, i) {
        var b = el("button", i === 0 ? "go" : "ghost", a.label);
        b.type = "button";
        b.addEventListener("click", function () { act(m, a.id, b); });
        row.appendChild(b);
      });
      return row;
    }
    return el("p", "state", c.state === "confirmed" ? "✓ Confirmed" : c.state === "replaced" ? "Replaced by the card below" : c.state);
  }

  /** One person who may need what they sell: where, when, their words, why
   *  it fits, a reply — and the five things a customer does with it. */
  function opportunity(li, m) {
    var c = m.card;
    li.appendChild(el("span", "by", ["QUEST", c.room, c.posted_at ? ago(c.posted_at) : "", c.author ? "u/" + c.author : ""].filter(Boolean).join(" · ")));
    if (c.title) li.appendChild(el("p", "opp-title", c.title));
    if (c.quote && c.quote !== c.title) li.appendChild(el("blockquote", "opp-quote", c.quote));
    if (c.why) { var w = el("p", "opp-why"); w.appendChild(el("b", null, "Why it fits: ")); w.appendChild(document.createTextNode(c.why)); li.appendChild(w); }

    var drafts = c.drafts && c.drafts.length ? c.drafts : c.draft ? [{ style: "reply", text: c.draft }] : [];
    var shown = drafts.length ? drafts[Math.min(pick[m.id] || 0, drafts.length - 1)] : null;
    if (c.state === "dismissed") {
      li.appendChild(el("p", "state dim", "Marked not relevant. Tell Quest what was off, and it will leave people like this out."));
      return;
    }
    var box = el("div", "opp-draft");
    if (drafts.length > 1) {
      var tabs = el("div", "tabs");
      drafts.forEach(function (d, i) {
        var t = el("button", "tab" + (d === shown ? " on" : ""), d.style === "ask_back" ? "ask back" : d.style);
        t.type = "button";
        t.addEventListener("click", function () { pick[m.id] = i; seen = null; poll(); });
        tabs.appendChild(t);
      });
      box.appendChild(tabs);
    }
    box.appendChild(el("span", "label", "A reply you could post"));
    if (shown) paragraphs(box, shown.text);
    else box.appendChild(el("p", "muted", c.no_draft ? "No reply suggested for this one — " + c.no_draft : "Writing a reply…"));
    li.appendChild(box);

    var row = el("div", "acts");
    var open = el("button", "go", "Open thread");
    open.type = "button";
    open.addEventListener("click", function () { window.open(c.url, "_blank", "noopener,noreferrer"); act(m, "open"); });
    row.appendChild(open);
    var copy = el("button", "ghost", "Copy reply");
    copy.type = "button";
    copy.disabled = !shown;
    copy.addEventListener("click", function () {
      if (!shown) return;
      (navigator.clipboard ? navigator.clipboard.writeText(shown.text) : Promise.reject(new Error("no clipboard")))
        .then(function () { copy.textContent = "Copied"; act(m, "copy"); })
        .catch(function () { window.prompt("Copy the reply:", shown.text); });
    });
    row.appendChild(copy);
    [["good", "👍", "Relevant"], ["bad", "👎", "Not relevant"]].forEach(function (x) {
      var b = el("button", "ghost thumb" + (c.rating === x[0] ? " on" : ""), x[1]);
      b.type = "button"; b.title = x[2]; b.setAttribute("aria-label", x[2]);
      b.addEventListener("click", function () { act(m, x[0], b); });
      row.appendChild(b);
    });
    if (c.state !== "replied") {
      var r = el("button", "ghost", "I replied");
      r.type = "button";
      r.addEventListener("click", function () { act(m, "replied", r); });
      row.appendChild(r);
    }
    li.appendChild(row);
    if (c.state === "replied") li.appendChild(el("p", "state", "✓ You replied — nice."));
  }

  function bubble(m) {
    var kind = m.card && m.card.kind;
    var li = el("li", "msg " + (m.from === "you" ? "you" : "quest") + (m.error ? " error" : "")
      + (kind ? " card " + kind + (m.card.state ? " " + m.card.state : "") : ""));
    li.id = "m" + m.id;
    if (kind === "opportunity") opportunity(li, m);
    else {
      if (m.from !== "you") li.appendChild(el("span", "by", "QUEST"));
      paragraphs(li, m.text);
      if (kind === "offer") li.appendChild(offerFoot(m));
    }
    var t = el("time", null, clock(m.at));
    t.dateTime = m.at;
    li.appendChild(t);
    return li;
  }

  function hello() {
    var li = el("li", "msg quest hello");
    li.appendChild(el("p", null, "Tell me what you sell — paste your site's address, or describe it in a sentence — and I'll start looking for the people who need it."));
    return li;
  }

  /** The side list: every opportunity so far, newest first, one line each. */
  function side(msgs) {
    var opps = msgs.filter(function (m) { return m.card && m.card.kind === "opportunity"; }).reverse();
    found.textContent = "";
    foundEmpty.hidden = opps.length > 0;
    opps.forEach(function (m) {
      var c = m.card;
      var li = el("li", "found-row" + (c.state === "dismissed" ? " dim" : ""));
      var a = el("a", null, c.title || c.quote || "(no title)");
      a.href = "#m" + m.id;
      li.appendChild(a);
      var tag = c.state === "replied" ? "replied" : c.state === "dismissed" ? "not relevant" : c.rating === "good" ? "relevant" : c.opened_at ? "opened" : "new";
      li.appendChild(el("span", "meta", c.room + (c.posted_at ? " · " + ago(c.posted_at) : "") + " · " + tag));
      found.appendChild(li);
    });
  }

  /** What is happening right now, in one line: Quest composing an answer,
   *  or the engine reading something for them. */
  function status(d) {
    var work = (d.working || []).map(function (j) { return j.label + (j.total ? " (" + (j.done || 0) + " of " + j.total + ")" : ""); });
    if (d.thinking) work.unshift("Quest is thinking");
    return work.length ? work.join(" · ") + "…" : "";
  }

  function paint(d) {
    var line = status(d);
    var key = JSON.stringify([d.version, line]);
    if (key === seen) return;
    seen = key;
    var nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    log.textContent = "";
    var msgs = d.messages || [];
    if (!msgs.length) log.appendChild(hello());
    msgs.forEach(function (m) { log.appendChild(bubble(m)); });
    side(msgs);
    thinking.hidden = !line;
    thinkingText.textContent = line;
    if (nearBottom || msgs.length && msgs[msgs.length - 1].from === "you") log.scrollTop = log.scrollHeight;
  }

  function poll() {
    return fetch("/api/chat", { headers: { accept: "application/json" } })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.customer) { location.replace("/"); return; }
        var site = d.customer.url ? " · " + d.customer.url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "") : "";
        who.textContent = (d.customer.email || "") + site;
        paint(d);
      })
      .catch(function () { /* the server is restarting; the next poll will find it */ });
  }

  function grow() { text.style.height = "auto"; text.style.height = Math.min(text.scrollHeight, 200) + "px"; }
  text.addEventListener("input", grow);
  text.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
  });

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var said = text.value.trim();
    if (!said) return;
    send.disabled = true;
    post("/api/chat", { text: said })
      .then(function () { text.value = ""; grow(); return poll(); })
      .catch(function (e2) { window.alert(e2.message); })
      .then(function () { send.disabled = false; text.focus(); });
  });

  poll();
  setInterval(poll, 1500);
  text.focus();
})();
