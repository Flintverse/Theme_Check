// Writes every page of a run into its folder: report.html (all themes) and report-<theme>.html (one theme each).
const fs = require('fs');
const path = require('path');
const { renderAll } = require('./html');

function writeReports(runDir, run, checklist, prev) {
  fs.mkdirSync(runDir, { recursive: true });
  const pages = renderAll(run, checklist, prev);
  const keep = new Set(pages.map((p) => p.file));
  pages.forEach(({ file, html }) => { // temporary name first, so a reader never sees half a file
    const f = path.join(runDir, file);
    fs.writeFileSync(f + '.tmp', html);
    fs.renameSync(f + '.tmp', f);
  });
  fs.readdirSync(runDir).filter((n) => /^report-.*\.html$/.test(n) && !keep.has(n)).forEach((n) => fs.unlinkSync(path.join(runDir, n)));
  return pages.map((p) => path.join(runDir, p.file));
}

module.exports = { writeReports };
