// Where the history lives. Default: <repo>/history (git-ignored). Point archive.dir at a clone of a PRIVATE data repo to share it.
const path = require('path');

function archiveRoot(root, cfg) {
  const d = cfg && cfg.archive && cfg.archive.dir;
  return d ? path.resolve(root, d) : path.join(root, 'history');
}
const runsDir = (root, cfg) => path.join(archiveRoot(root, cfg), 'runs');
const dataDir = (root, cfg) => path.join(archiveRoot(root, cfg), 'data');

module.exports = { archiveRoot, runsDir, dataDir };
