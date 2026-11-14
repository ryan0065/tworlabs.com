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

  var scoresEl = document.getElementById("board-scores");
  var photosEl = document.getElementById("board-photos");
  if (!scoresEl && !photosEl) return;

  fetch("/api/fame")
    .then(function (r) { if (!r.ok) throw new Error("scores not found"); return r.json(); })
    .then(function (data) {
      var scores = (data && data.scores) || [];
      if (!scores.length) {
        scoresEl.innerHTML = "<p>No legends yet — play Ridge World and be the first name on the wall!</p>";
        return;
      }
      var rows = scores.map(function (e, i) {
        return '<article class="lab-card fame-row">' +
          '<p class="lab-meta">#' + (i + 1) + ' · ' + esc(fmtDate(e.ts)) + '</p>' +
          '<h2 class="lab-card-title">' + esc(e.name) + '</h2>' +
          '<p>⭐ ' + esc(e.score) + ' points · 🎯 ' + esc(e.acc) + '% accuracy · smashed ' + esc(e.smashed) + ' things</p>' +
          '</article>';
      }).join("");
      scoresEl.innerHTML = rows;
    })
    .catch(function () {
      scoresEl.innerHTML = "<p>Scores could not be loaded right now. Please try again in a minute.</p>";
    });

  fetch("/api/photos")
    .then(function (r) { if (!r.ok) throw new Error("photos not found"); return r.json(); })
    .then(function (data) {
      var photos = (data && data.photos) || [];
      if (!photos.length) {
        photosEl.innerHTML = "<p>No photos on the wall yet — edit a photo and send it in!</p>";
        return;
      }
      var cards = photos.map(function (p) {
        return '<figure class="photo-card">' +
          '<img src="/api/photos/' + esc(p.id) + '" alt="Edited photo by ' + esc(p.name) + '" loading="lazy">' +
          '<figcaption>' + esc(p.name) + ' · ' + esc(fmtDate(p.ts)) + '</figcaption>' +
          '</figure>';
      }).join("");
      photosEl.innerHTML = cards;
    })
    .catch(function () {
      photosEl.innerHTML = "<p>Photos could not be loaded right now. Please try again in a minute.</p>";
    });
})();
