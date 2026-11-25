// The small script inside every report page: it lets an editor tick Pass / Fail / Skip / Review on a check row, in any report (a run that
// is still going or one that finished long ago). It saves with PUT /api/overrides, the same call the dashboard uses.
//
// ONE source for two places: src/report/html.js puts this text inside the page, and the Cloudflare function that serves the page lists
// its SHA-256 in the Content-Security-Policy, so exactly this script (and nothing else) may run there. So: no backslashes, no backticks and
// no dollar-brace in the text below (the text must reach the page unchanged), and any edit changes the hash by itself.
export const REPORT_SCRIPT = `(function () {
  var run = document.body.getAttribute('data-run');
  var boxes = document.querySelectorAll('input[data-vk]');
  if (!run || !boxes.length) return;
  var msg = document.getElementById('vmsg');
  var hint = document.getElementById('vhint');
  var LABEL = { skip: 'Skip', pass: 'Pass', review: 'Review', fail: 'Fail' };
  function say(text, kind) {
    if (!msg) return;
    msg.hidden = !text;
    msg.textContent = text || '';
    msg.className = 'note vmsg ' + (kind || '');
  }
  function enable(on, why) {
    for (var i = 0; i < boxes.length; i++) boxes[i].disabled = !on;
    if (hint) hint.textContent = on
      ? 'Tick Pass, Fail, Skip or Review on a row to put your own verdict on it (untick to go back to what the script found). It is saved at once; reload the page to see the totals follow.'
      : why;
  }
  var sameOrigin = location.protocol === 'http:' || location.protocol === 'https:';
  if (!sameOrigin) { enable(false, 'Open this report from the dashboard (the web page or the test machine) to change a result.'); return; }
  enable(false, 'Checking who you are...');
  fetch('/api/me', { credentials: 'same-origin', cache: 'no-store' }).then(function (r) {
    if (r.status === 200) return r.json().then(function (u) { return u && u.canEdit ? { ok: true } : { ok: false, why: 'You are signed in, but only the editors can change a result.' }; });
    if (r.status === 401) return { ok: false, why: 'Sign in on the dashboard first (with an editor account) to change a result.' };
    return { ok: true }; // the dashboard on the test machine has no sign-in
  }).catch(function () { return { ok: true }; }).then(function (a) { enable(a.ok, a.why); });

  function bucket(s) { return s === 'error' ? 'fail' : s; }
  function show(row, status, orig) {
    var cell = row.querySelector('.rcell');
    if (!cell) return;
    var shown = status ? (status === 'skip' ? 'na' : status) : bucket(orig);
    var pill = cell.querySelector('.pill');
    if (pill) { pill.className = 'pill p-' + shown; pill.textContent = shown.toUpperCase(); }
    var man = cell.querySelector('.man');
    if (!status) { if (man) man.parentNode.removeChild(man); return; }
    if (!man) { man = document.createElement('span'); man.className = 'man'; cell.appendChild(man); }
    man.textContent = 'MANUAL ' + status.toUpperCase() + ' (script: ' + orig + ')';
  }
  function put(body) {
    return fetch('/api/overrides', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-TC': '1' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Could not save'); return j; }); });
  }
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (!t || !t.getAttribute || !t.getAttribute('data-vk')) return;
    var grid = t.parentNode.parentNode;
    var key = t.getAttribute('data-vk'), orig = t.getAttribute('data-orig');
    var before = grid.getAttribute('data-cur') || '';
    var status = t.checked ? t.getAttribute('data-v') : '';
    var all = grid.querySelectorAll('input');
    for (var i = 0; i < all.length; i++) all[i].checked = !!status && all[i].getAttribute('data-v') === status;
    for (var k = 0; k < all.length; k++) all[k].disabled = true;
    say('Saving...', '');
    put({ run: run, key: key, status: status || null, orig: orig }).then(function () {
      grid.setAttribute('data-cur', status);
      show(grid.parentNode.parentNode, status, orig);
      say(status ? 'Saved: ' + LABEL[status] + '. Reload the page to see the totals follow (on the web copy the numbers update within about a minute).' : 'Saved: back to what the script found. Reload the page to see the totals follow.', 'ok');
    }).catch(function (err) {
      for (var j = 0; j < all.length; j++) all[j].checked = !!before && all[j].getAttribute('data-v') === before;
      say('Could not save: ' + err.message, 'bad');
    }).then(function () { for (var m = 0; m < all.length; m++) all[m].disabled = false; });
  });
})();`;
