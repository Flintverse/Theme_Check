// Gmail summary mail. The app password comes from the environment (GMAIL_APP_PASSWORD), never from a file.
const fs = require('fs');
const path = require('path');
const { flatten, compare, groupIssues, totals } = require('./report/compare');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function buildMail(run, checklist, prevRun, opts) {
  const { rows, fixed } = compare(flatten(run), prevRun ? flatten(prevRun) : null);
  const t = totals(rows);
  const issues = groupIssues(rows, checklist);
  const newCount = rows.filter((r) => r.change === 'NEW').length;
  const themes = (run.themes || []).length;
  const failingThemes = new Set(rows.filter((r) => r.status === 'fail' || r.status === 'error').map((r) => r.theme)).size;
  const subject = `[Theme check] ${run.env}: ${issues.length} issue type(s) on ${failingThemes}/${themes} themes${newCount ? `, ${newCount} new` : ''} (${run.runId})`;
  const link = opts && opts.reportUrl
    ? `<p><a href="${esc(opts.reportUrl)}">Open the full report with the pictures</a></p>`
    : '<p>The full report is attached (report.html). The pictures are in the run folder on the test machine.</p>';
  const issueRows = issues.map((i) => `<tr style="border-top:1px solid #ddd;vertical-align:top"><td><b>${esc(i.id)}</b><br><small>${esc(i.severity)}</small></td><td>${esc(i.title)}<br><small style="color:#555">${i.themes.length} theme(s): ${i.themes.map((x) => esc(x.theme) + (x.change === 'NEW' ? ' (new)' : '')).join(', ')}</small><br><small style="color:#777">e.g. ${esc(String((i.themes[0] || {}).detail || '').slice(0, 220))}</small></td></tr>`).join('');
  const html = `<div style="font:14px/1.5 system-ui,sans-serif;max-width:760px">
<h2 style="margin:0 0 4px">Theme check: ${esc(run.env)}, ${esc(run.runId)}</h2>
<p style="margin:0 0 12px;color:#555">${themes} themes | ${t.pass} pass, ${t.fail + (t.error || 0)} fail, ${t.review} to review, ${t.na} not testable${prevRun ? ` | compared with ${esc(prevRun.runId)}` : ' | no earlier run to compare with'}</p>
${issues.length ? `<h3>What happened, grouped by cause</h3><table cellpadding="6" style="border-collapse:collapse;border:1px solid #ddd;width:100%">${issueRows}</table>` : '<p><b>No failures this run.</b></p>'}
${fixed.length ? `<h3>Fixed since last run (${fixed.length})</h3><p>${fixed.slice(0, 40).map((r) => esc(r.theme) + ' ' + esc(r.id)).join(', ')}</p>` : ''}
${link}</div>`;
  return { subject, html };
}

async function sendMail(cfg, mail, attachments, dry) {
  if (dry) return { dry: true, to: cfg.to, from: cfg.from, subject: mail.subject, attachments: attachments.map((a) => a.filename) };
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!pass) throw new Error('GMAIL_APP_PASSWORD is not set (a Gmail app password; never put it in a file).');
  const nodemailer = require('nodemailer');
  const tr = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: cfg.from, pass } });
  const info = await tr.sendMail({ from: cfg.from, to: cfg.to.join(', '), subject: mail.subject, html: mail.html, attachments });
  return { sent: true, id: info.messageId };
}

function attachmentsFor(runDir) {
  return ['report.html', 'results.json'].filter((f) => fs.existsSync(path.join(runDir, f))).map((f) => ({ filename: f, path: path.join(runDir, f) }));
}

module.exports = { buildMail, sendMail, attachmentsFor };
