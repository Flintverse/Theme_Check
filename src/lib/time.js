// Everything a person reads (dates, times, run ids, logs) is shown in UTC+7. Stored timestamps stay ISO UTC, which is exact;
// only what is displayed, and which day a run belongs to, uses UTC+7.
const OFFSET_MS = 7 * 3600 * 1000;
const pad = (n) => String(n).padStart(2, '0');

// A Date shifted so that its getUTC* parts read as UTC+7 wall-clock time.
const shifted = (d) => new Date((d instanceof Date ? d.getTime() : new Date(d).getTime()) + OFFSET_MS);

function fmtDate(d) { const t = shifted(d); return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`; }
function fmtTime(d) { const t = shifted(d); return `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}`; }
const fmtDateTime = (d) => `${fmtDate(d)} ${fmtTime(d)}`;
const fmtStamp = (d) => fmtDateTime(d) + ' (UTC+7)';
const today = () => fmtDate(new Date());

module.exports = { fmtDate, fmtTime, fmtDateTime, fmtStamp, today, OFFSET_MS };
