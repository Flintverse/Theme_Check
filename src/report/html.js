// Run-sheet report: header facts, totals, shared issues, theme x check matrix, then one card per checklist item (failures first).
const { flatten, compare, groupIssues, totals, FAIL } = require('./compare');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const CSS = `
:root{--bg:#f5f6f4;--surface:#fff;--ink:#1b2321;--muted:#5b6662;--line:#dfe3df;--accent:#1f6f5c;--pass:#1c7a4a;--pass-bg:#e3f3e9;--fail:#b42318;--fail-bg:#fdeceb;--na:#4b5563;--na-bg:#eceef0;--review:#9a5b00;--review-bg:#fdf2dc}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#121615;--surface:#1a201e;--ink:#e6ebe8;--muted:#9aa6a1;--line:#2c3532;--accent:#5fc3a7;--pass:#6fd39c;--pass-bg:#173326;--fail:#ff8a7e;--fail-bg:#3a1a17;--na:#b8c0c8;--na-bg:#262c31;--review:#f2b860;--review-bg:#3a2a10}}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 system-ui,sans-serif}
.wrap{max-width:1180px;margin:0 auto;padding:32px 16px 64px;display:grid;gap:22px}
h1{font:600 30px/1.15 Georgia,serif;margin:0}
h2.sec{font:600 13px ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:8px 0 0}
.eyebrow{font:500 12px ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase;color:var(--accent)}
.facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px 24px;margin:0}
.facts dt{font:500 11px ui-monospace,monospace;text-transform:uppercase;color:var(--muted)}
.facts dd{margin:2px 0 0;overflow-wrap:anywhere}
.totals{display:flex;flex-wrap:wrap;gap:8px}
.t{padding:8px 14px;border-radius:8px;font:500 13px ui-monospace,monospace}
.t b{font:600 22px system-ui;margin-right:6px}
.t-pass,.p-pass{background:var(--pass-bg);color:var(--pass)}
.t-fail,.p-fail,.p-error{background:var(--fail-bg);color:var(--fail)}
.t-na,.p-na{background:var(--na-bg);color:var(--na)}
.t-review,.p-review{background:var(--review-bg);color:var(--review)}
.card{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:16px 18px;display:grid;gap:10px;min-width:0}
.card.r-fail{border-color:var(--fail)}
.pill{font:600 11px ui-monospace,monospace;letter-spacing:.06em;padding:3px 8px;border-radius:999px;white-space:nowrap}
.h{display:flex;flex-wrap:wrap;align-items:center;gap:10px}
.cid{font:500 14px ui-monospace,monospace}
.refs{font:12px ui-monospace,monospace;color:var(--muted)}
.card h3{margin:0;font:600 16px system-ui}
.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px 20px;margin:0}
.cols dt{font:500 11px ui-monospace,monospace;text-transform:uppercase;color:var(--muted)}
.cols dd{margin:2px 0 0}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{border:1px solid var(--line);padding:5px 8px;text-align:left;vertical-align:top}
th{background:var(--na-bg);font-weight:600}
td.c{text-align:center;font:600 12px ui-monospace,monospace}
.m-fail{background:var(--fail-bg);color:var(--fail)}
.m-pass{color:var(--pass)}
.m-na{color:var(--na)}
.m-review{color:var(--review)}
.scroll{overflow-x:auto}
details.ev{border-top:1px solid var(--line);padding-top:8px;margin-top:6px}
summary{cursor:pointer;font:500 13px ui-monospace,monospace;color:var(--accent)}
.shots{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px;margin-top:10px}
figure{margin:0}
figure img{width:100%;height:auto;border:1px solid var(--line);border-radius:6px}
figcaption{font:12px ui-monospace,monospace;color:var(--muted)}
.chg{font:700 10px ui-monospace,monospace;padding:2px 6px;border-radius:4px;margin-left:6px}
.NEW{background:var(--fail);color:#fff}
.STILL{background:var(--na-bg);color:var(--na)}
.FIXED{background:var(--pass);color:#fff}
.note{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:14px 18px}
.note ul{margin:6px 0 0;padding-left:18px}
`;

const pill = (s) => `<span class="pill p-${esc(s)}">${esc(String(s).toUpperCase())}</span>`;
const chg = (c) => (c ? `<span class="chg ${esc(c)}">${esc(c)}</span>` : '');

function render(run, checklist, prevRun) {
  const flat = flatten(run);
  const { rows, fixed } = compare(flat, prevRun ? flatten(prevRun) : null);
  const t = totals(rows);
  const issues = groupIssues(rows, checklist);
  const themes = (run.themes || []).map((x) => x.name);
  const byId = new Map();
  rows.forEach((r) => { if (!byId.has(r.id)) byId.set(r.id, []); byId.get(r.id).push(r); });
  const meta = new Map(checklist.items.map((i) => [i.id, i]));
  const matrixIds = checklist.items.map((i) => i.id);
  const cardIds = matrixIds.concat(byId.has('SETUP') ? ['SETUP'] : []).filter((id) => byId.has(id));
  cardIds.sort((a, b) => (byId.get(b).some((r) => FAIL(r.status)) ? 1 : 0) - (byId.get(a).some((r) => FAIL(r.status)) ? 1 : 0));

  const sharedHtml = issues.length
    ? `<div class="note"><b>Found: ${issues.length} issue type(s) across ${themes.length} theme(s)</b><ul>${issues.map((i) => `<li><b>${esc(i.id)}</b> (${esc(i.severity)}): ${esc(i.title)}: <b>${i.themes.length}</b> theme(s): ${i.themes.map((x) => esc(x.theme) + chg(x.change)).join(', ')}</li>`).join('')}</ul></div>`
    : '<div class="note"><b>No failures in this run.</b></div>';

  const head = `<tr><th>Theme</th>${matrixIds.map((id) => `<th title="${esc((meta.get(id) || {}).title)}">${esc(id)}</th>`).join('')}</tr>`;
  const body = themes.map((th) => {
    const cells = matrixIds.map((id) => {
      const rs = rows.filter((r) => r.theme === th && r.id === id);
      if (!rs.length) return '<td class="c m-na">-</td>';
      const f = rs.filter((r) => FAIL(r.status));
      if (f.length) return `<td class="c m-fail" title="${esc(f.map((r) => r.layout).join(', '))}">FAIL${f.some((r) => r.change === 'NEW') ? '*' : ''}</td>`;
      if (rs.some((r) => r.status === 'review')) return '<td class="c m-review">review</td>';
      if (rs.every((r) => r.status === 'na')) return '<td class="c m-na">n/a</td>';
      return '<td class="c m-pass">ok</td>';
    }).join('');
    return `<tr><td>${esc(th)}</td>${cells}</tr>`;
  }).join('');
  const matrix = `<div class="scroll"><table>${head}${body}</table></div><div class="refs">* = new since the previous run.</div>`;

  const cards = cardIds.map((id) => {
    const rs = byId.get(id);
    const m = meta.get(id) || { title: 'Theme could not be set up', severity: 'critical', area: 'Setup', mode: 'auto', steps: 'Install the theme, turn on the two Findter embeds, choose the theme in Theme list.', expected: 'Theme is ready for testing.' };
    const bad = rs.some((r) => FAIL(r.status));
    const status = bad ? 'fail' : rs.some((r) => r.status === 'review') ? 'review' : rs.every((r) => r.status === 'na') ? 'na' : 'pass';
    const lines = rs.slice().sort((a, b) => (FAIL(b.status) ? 1 : 0) - (FAIL(a.status) ? 1 : 0)).map((r) => {
      const shots = (r.shots || []).map((s) => `<figure><a href="${esc(s)}"><img loading="lazy" src="${esc(s)}" alt=""></a><figcaption>${esc(s.split('/').slice(-1)[0])}</figcaption></figure>`).join('');
      const ev = shots ? `<div class="shots">${shots}</div>` : '';
      return `<tr><td>${esc(r.theme)}</td><td>${esc(r.layout)}</td><td>${pill(r.status)}${chg(r.change)}</td><td>${esc(r.detail)}${ev}</td></tr>`;
    }).join('');
    return `<section class="card r-${status}" id="${esc(id)}"><div class="h"><span class="cid">${esc(id)}</span>${pill(status)}<span class="refs">${esc(m.area || '')} | ${esc(m.severity)} | ${esc(m.mode || '')}</span></div><h3>${esc(m.title)}</h3>
<dl class="cols"><div><dt>Steps</dt><dd>${esc(m.steps)}</dd></div><div><dt>Expected</dt><dd>${esc(m.expected)}</dd></div></dl>
<div class="scroll"><table><tr><th>Theme</th><th>Layout</th><th>Result</th><th>Actual</th></tr>${lines}</table></div></section>`;
  }).join('\n');

  const fixedHtml = fixed.length ? `<div class="note"><b>Fixed since the previous run (${fixed.length})</b><ul>${fixed.map((r) => `<li>${esc(r.theme)} / ${esc(r.layout)} / ${esc(r.id)}${chg('FIXED')}</li>`).join('')}</ul></div>` : '';

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Theme check ${esc(run.runId)}</title><style>${CSS}</style></head><body><div class="wrap">
<div><div class="eyebrow">Theme check | Findter</div><h1>Theme compatibility run ${esc(run.runId)}</h1></div>
<dl class="facts"><div><dt>Environment</dt><dd>${esc(run.env)} (${esc(run.shop || '')})</dd></div><div><dt>Run</dt><dd>${esc(require('../lib/time').fmtStamp(run.startedAt))}</dd></div><div><dt>Themes</dt><dd>${themes.length}</dd></div><div><dt>Checklist</dt><dd>${checklist.items.length} items, v${esc(checklist.version)}</dd></div><div><dt>Compared with</dt><dd>${prevRun ? esc(prevRun.runId) : 'no earlier run'}</dd></div></dl>
<div class="totals"><div class="t t-pass"><b>${t.pass}</b>PASS</div><div class="t t-fail"><b>${t.fail + (t.error || 0)}</b>FAIL</div><div class="t t-review"><b>${t.review}</b>REVIEW</div><div class="t t-na"><b>${t.na}</b>N/A</div></div>
<h2 class="sec">Found</h2>${sharedHtml}${fixedHtml}
<h2 class="sec">Theme x checklist</h2>${matrix}
<h2 class="sec">Checklist items, failures first</h2>${cards}
</div></body></html>`;
}

module.exports = { render };
