// Submit Ideas form: validate, then POST JSON to /api/ideas with the
// Cloudflare Turnstile token. Mirrors the Projects feedback form pattern.
(function () {
  var form = document.getElementById("idea-form");
  var statusEl = document.getElementById("idea-status");
  if (!form || !statusEl) return;

  function setStatus(text, cls) {
    statusEl.textContent = text;
    statusEl.className = "status" + (cls ? " " + cls : "");
  }

  form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var btn = form.querySelector("button[type='submit']");
    var name = document.getElementById("idea-name");
    var email = document.getElementById("idea-email");
    var idea = document.getElementById("idea-idea");
    var fax = form.querySelector("input[name='fax_number']");
    setStatus("");

    var ideaText = idea ? idea.value.trim() : "";
    if (ideaText.length < 10) {
      setStatus("Please tell us a little more about your idea — at least a few words.", "is-error");
      if (idea) idea.focus();
      return;
    }
    if (ideaText.length > 2000) {
      setStatus("Please keep your idea under 2000 characters.", "is-error");
      return;
    }

    var token = "";
    try {
      if (window.turnstile) token = window.turnstile.getResponse() || "";
    } catch (e) {
      token = "";
    }
    if (!token) {
      setStatus("Please complete the captcha check below, then send your idea.", "is-error");
      return;
    }

    if (btn) { btn.disabled = true; btn.textContent = "Sending..."; }
    fetch("/api/ideas", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: name ? name.value : "",
        email: email ? email.value : "",
        idea: ideaText,
        turnstileToken: token,
        fax_number: fax ? fax.value : ""
      })
    })
      .then(function (r) { return r.json().then(function (d) { return { status: r.status, body: d }; }); })
      .then(function (res) {
        if (res.body && res.body.ok) {
          setStatus(res.body.message || "Thanks! Your idea is on its way to Ridge and Rhett.", "is-success");
          form.reset();
        } else {
          setStatus((res.body && res.body.message) || "Something went wrong. Please try again.", "is-error");
        }
        try { if (window.turnstile) window.turnstile.reset(); } catch (e) { /* ignore */ }
      })
      .catch(function () {
        setStatus("Something went wrong. Please try again.", "is-error");
        try { if (window.turnstile) window.turnstile.reset(); } catch (e) { /* ignore */ }
      })
      .finally(function () {
        if (btn) { btn.disabled = false; btn.textContent = "Send my idea"; }
      });
  });
})();
