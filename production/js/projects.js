(function () {
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return {"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c];
    });
  }
  // Projects that live in the Studio instead of Games.
  var STUDIO_GAMES = { "Photo Edit Game": true, "Photo Studio": true };

  // Educational games live in their own section instead of Games.
  var EDU_GAMES = { "Oklahoma Trivia": true, "Shepherd's Class": true };
  // Cache-bust a card image after its screenshot is retaken (e.g. ?v=2).
  var SHOT_VERSIONS = { "oklahoma-trivia": 2 };
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
    var shot = '/assets/projects/' + esc(slug) + '.png' + (SHOT_VERSIONS[slug] ? '?v=' + SHOT_VERSIONS[slug] : '');
    return '<article class="project-card">' +
      '<a href="' + esc(e.play_url) + '"><img class="project-shot" src="' + shot + '" alt="' + esc(name) + '" loading="lazy" width="200" height="125"></a>' +
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
  var eduList = document.getElementById("projects-education");
  if (!gamesList && !studioList && !eduList) return;
  fetch("/lab-notes.json")
    .then(function (r) { if (!r.ok) throw new Error("Lab Notes not found"); return r.json(); })
    .then(function (data) {
      var entries = (data && data.entries) || [];
      // Entries are newest first, so the first entry per game is its latest version.
      // Group by the game's URL slug, not its display name, so a rename
      // (Photo Edit Game -> Photo Studio) shows one card, not two.
      var seen = {};
      var latest = [];
      entries.forEach(function (e) {
        if (!e.game || !e.play_url) return;
        var slug = slugFrom(e.play_url);
        if (!slug || seen[slug]) return;
        seen[slug] = true;
        latest.push(e);
      });
      var games = latest.filter(function (e) { return !STUDIO_GAMES[e.game] && !EDU_GAMES[e.game]; });
      var studio = latest.filter(function (e) { return STUDIO_GAMES[e.game]; });
      var edu = latest.filter(function (e) { return EDU_GAMES[e.game]; });
      if (gamesList) render(gamesList, games);
      if (studioList) render(studioList, studio);
      if (eduList) render(eduList, edu);
    })
    .catch(function () {
      if (gamesList) fail(gamesList);
      if (studioList) fail(studioList);
      if (eduList) fail(eduList);
    });

  // Projects feedback form: toggle + submit to /api/feedback.
  var fbOpen = document.getElementById("feedback-open");
  var fbSection = document.getElementById("feedback");
  var fbForm = document.getElementById("feedback-form");
  var fbStatus = document.getElementById("feedback-status");
  // Hide the form once this script runs. Without this script (or with a
  // stale cached copy) the form stays visible and the Feedback link jumps
  // straight to it, so the button can never be dead on iOS.
  if (fbSection) fbSection.hidden = true;
  function setFbStatus(text, cls) {
    if (!fbStatus) return;
    fbStatus.textContent = text;
    fbStatus.className = "status" + (cls ? " " + cls : "");
  }
  if (fbOpen && fbSection) {
    fbOpen.addEventListener("click", function (ev) {
      ev.preventDefault();
      var opening = fbSection.hidden;
      fbSection.hidden = !opening;
      if (opening) {
        // Let layout settle after unhiding before scrolling, or iOS
        // Safari scrolls to the wrong spot.
        requestAnimationFrame(function () {
          fbSection.scrollIntoView({ behavior: "smooth", block: "start" });
        });
      }
    });
  }
  if (fbForm && fbStatus) {
    fbForm.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var btn = fbForm.querySelector("button[type='submit']");
      var name = document.getElementById("feedback-name");
      var project = document.getElementById("feedback-project");
      var message = document.getElementById("feedback-message");
      var fax = fbForm.querySelector("input[name='fax_number']");
      setFbStatus("");
      var text = message ? message.value.trim() : "";
      if (text.length < 10) {
        setFbStatus("Please write a little more — at least a few words.", "is-error");
        if (message) message.focus();
        return;
      }
      if (text.length > 2000) {
        setFbStatus("Please keep it under 2000 characters.", "is-error");
        return;
      }
      if (btn) { btn.disabled = true; btn.textContent = "Sending..."; }
      fetch("/api/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name ? name.value : "",
          project: project ? project.value : "General",
          message: text,
          fax_number: fax ? fax.value : ""
        })
      })
        .then(function (r) { return r.json().then(function (d) { return { status: r.status, body: d }; }); })
        .then(function (res) {
          if (res.body && res.body.ok) {
            setFbStatus(res.body.message || "Thanks! Your feedback is on its way to the team.", "is-success");
            fbForm.reset();
          } else {
            setFbStatus((res.body && res.body.message) || "Something went wrong — please try again in a minute.", "is-error");
          }
        })
        .catch(function () {
          setFbStatus("Something went wrong — please try again in a minute.", "is-error");
        })
        .then(function () {
          if (btn) { btn.disabled = false; btn.textContent = "Send feedback"; }
        });
    });
  }
})();
