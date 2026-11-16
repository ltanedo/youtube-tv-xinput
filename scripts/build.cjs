const { execFileSync } = require('node:child_process');
const path = require('node:path');
process.chdir(path.resolve(__dirname, '..'));
if (!['win32', 'darwin', 'linux'].includes(process.platform)) throw Error('YouTube TV supports Windows, macOS and Linux only.');
execFileSync(process.execPath, ['scripts/prepare.cjs'], { stdio: 'inherit' });

// youtube.com/tv only serves the leanback UI to TV/console user agents. The
// same string is mirrored onto navigator.* by native/tv-navigator.js.
// WebKitGTK validates the header against the RFC 7231 User-Agent grammar and
// silently keeps its default UA otherwise; the real PS4 string's empty product
// version (`PS4/ `) fails that check, so Linux sends `PS4/1.0`, which YouTube
// serves the TV app to as well. Keep both in sync with tv-navigator.js.
const CONSOLE_USER_AGENT =
  process.platform === 'linux'
    ? 'Mozilla/5.0 (PS4; Leanback Shell) Gecko/20100101 Firefox/65.0 LeanbackShell/01.00.01.75 Sony PS4/1.0 (PS4, , no, CH)'
    : 'Mozilla/5.0 (PS4; Leanback Shell) Gecko/20100101 Firefox/65.0 LeanbackShell/01.00.01.75 Sony PS4/ (PS4, , no, CH)';

// Pake wants a .ico on Windows, a .icns on macOS and a 512x512 .png on Linux
// (all made from / equal to yttv-icon.png).
const icon = { darwin: 'assets/youtubetv.icns', win32: 'assets/youtubetv.ico', linux: 'yttv-icon.png' }[process.platform];

// Pake 3.15.7 forces MSI on Windows. MSI accepts only a numeric prerelease
// component, so beta.N is represented as -N in the Windows installer version.
const version = require('../package.json').version;
const appVersion = process.platform === 'win32' ? version.replace(/-beta\.(\d+)$/, '-$1') : version;

const args = [
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
  // Pake lowercases the Linux package name and would title the window "youtubetv".
  ...(process.platform === 'linux' ? ['--title', 'YouTubeTV'] : []),
  // On Linux, `--targets deb,appimage,zst` picks the package formats; the Arch
  // package (zst) is repacked from the .deb (prepare.cjs patches its pkgver).
  ...process.argv.slice(2),
];
execFileSync(process.execPath, args, { stdio: 'inherit' });
