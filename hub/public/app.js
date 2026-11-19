// Slop Box landing page. Plain ES2017 for older TV browsers: no optional chaining or `??`.
(function () {
  'use strict';

  var list = document.getElementById('games');

  // Each game lives at https://<id>.<this host>.
  function gameUrl(id, page) {
    return location.protocol + '//' + id + '.' + location.host + (page || '/');
  }

  function el(tag, attrs, text) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { node.setAttribute(k, attrs[k]); });
    if (text != null) node.textContent = text;
    return node;
  }

  function card(game) {
    var li = el('li', { 'class': 'card' });
    li.appendChild(el('h2', null, game.name || game.id));

    var chips = el('ul', { 'class': 'chips' });
    if (game.players) chips.appendChild(el('li', null, game.players + ' players'));
    chips.appendChild(el('li', null, game.needsTv ? 'TV' : 'Phones only'));
    (game.extraDevices || []).forEach(function (d) { chips.appendChild(el('li', null, d)); });
    li.appendChild(chips);

    if (game.blurb) li.appendChild(el('p', { 'class': 'blurb' }, game.blurb));

    var actions = el('div', { 'class': 'actions' });
    if (game.needsTv) {
      actions.appendChild(el('a', { 'class': 'btn', href: gameUrl(game.id, '/tv') }, 'Open on TV'));
      actions.appendChild(el('a', { 'class': 'btn secondary', href: gameUrl(game.id, '/') }, 'Join with phone'));
    } else {
      actions.appendChild(el('a', { 'class': 'btn', href: gameUrl(game.id, '/') }, 'Play'));
    }
    li.appendChild(actions);
    return li;
  }

  function show(games) {
    list.textContent = '';
    if (!games.length) {
      list.appendChild(el('li', { 'class': 'note' }, 'No games yet.'));
      return;
    }
    games.forEach(function (g) { list.appendChild(card(g)); });
  }

  fetch('/games.json', { cache: 'no-cache' })
    .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(show)
    .catch(function () {
      list.textContent = '';
      list.appendChild(el('li', { 'class': 'note' }, 'Couldn’t load the games. Refresh to try again.'));
    });

  // TV remotes send arrow keys. Move focus to the nearest button in that direction.
  var DIRS = { 37: [-1, 0], 38: [0, -1], 39: [1, 0], 40: [0, 1] };
  var KEYS = { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 };

  function center(node) {
    var r = node.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  document.addEventListener('keydown', function (e) {
    var dir = DIRS[e.keyCode || KEYS[e.key]];
    if (!dir) return;
    var items = Array.prototype.slice.call(document.querySelectorAll('.btn, .text-link'));
    if (!items.length) return;
    e.preventDefault();

    var current = document.activeElement;
    if (items.indexOf(current) < 0) { items[0].focus(); return; }

    var from = center(current), best = null, bestScore = Infinity;
    items.forEach(function (item) {
      if (item === current) return;
      var to = center(item);
      var dx = to.x - from.x, dy = to.y - from.y;
      var along = dx * dir[0] + dy * dir[1];        // distance in the pressed direction
      if (along <= 1) return;                        // behind or level with the current button
      var across = Math.abs(dx * dir[1] + dy * dir[0]);
      var score = along + across * 2;                // prefer buttons straight ahead
      if (score < bestScore) { bestScore = score; best = item; }
    });
    if (best) {
      best.focus();
      if (best.scrollIntoView) best.scrollIntoView({ block: 'nearest' });
    }
  });
})();
