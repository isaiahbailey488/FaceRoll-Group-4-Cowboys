const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'faceroll-step1-'));
  const python = process.env.FACEROLL_TEST_PYTHON || path.join(root, 'FaceRoll-System', 'recognition', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const result = spawnSync(python, [path.join(__dirname, 'test-tls-fixture.py'), directory], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return { directory, ca: fs.readFileSync(path.join(directory, 'ca.pem')),
    cert: fs.readFileSync(path.join(directory, 'server.pem')), key: fs.readFileSync(path.join(directory, 'server.key')),
    cleanup() {
      const resolved = path.resolve(directory);
      assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
      assert.ok(path.basename(resolved).startsWith('faceroll-step1-'));
      fs.rmSync(resolved, { recursive: true });
    } };
}
module.exports = { fixture };
