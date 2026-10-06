const { execFileSync } = require('node:child_process');
const path = require('node:path');
process.chdir(path.resolve(__dirname, '..'));
if (!['win32', 'darwin'].includes(process.platform)) throw Error('YouTube TV supports Windows and macOS only.');
execFileSync(process.execPath, ['scripts/prepare.cjs'], { stdio: 'inherit' });

// youtube.com/tv only serves the leanback UI to TV/console user agents. The
// same string is mirrored onto navigator.* by native/tv-navigator.js.
const CONSOLE_USER_AGENT =
  'Mozilla/5.0 (PS4; Leanback Shell) Gecko/20100101 Firefox/65.0 LeanbackShell/01.00.01.75 Sony PS4/ (PS4, , no, CH)';

// Pake wants a .ico on Windows and a .icns on macOS (both made from yttv-icon.png).
const icon = process.platform === 'darwin' ? 'assets/youtubetv.icns' : 'assets/youtubetv.ico';

const args = [
  'node_modules/pake-cli/dist/cli.js',
  'https://www.youtube.com/tv',
  '--name', 'YouTubeTV',
  '--identifier', 'com.ltanedo.youtubetv',
  '--icon', icon,
  '--user-agent', CONSOLE_USER_AGENT,
  '--inject', 'inject/yttv.css',
  '--width', '1280', '--height', '720',
  '--fullscreen', '--dark-mode',
  '--app-version', require('../package.json').version,
  '--keep-binary',
  ...process.argv.slice(2),
];
execFileSync(process.execPath, args, { stdio: 'inherit' });
