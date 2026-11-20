// Shared by the admin and closed pages. Plain ES2017 for older TV browsers.
(function () {
  'use strict';

  function timeText(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  function leftText(ts) {
    var mins = Math.max(0, Math.round((ts - Date.now()) / 60000));
    var h = Math.floor(mins / 60), m = mins % 60;
    return h ? h + 'h ' + m + 'm' : m + 'm';
  }
  function render() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-ts]'), function (n) {
      var ts = Number(n.getAttribute('data-ts'));
      if (ts) n.textContent = timeText(ts);
    });
    // Admin page update history: these can be days old, so include the date.
    Array.prototype.forEach.call(document.querySelectorAll('[data-when]'), function (n) {
      var ts = Number(n.getAttribute('data-when'));
      if (ts) n.textContent = new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-left]'), function (n) {
      var ts = Number(n.getAttribute('data-left'));
      if (ts) n.textContent = leftText(ts);
    });
  }
  render();
  setInterval(render, 30000);

  // Closed page: check every 10 s, and go in as soon as the host opens the games.
  var waiting = document.querySelector('[data-next]');
  if (waiting) {
    var next = waiting.getAttribute('data-next');
    setInterval(function () {
      fetch('/status', { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (s) {
          if (s.phase === 'open') location.href = next ? '/pass?next=' + encodeURIComponent(next) : '/';
        })
        .catch(function () {});
    }, 10000);
  }
})();
