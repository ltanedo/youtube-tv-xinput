const { execFileSync } = require('node:child_process');
const path = require('node:path');
process.chdir(path.resolve(__dirname, '..'));
if (!['win32', 'darwin', 'linux'].includes(process.platform)) throw Error('YouTube TV supports Windows, macOS and Linux only.');
execFileSync(process.execPath, ['scripts/prepare.cjs'], { stdio: 'inherit' });

// youtube.com/tv only serves the leanback UI to TV/console user agents. The
// same string is mirrored onto navigator.* by native/tv-navigator.js.
const CONSOLE_USER_AGENT =
  'Mozilla/5.0 (PS4; Leanback Shell) Gecko/20100101 Firefox/65.0 LeanbackShell/01.00.01.75 Sony PS4/ (PS4, , no, CH)';

// Pake wants a .ico on Windows, a .icns on macOS and a 512x512 .png on Linux
// (all made from / equal to yttv-icon.png).
const icon = { darwin: 'assets/youtubetv.icns', win32: 'assets/youtubetv.ico', linux: 'yttv-icon.png' }[process.platform];

// Pake 3.15.7 forces MSI on Windows. MSI accepts only a numeric prerelease
// component, so beta.N is represented as -N in the Windows installer version.
const version = require('../package.json').version;
const appVersion = process.platform === 'win32' ? version.replace(/-beta\.(\d+)$/, '-$1') : version;

function pake(appVersion, extra) {
  execFileSync(process.execPath, [
    'node_modules/pake-cli/dist/cli.js',
    'https://www.youtube.com/tv',
    '--name', 'YouTubeTV',
    '--identifier', 'com.ltanedo.youtubetv',
    '--icon', icon,
    '--user-agent', CONSOLE_USER_AGENT,
    '--inject', 'inject/yttv.css',
    '--width', '1280', '--height', '720',
    '--dark-mode',
    '--app-version', appVersion,
    '--keep-binary',
    ...extra,
  ], { stdio: 'inherit' });
}

const extra = process.argv.slice(2);
const targetsAt = extra.indexOf('--targets');
if (process.platform === 'linux' && targetsAt !== -1 && (extra[targetsAt + 1] || '').split(',').includes('zst')) {
  // Arch packages: pacman forbids hyphens in pkgver, so beta.N becomes betaN
  // (`2.2.0beta5` still sorts before `2.2.0`). Pake builds the zst from a
  // temporary YouTubeTV.deb that it deletes afterwards, so it must run before
  // the regular targets, whose .deb keeps the real version.
  const targets = extra[targetsAt + 1].split(',').map((t) => t.trim()).filter(Boolean);
  const rest = [...extra.slice(0, targetsAt), ...extra.slice(targetsAt + 2)];
  pake(version.replace(/-beta\.(\d+)$/, 'beta$1'), [...rest, '--targets', 'zst']);
  const regular = targets.filter((t) => t !== 'zst');
  if (regular.length) pake(appVersion, [...rest, '--targets', regular.join(',')]);
} else {
  pake(appVersion, extra);
}
