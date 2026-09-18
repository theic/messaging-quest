// The front page: one box, then one question — where to send what Quest
// finds — and the chat. Whatever was typed in the box survives the sign-up
// and becomes the first message, so nothing is asked for twice.

(function () {
  var what = document.getElementById("what");
  var ask = document.getElementById("ask");
  var join = document.getElementById("join");
  var form = document.getElementById("join-form");
  var email = document.getElementById("email");
  var err = document.getElementById("join-err");
  var go = document.getElementById("join-go");
  var cvInput = document.getElementById("cv");
  var cvErr = document.getElementById("cv-err");
  var attached = document.getElementById("attached");
  var attachedName = document.getElementById("attached-name");
  var cv = null;   // { name, data } — the PDF as a data URL, read here, sent with the sign-up

  // A CV instead of a site: read in the page, sent with the sign-up. The
  // server takes JSON up to 2 MB, so the file stays under 1.4 MB.
  document.getElementById("cv-pick").addEventListener("click", function () { cvInput.click(); });
  cvInput.addEventListener("change", function () {
    var f = cvInput.files && cvInput.files[0];
    cvInput.value = "";
    cvErr.hidden = true;
    if (!f) return;
    if (!/pdf$/i.test(f.type) && !/\.pdf$/i.test(f.name)) { cvErr.textContent = "That isn't a PDF — save your CV as a PDF and try again."; cvErr.hidden = false; return; }
    if (f.size > 1400 * 1024) { cvErr.textContent = "That PDF is over 1.4 MB — a shorter export of your CV will do."; cvErr.hidden = false; return; }
    var reader = new FileReader();
    reader.onload = function () {
      cv = { name: f.name, data: String(reader.result).replace(/^data:[^;,]*;base64,/, "data:application/pdf;base64,") };
      attachedName.textContent = "📎 " + f.name;
      attached.hidden = false;
      what.placeholder = "Anything to add? (optional)";
      what.focus();
    };
    reader.onerror = function () { cvErr.textContent = "That file could not be read."; cvErr.hidden = false; };
    reader.readAsDataURL(f);
  });
  document.getElementById("attached-drop").addEventListener("click", function () {
    cv = null;
    attached.hidden = true;
    what.placeholder = "https://yourproduct.com";
  });

  // The box grows with what is pasted into it, up to its CSS ceiling.
  function grow() { what.style.height = "auto"; what.style.height = Math.min(what.scrollHeight, 220) + "px"; }
  what.addEventListener("input", grow);

  // Enter sends; Shift+Enter is a new line for somebody describing, not pasting.
  what.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask.requestSubmit(); }
  });

  fetch("/api/me").then(function (r) { return r.json(); }).then(function (d) {
    if (d && d.customer) {
      document.getElementById("continue").hidden = false;
      if (d.customer.email) email.value = d.customer.email;
    }
  }).catch(function () { /* the front page works without it */ });

  ask.addEventListener("submit", function (e) {
    e.preventDefault();
    if (!what.value.trim() && !cv) { what.focus(); return; }
    err.hidden = true;
    if (typeof join.showModal === "function") join.showModal(); else join.setAttribute("open", "");
    email.focus();
  });

  document.getElementById("join-back").addEventListener("click", function () { join.close(); what.focus(); });

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    go.disabled = true;
    err.hidden = true;
    fetch("/api/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: email.value, text: what.value, file: cv }),
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (x) {
        if (!x.ok || x.d.error) throw new Error(x.d.error || "that did not work — try again");
        location.href = "/app";
      })
      .catch(function (e2) {
        err.textContent = e2.message;
        err.hidden = false;
        go.disabled = false;
      });
  });

  document.getElementById("again").addEventListener("click", function (e) {
    e.preventDefault();
    window.scrollTo({ top: 0, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    what.focus({ preventScroll: true });
  });
})();
