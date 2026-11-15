(function () {
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return {"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c];
    });
  }
  // Projects that live in the Studio instead of Games.
  var STUDIO_GAMES = { "Photo Edit Game": true };
  // Display names where the Lab Notes game name differs from the project name.
  var DISPLAY_NAMES = { "Loading Screen and Lobby": "Lobby Game" };
  function slugFrom(url) {
    var parts = String(url || "").split("/");
    return parts[2] || "";
  }
  function displayName(game) {
    return DISPLAY_NAMES[game] || game;
  }
  function card(e) {
    var name = displayName(e.game);
    var slug = slugFrom(e.play_url);
    return '<article class="project-card">' +
      '<a href="' + esc(e.play_url) + '"><img class="project-shot" src="/assets/projects/' + esc(slug) + '.png" alt="' + esc(name) + '" loading="lazy" width="200" height="125"></a>' +
      '<h3 class="project-title">' + esc(name) + ' <span class="project-version">' + esc(e.version) + '</span></h3>' +
      '<p class="project-meta">' + esc(e.who) + ' \u00b7 ' + esc(e.date_display) + '</p>' +
      '<p>' + esc(e.note) + '</p>' +
      '<p><a class="button" href="' + esc(e.play_url) + '">Play</a></p>' +
      '</article>';
  }
  function render(list, entries) {
    if (!entries.length) {
      list.innerHTML = "<p>No projects here yet. Check back soon!</p>";
      return;
    }
    list.innerHTML = entries.map(card).join("");
  }
  function fail(list) {
    list.innerHTML = "<p>Projects could not be loaded right now. Please try again in a minute.</p>";
  }
  var gamesList = document.getElementById("projects-games");
  var studioList = document.getElementById("projects-studio");
  if (!gamesList && !studioList) return;
  fetch("/lab-notes.json")
    .then(function (r) { if (!r.ok) throw new Error("Lab Notes not found"); return r.json(); })
    .then(function (data) {
      var entries = (data && data.entries) || [];
      // Entries are newest first, so the first entry per game is its latest version.
      var seen = {};
      var latest = [];
      entries.forEach(function (e) {
        if (!e.game || seen[e.game]) return;
        seen[e.game] = true;
        latest.push(e);
      });
      var games = latest.filter(function (e) { return !STUDIO_GAMES[e.game]; });
      var studio = latest.filter(function (e) { return STUDIO_GAMES[e.game]; });
      if (gamesList) render(gamesList, games);
      if (studioList) render(studioList, studio);
    })
    .catch(function () {
      if (gamesList) fail(gamesList);
      if (studioList) fail(studioList);
    });
})();
