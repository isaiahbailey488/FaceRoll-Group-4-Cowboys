const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.join(__dirname, '..');
const read = filename => fs.readFileSync(path.join(root, filename), 'utf8');
const transpile = source => ts.transpileModule(source, { compilerOptions: {
  jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
} }).outputText;
const moduleExports = { exports: {} };
vm.runInNewContext(transpile(read('constants/Colors.ts')), {
  module: moduleExports, exports: moduleExports.exports,
});
const { default: Colors, HomeColors } = moduleExports.exports;

function stylesFor(filename) {
  const source = ts.createSourceFile(filename, read(filename), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'styles') {
      expression = node.initializer.getText(source);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(expression, `Missing styles in ${filename}`);
  return vm.runInNewContext(expression, {
    Colors, HomeColors, StyleSheet: { create: value => value },
    SCREEN_WIDTH: 390, OVAL_WIDTH: 250, OVAL_HEIGHT: 320, BRACKET_SIZE: 28, BRACKET_THICK: 3,
  });
}

function contrast(left, right) {
  function luminance(hex) {
    const channels = hex.slice(1).match(/../g).map(value => {
      const channel = parseInt(value, 16) / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  }
  const a = luminance(left), b = luminance(right);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test('approved Home palette and shared mobile palette stay identical', () => {
  for (const [alias, token, expected] of [
    ['button', 'buttonDark', '#2C5282'], ['green', 'green', '#2E7D42'],
    ['surface', 'surface', '#FCFCFD'], ['background', 'offWhite', '#F6F7F9'],
    ['muted', 'textSecondary', '#52647A'], ['late', 'late', '#946200'],
    ['absent', 'absent', '#B42318'],
  ]) {
    assert.equal(Colors[token], expected);
    assert.equal(HomeColors[alias], Colors[token]);
  }
  assert.equal(Colors.navy, Colors.buttonDark);
  assert.equal(Colors.textLink, Colors.buttonDark);
});

for (const [filename, background, heading, card, button] of [
  ['app/(auth)/login.tsx', 'container', 'formTitle', 'form', 'loginButton'],
  ['app/(auth)/register.tsx', 'container', 'formTitle', 'form', 'registerButton'],
  ['app/(tabs)/profile.tsx', 'safeArea', 'pageTitle', 'section', 'enrollButton'],
  ['app/help.tsx', 'safeArea', 'pageTitle', 'section', 'settingsButton'],
  ['app/join-course.tsx', 'page', 'title', 'card', 'button'],
]) {
  test(`${filename} uses light surfaces, green headings and blue actions`, () => {
    const styles = stylesFor(filename);
    assert.equal(styles[background].backgroundColor, Colors.offWhite);
    assert.equal(styles[heading].color, Colors.green);
    assert.equal(styles[card].backgroundColor, Colors.surface);
    assert.equal(styles[card].borderColor, Colors.divider);
    assert.equal(styles[card].borderRadius, 16);
    assert.equal(styles[button].backgroundColor, Colors.buttonDark);
    const content = styles.scrollContent || styles.content;
    assert.equal(content.maxWidth, 600);
    assert.equal(content.width, '100%');
  });
}

for (const filename of ['app/face-enrollment.tsx', 'app/attendance-checkin.tsx']) {
  test(`${filename} themes permissions without obscuring the camera guide`, () => {
    const styles = stylesFor(filename);
    assert.equal(styles.permissionContainer.backgroundColor, Colors.offWhite);
    assert.equal(styles.permissionTitle.color, Colors.green);
    assert.equal(styles.permissionButton.backgroundColor, Colors.buttonDark);
    assert.equal(styles.permissionButtonText.color, Colors.white);
    assert.equal(styles.container.backgroundColor, Colors.cameraBackground);
    assert.equal(styles.overlay.backgroundColor, 'transparent');
    const guide = stylesFor('components/FaceCaptureGuide.tsx');
    assert.equal(guide.ovalGuide.backgroundColor, 'transparent');
    assert.equal(guide.ovalGuide.borderColor, Colors.cameraGuide);
    assert.equal(styles.captureButton.backgroundColor, Colors.white);
    assert.equal(guide.ovalGuideSuccess.borderColor, Colors.cameraSuccess);
    assert.equal(styles.statusTextError.color, Colors.cameraError);
  });
}

test('scanning tips and privacy gates share the approved palette', () => {
  const tips = stylesFor('components/ScanTipsCard.tsx');
  assert.equal(tips.card.backgroundColor, Colors.surface);
  assert.equal(tips.title.color, Colors.green);
  assert.equal(tips.dismissButton.backgroundColor, Colors.buttonDark);
  const privacy = stylesFor('components/FacePrivacyGate.tsx');
  assert.equal(privacy.container.backgroundColor, Colors.offWhite);
  assert.equal(privacy.title.color, Colors.green);
  assert.equal(privacy.button.backgroundColor, Colors.buttonDark);
});

test('body, status and button text meet 4.5:1 contrast on their surfaces', () => {
  for (const [foreground, background] of [
    [Colors.white, Colors.buttonDark], [Colors.green, Colors.surface],
    [Colors.textSecondary, Colors.surface], [Colors.textSecondary, Colors.offWhite],
    [Colors.present, Colors.presentBackground], [Colors.late, Colors.lateBackground],
    [Colors.absent, Colors.absentBackground], [Colors.cameraSuccess, Colors.cameraBackground],
    [Colors.cameraError, Colors.cameraBackground],
  ]) {
    assert.ok(contrast(foreground, background) >= 4.5, `${foreground} on ${background}`);
  }
});

test('attendance indicators preserve check/L/X symbols and accessible status labels', () => {
  const module = { exports: {} };
  const react = { createElement: (type, props, ...children) => ({ type, props, children }) };
  vm.runInNewContext(transpile(read('components/ActivityItem.tsx')), {
    module, exports: module.exports, require: name => {
      if (name === 'react') return react;
      if (name === 'react-native') return { View: 'View', Text: 'Text', StyleSheet: { create: value => value } };
      if (name === '../constants/Colors') return moduleExports.exports;
      throw new Error(`Unexpected import: ${name}`);
    },
  });
  for (const [status, label, symbol, color] of [
    ['present', 'Present', '\u2713', Colors.present],
    ['late', 'Late', 'L', Colors.late],
    ['absent', 'Absent', '\u2717', Colors.absent],
  ]) {
    const tree = module.exports.default({ courseName: 'Capstone I', date: 'Nov 4, 2026', status });
    assert.equal(tree.props.accessibilityLabel, `Capstone I, Nov 4, 2026, ${label}`);
    const indicator = tree.children[1].children[0];
    assert.equal(indicator.children[0], symbol);
    assert.equal(indicator.props.style[1].color, color);
  }
});

test('native launch backgrounds use the approved off-white surface', () => {
  const { expo } = JSON.parse(read('app.json'));
  assert.equal(expo.android.adaptiveIcon.backgroundColor, Colors.surface);
  const splash = expo.plugins.find(plugin => Array.isArray(plugin) && plugin[0] === 'expo-splash-screen');
  assert.equal(splash[1].backgroundColor, Colors.surface);
});
