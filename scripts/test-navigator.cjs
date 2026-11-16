// Unit tests for native/tv-navigator.js: the navigator spoof must mirror the
// header scripts/build.cjs sends per platform, and the Linux string must pass
// WebKitGTK's User-Agent grammar check (RFC 7231 section 5.5.3), which rejects
// the real PS4 string's empty product version and silently keeps WebKit's UA.
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const source = fs.readFileSync(path.join(__dirname, '../native/tv-navigator.js'), 'utf8');
const build = fs.readFileSync(path.join(__dirname, 'build.cjs'), 'utf8');

function spoof(host) {
  const navigator = {};
  class Navigator {}
  const window = { __pakeHost: host };
  vm.runInContext(source, vm.createContext({ window, navigator, Navigator }));
  return navigator;
}

// User-Agent = product *( RWS ( product / comment ) ); product = token ["/" token].
function validUserAgentHeader(value) {
  const token = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
  const product = `${token}(?:/${token})?`;
  const comment = String.raw`\((?:[^()\\]|\\.)*\)`;
  return new RegExp(`^${product}(?:[ \t]+(?:${product}|${comment}))*$`).test(value);
}

const linuxHeader = build.match(/\? '([^']*Sony PS4\/1\.0[^']*)'/)[1];
const otherHeader = build.match(/: '([^']*Sony PS4\/ [^']*)'/)[1];

assert.equal(spoof('linux').userAgent, linuxHeader, 'Linux navigator.userAgent mirrors the Linux header');
for (const host of ['windows', 'macos', undefined]) {
  assert.equal(spoof(host).userAgent, otherHeader, `${host} navigator.userAgent mirrors the header`);
}
assert.ok(validUserAgentHeader(linuxHeader), 'Linux header passes the User-Agent grammar WebKitGTK enforces');
assert.ok(!validUserAgentHeader(otherHeader), 'the real PS4 string fails it (empty PS4/ version), hence the variant');
for (const host of ['linux', 'windows']) {
  const n = spoof(host);
  assert.equal(n.platform, 'PlayStation 4');
  assert.equal(n.appVersion, n.userAgent);
  assert.equal(n.userAgentData, undefined);
  assert.match(n.userAgent, /PS4\/[0-9.]*\s\(PS4/, 'keeps the "PS4/" marker YouTube keys on');
}
console.log('tv-navigator.js: all tests passed');
