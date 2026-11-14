(function () {
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>\"']/g, function (c) {
      return {"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c];
    });
  }
  function fmtDate(ts) {
    try {
      return new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    } catch (e) {
      return "";
    }
  }

  var listEl = document.getElementById("admin-photos");
  var statusEl = document.getElementById("admin-status");
  if (!listEl) return;

  function setStatus(msg) {
    if (statusEl) statusEl.textContent = msg;
  }

  function load() {
    listEl.innerHTML = "<p class=\"lab-loading\">Loading photos waiting for review…</p>";
    fetch("/api/photos?status=pending")
      .then(function (r) { if (!r.ok) throw new Error("photos not found"); return r.json(); })
      .then(function (data) {
        var photos = (data && data.photos) || [];
        if (!photos.length) {
          listEl.innerHTML = "<p>No photos waiting for review. Nice — the wall is all caught up.</p>";
          return;
        }
        listEl.innerHTML = "";
        photos.forEach(function (p) {
          var card = document.createElement("figure");
          card.className = "photo-card admin-card";
          var img = document.createElement("img");
          img.src = "/api/photos/" + p.id;
          img.alt = "Photo by " + p.name + " waiting for review";
          img.loading = "lazy";
          var cap = document.createElement("figcaption");
          cap.textContent = p.name + " · " + fmtDate(p.ts);
          var row = document.createElement("div");
          row.className = "admin-actions";
          var ok = document.createElement("button");
          ok.type = "button";
          ok.className = "button";
          ok.textContent = "✓ Approve";
          ok.addEventListener("click", function () { review(p.id, "approve", ok, no); });
          var no = document.createElement("button");
          no.type = "button";
          no.className = "button";
          no.textContent = "✕ Reject";
          no.addEventListener("click", function () { review(p.id, "reject", ok, no); });
          row.appendChild(ok);
          row.appendChild(no);
          card.appendChild(img);
          card.appendChild(cap);
          card.appendChild(row);
          listEl.appendChild(card);
        });
      })
      .catch(function () {
        listEl.innerHTML = "<p>Photos could not be loaded right now. Please try again in a minute.</p>";
      });
  }

  function review(id, action, okBtn, noBtn) {
    okBtn.disabled = true;
    noBtn.disabled = true;
    setStatus(action === "approve" ? "Approving…" : "Rejecting…");
    fetch("/api/photos/approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: id, action: action })
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
      .then(function (res) {
        if (!res.ok || !res.data.ok) throw new Error((res.data && res.data.message) || "Could not review that photo.");
        setStatus(action === "approve" ? "Approved — it is on the Wall of Fame now." : "Rejected — it is gone.");
        load();
      })
      .catch(function (err) {
        setStatus(err.message || "Could not review that photo.");
        okBtn.disabled = false;
        noBtn.disabled = false;
      });
  }

  load();
})();
