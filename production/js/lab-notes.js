(function () {
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return {"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c];
    });
  }
  var AVATARS = {
    "Ridge": "/assets/avatars/ridge-avatar.webp",
    "Rhett": "/assets/avatars/rhett-avatar.webp",
    "Dad": "/assets/avatars/dad-avatar.webp"
  };
  function avatarImgs(who) {
    var names = String(who == null ? "" : who).split(/\+|,|&|\band\b/i);
    var out = "";
    for (var i = 0; i < names.length; i++) {
      var n = names[i].replace(/^\s+|\s+$/g, "");
      if (AVATARS[n]) out += '<img class="lab-avatar" src="' + AVATARS[n] + '" alt="' + esc(n) + '" width="88" height="88" loading="lazy">';
    }
    return out;
  }
  function card(e) {
    var imgs = avatarImgs(e.who);
    return '<article class="lab-card">' +
      (imgs ? '<div class="lab-avatars">' + imgs + '</div>' : '') +
      '<div class="lab-card-body">' +
      '<h2 class="lab-card-title">' + esc(e.title) + '</h2>' +
      '<p class="lab-meta"><time datetime="' + esc(e.date) + '">' + esc(e.date_display) + '</time> \u00b7 ' + esc(e.who) + ' \u00b7 ' + esc(e.game) + '</p>' +
      '<p>' + esc(e.note) + '</p>' +
      '<p><a class="button" href="' + esc(e.play_url) + '">Play this version</a></p>' +
      '</div></article>';
  }
  function render(list, entries) {
    if (!entries.length) {
      list.innerHTML = "<p>No Lab Notes yet. Check back soon!</p>";
      return;
    }
    list.innerHTML = entries.map(card).join("");
  }
  function fail(list) {
    list.innerHTML = "<p>Lab Notes could not be loaded right now. Please try again in a minute.</p>";
  }
  var all = document.getElementById("lab-notes-all");
  var latest = document.getElementById("lab-notes-latest");
  if (!all && !latest) return;
  fetch("/lab-notes.json")
    .then(function (r) { if (!r.ok) throw new Error("Lab Notes not found"); return r.json(); })
    .then(function (data) {
      var entries = (data && data.entries) || [];
      if (all) render(all, entries);
      if (latest) render(latest, entries.slice(0, 3));
    })
    .catch(function () {
      if (all) fail(all);
      if (latest) fail(latest);
    });
})();
