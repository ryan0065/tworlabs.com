const form = document.querySelector("#notify");
const statusEl = document.querySelector("#form-status");
const emailInput = document.querySelector("#email");

if (form && statusEl && emailInput) {
  const button = form.querySelector("button[type='submit']");
  const idleLabel = button ? button.textContent : "Get Notified";

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = emailInput.value.trim();
    const fax = new FormData(form).get("fax_number");
    setStatus("");

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setStatus("Please enter a valid email address.", "is-error");
      emailInput.setAttribute("aria-invalid", "true");
      emailInput.focus();
      return;
    }

    emailInput.removeAttribute("aria-invalid");
    if (button) {
      button.disabled = true;
      button.textContent = "Sending...";
    }
    form.setAttribute("aria-busy", "true");

    try {
      const response = await fetch("/api/subscribe", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          email,
          fax_number: typeof fax === "string" ? fax : "",
        }),
      });

      let payload = {};
      try {
        payload = await response.json();
      } catch {
        payload = {};
      }

      if (response.ok && payload.ok !== false) {
        setStatus(payload.message || "You're on the list!", "is-success");
        form.reset();
        emailInput.removeAttribute("aria-invalid");
      } else {
        setStatus(payload.message || "Something went wrong. Please try again.", "is-error");
        if (payload.field === "email") {
          emailInput.setAttribute("aria-invalid", "true");
          emailInput.focus();
        }
      }
    } catch {
      setStatus("We couldn't reach the signup service. Please try again in a minute.", "is-error");
    } finally {
      form.removeAttribute("aria-busy");
      if (button) {
        button.disabled = false;
        button.textContent = idleLabel;
      }
    }
  });
}

function setStatus(message, kind) {
  statusEl.textContent = message;
  statusEl.className = kind ? `status ${kind}` : "status";
}
