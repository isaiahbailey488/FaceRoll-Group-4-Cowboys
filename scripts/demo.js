'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const REPOSITORY_ROOT = path.resolve(__dirname, '..');
const FIREBASE_PROJECT_ID = 'rollcall-2669b';
const REQUIRED_PORTS = [4400, 9099, 8080, 5001, 8765, 5055];

function parseEnvironmentFile(contents) {
  return String(contents || '')
    .split(/\r?\n/)
    .reduce(function (values, line) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return values;
      const separator = trimmed.indexOf('=');
      if (separator < 1) return values;
      const key = trimmed.slice(0, separator).trim();
      let value = trimmed.slice(separator + 1).trim();
      if (
        value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'")))
      ) {
        value = value.slice(1, -1);
      }
      values[key] = value;
      return values;
    }, {});
}

function isPrivateLanAddress(address) {
  if (/^10\./.test(address) || /^192\.168\./.test(address)) return true;
  const match = /^172\.(\d+)\./.exec(address);
  return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31);
}

function detectLanAddress(interfaces = os.networkInterfaces()) {
  const candidates = [];
  Object.values(interfaces).forEach(function (addresses) {
    (addresses || []).forEach(function (entry) {
      if (entry && entry.family === 'IPv4' && !entry.internal) candidates.push(entry.address);
    });
  });
  return candidates.find(isPrivateLanAddress) || null;
}

function loadDemoConfiguration(environment = process.env) {
  const filePath = path.join(REPOSITORY_ROOT, '.env.demo');
  const fileValues = fs.existsSync(filePath)
    ? parseEnvironmentFile(fs.readFileSync(filePath, 'utf8'))
    : {};
  const values = { ...fileValues, ...environment };
  const home = os.homedir();
  const localAppData = values.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const windows = process.platform === 'win32';
  const dataRoot = windows
    ? path.join(localAppData, 'FaceRoll')
    : path.join(home, '.local', 'share', 'faceroll');
  const tlsRoot = windows
    ? path.join(localAppData, 'FaceRoll', 'tls')
    : path.join(home, '.local', 'share', 'faceroll-tls');
  const python = values.FACEROLL_PYTHON || (windows
    ? path.join(REPOSITORY_ROOT, 'FaceRoll-System', 'recognition', '.venv', 'Scripts', 'python.exe')
    : path.join(REPOSITORY_ROOT, 'FaceRoll-System', 'recognition', '.venv', 'bin', 'python'));
  const lanAddress = values.FACEROLL_DEMO_HOST || detectLanAddress();

  return {
    lanAddress,
    python,
    tlsCert: values.FACEROLL_TLS_CERT || path.join(tlsRoot, 'faceroll-server.pem'),
    tlsKey: values.FACEROLL_TLS_KEY || path.join(tlsRoot, 'faceroll-server.key'),
    enrollmentDirectory:
      values.FACEROLL_ENROLLMENT_DIR || path.join(dataRoot, 'enrollments'),
    deepfaceHome:
      values.FACEROLL_DEEPFACE_HOME ||
      (windows
        ? path.join(localAppData, 'FaceRoll', 'model-cache')
        : path.join(home, '.local', 'share', 'faceroll-deepface')),
    emulatorDataDirectory:
      values.FACEROLL_EMULATOR_DATA_DIR || path.join(dataRoot, 'firebase-emulator-data'),
  };
}

function executable(name) {
  return process.platform === 'win32' ? `${name}.cmd` : name;
}

function commandResult(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    timeout: 15000,
    ...options,
  });
}

function assertCommand(command, args, label, options) {
  const result = commandResult(command, args, options);
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.stdout || result.error || '').trim();
    throw new Error(`${label} is unavailable.${detail ? `\n${detail}` : ''}`);
  }
}

function certificateSupportsHost(certificatePath, host) {
  const certificate = new crypto.X509Certificate(fs.readFileSync(certificatePath));
  return String(certificate.subjectAltName || '')
    .split(',')
    .map((entry) => entry.trim())
    .includes(`IP Address:${host}`);
}

function isPortOpen(port) {
  return new Promise(function (resolve) {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(400);
    socket.once('connect', function () {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', function () {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', function () {
      resolve(false);
    });
  });
}

async function waitForUrl(url, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  const transport = url.startsWith('https:') ? https : http;
  while (Date.now() < deadline) {
    const available = await new Promise(function (resolve) {
      const request = transport.get(
        url,
        { rejectUnauthorized: false, timeout: 1500 },
        function (response) {
          response.resume();
          resolve(response.statusCode >= 200 && response.statusCode < 500);
        }
      );
      request.once('timeout', function () {
        request.destroy();
        resolve(false);
      });
      request.once('error', function () {
        resolve(false);
      });
    });
    if (available) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function readJson(url) {
  return new Promise(function (resolve, reject) {
    const request = http.get(url, { timeout: 3000 }, function (response) {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', function () {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.once('timeout', function () {
      request.destroy(new Error(`Timed out reading ${url}`));
    });
    request.once('error', reject);
  });
}

async function validateConfiguration(config, checkPorts) {
  if (!config.lanAddress) {
    throw new Error(
      'No private Wi-Fi address was detected. Set FACEROLL_DEMO_HOST in .env.demo.'
    );
  }
  [config.python, config.tlsCert, config.tlsKey].forEach(function (requiredPath) {
    if (!fs.existsSync(requiredPath)) throw new Error(`Required file not found: ${requiredPath}`);
  });
  if (!certificateSupportsHost(config.tlsCert, config.lanAddress)) {
    throw new Error(
      `The TLS certificate does not include ${config.lanAddress}. Regenerate the demo certificate for this Wi-Fi address or set FACEROLL_DEMO_HOST correctly.`
    );
  }

  assertCommand(executable('firebase'), ['--version'], 'Firebase CLI');
  assertCommand(executable('npx'), ['expo', '--version'], 'Expo CLI');
  assertCommand('docker', ['info'], 'Docker');
  assertCommand(
    config.python,
    ['-c', 'import cv2, deepface, firebase_admin, flask, faceroll_recognition'],
    'FaceRoll Python environment',
    { cwd: path.join(REPOSITORY_ROOT, 'FaceRoll-System', 'recognition') }
  );

  if (checkPorts) {
    const occupied = [];
    for (const port of REQUIRED_PORTS) {
      if (await isPortOpen(port)) occupied.push(port);
    }
    if (occupied.length) {
      throw new Error(
        `Demo ports are already in use: ${occupied.join(', ')}. Stop the existing Firebase, bridge, recognition API, and Expo processes, then retry.`
      );
    }
  }
}

function createDemoEnvironment(config) {
  const environment = { ...process.env };
  delete environment.GOOGLE_APPLICATION_CREDENTIALS;
  return {
    ...environment,
    FACEROLL_DEMO_MODE: '1',
    FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
    FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
    GCLOUD_PROJECT: FIREBASE_PROJECT_ID,
    FIREBASE_PROJECT_ID,
    FACEROLL_API_HOST: '0.0.0.0',
    FACEROLL_API_PORT: '5055',
    FACEROLL_TLS_CERT: config.tlsCert,
    FACEROLL_TLS_KEY: config.tlsKey,
    FACEROLL_REQUEST_LOGGING: '1',
    FACEROLL_ENROLLMENT_DIR: config.enrollmentDirectory,
    FACEROLL_DEEPFACE_HOME: config.deepfaceHome,
    DEEPFACE_HOME: config.deepfaceHome,
    EXPO_PUBLIC_RECOGNITION_API_URL: `https://${config.lanAddress}:5055`,
    EXPO_PUBLIC_FIREBASE_EMULATOR_HOST: config.lanAddress,
    EXPO_PUBLIC_FIREBASE_AUTH_EMULATOR_PORT: '9099',
    EXPO_PUBLIC_FIRESTORE_EMULATOR_PORT: '8080',
  };
}

function startChild(children, name, command, args, options) {
  console.log(`\nStarting ${name}...`);
  const child = spawn(command, args, {
    stdio: 'inherit',
    detached: process.platform !== 'win32',
    ...options,
  });
  child.demoName = name;
  children.push(child);
  return child;
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(function (resolve) {
    const timer = setTimeout(resolve, timeoutMs);
    child.once('exit', function () {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    if (child.demoName === 'Firebase emulators') child.kill('SIGINT');
    else process.kill(-child.pid, 'SIGINT');
  } catch {
    return;
  }
  await waitForExit(child, child.demoName === 'Firebase emulators' ? 30000 : 8000);
  if (child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      return;
    }
  }
}

async function runDemo() {
  const checkOnly = process.argv.includes('--check');
  const config = loadDemoConfiguration();
  await validateConfiguration(config, !checkOnly);

  console.log(`FaceRoll demo configuration is valid for ${config.lanAddress}.`);
  if (checkOnly) return;

  const dashboardDirectory = path.join(
    REPOSITORY_ROOT,
    'FaceRoll-System',
    'Instructor-Dashboard'
  );
  const recognitionDirectory = path.join(REPOSITORY_ROOT, 'FaceRoll-System', 'recognition');
  fs.mkdirSync(config.emulatorDataDirectory, { recursive: true, mode: 0o700 });
  fs.mkdirSync(config.enrollmentDirectory, { recursive: true, mode: 0o700 });
  fs.mkdirSync(config.deepfaceHome, { recursive: true, mode: 0o700 });

  const build = commandResult(
    process.execPath,
    ['scripts/generate-runtime-config.js'],
    { cwd: dashboardDirectory, stdio: 'inherit' }
  );
  if (build.status !== 0) throw new Error('Dashboard runtime configuration failed.');

  const environment = createDemoEnvironment(config);
  const children = [];
  let stopping = false;

  async function shutdown(exitCode) {
    if (stopping) return;
    stopping = true;
    console.log('\nStopping FaceRoll demo...');
    if (await isPortOpen(4400)) {
      const exported = commandResult(
        executable('firebase'),
        [
          'emulators:export',
          config.emulatorDataDirectory,
          '--force',
          '--project',
          FIREBASE_PROJECT_ID,
        ],
        { cwd: dashboardDirectory, stdio: 'inherit', timeout: 120000 }
      );
      if (exported.status !== 0) {
        console.warn('Firebase data export did not complete; the emulator will retry during shutdown.');
      }
    }
    for (const child of [...children].reverse()) await stopChild(child);
    console.log('FaceRoll demo stopped. Emulator data was preserved.');
    process.exit(exitCode);
  }

  process.once('SIGINT', () => shutdown(0));
  process.once('SIGTERM', () => shutdown(0));

  try {
    const firebaseArguments = [
      'emulators:start',
      '--project',
      FIREBASE_PROJECT_ID,
      `--export-on-exit=${config.emulatorDataDirectory}`,
    ];
    if (fs.existsSync(path.join(config.emulatorDataDirectory, 'firebase-export-metadata.json'))) {
      firebaseArguments.push(`--import=${config.emulatorDataDirectory}`);
    }
    startChild(children, 'Firebase emulators', executable('firebase'), firebaseArguments, {
      cwd: dashboardDirectory,
      env: environment,
    });
    await waitForUrl('http://127.0.0.1:4400/emulators', 90000);
    const emulatorStatus = await readJson('http://127.0.0.1:4400/emulators');
    const hostingPort = Number(emulatorStatus?.hosting?.port || 5001);

    startChild(
      children,
      'mobile recognition API',
      config.python,
      ['-m', 'faceroll_recognition.mobile_api'],
      { cwd: recognitionDirectory, env: environment }
    );
    await waitForUrl('https://127.0.0.1:5055/health', 180000);

    startChild(
      children,
      'dashboard bridge',
      config.python,
      ['windows/bridge_server.py'],
      { cwd: recognitionDirectory, env: environment }
    );
    await waitForUrl('http://127.0.0.1:8765/health', 30000);

    console.log('\nFaceRoll Demo Ready');
    console.log(`Dashboard:        http://127.0.0.1:${hostingPort}`);
    console.log('Firebase UI:      http://127.0.0.1:4000');
    console.log(`Recognition API:  https://${config.lanAddress}:5055`);
    console.log('Bridge:           http://127.0.0.1:8765');
    console.log('Firebase mode:    local emulators only');
    console.log('\nScan the Expo QR code below. Press Ctrl+C once to stop everything.\n');

    const expo = startChild(
      children,
      'Expo',
      executable('npx'),
      ['expo', 'start', '--lan', '--clear'],
      { cwd: REPOSITORY_ROOT, env: environment }
    );
    expo.once('exit', (code) => {
      if (!stopping) shutdown(code || 0);
    });
  } catch (error) {
    console.error(`\nFaceRoll demo failed: ${error.message}`);
    await shutdown(1);
  }
}

if (require.main === module) {
  runDemo().catch(function (error) {
    console.error(`FaceRoll demo failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  createDemoEnvironment,
  detectLanAddress,
  isPrivateLanAddress,
  loadDemoConfiguration,
  parseEnvironmentFile,
};
