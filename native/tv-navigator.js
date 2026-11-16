// Runs as an initialization script (before any page script).
// youtube.com/tv only serves the leanback UI to TV/console user agents. The
// request header is set natively via --user-agent; this keeps the JS-visible
// navigator surface consistent so client-side platform checks agree with it.
// On Linux (window.__pakeHost, injected before this script) the header is the
// `PS4/1.0` variant that passes WebKitGTK's User-Agent grammar check; see
// scripts/build.cjs. Android injects this script without __pakeHost.
(() => {
  const userAgent =
    window.__pakeHost === "linux"
      ? "Mozilla/5.0 (PS4; Leanback Shell) Gecko/20100101 Firefox/65.0 LeanbackShell/01.00.01.75 Sony PS4/1.0 (PS4, , no, CH)"
      : "Mozilla/5.0 (PS4; Leanback Shell) Gecko/20100101 Firefox/65.0 LeanbackShell/01.00.01.75 Sony PS4/ (PS4, , no, CH)";
  const platform = "PlayStation 4";
  const vendor = "Sony Computer Entertainment Inc.";

  const define = (target, property, value) => {
    try {
      Object.defineProperty(target, property, { get: () => value, configurable: true });
    } catch (_) {}
  };

  for (const target of [Navigator.prototype, navigator]) {
    define(target, "userAgent", userAgent);
    define(target, "appVersion", userAgent);
    define(target, "platform", platform);
    define(target, "vendor", vendor);
    define(target, "userAgentData", undefined);
  }
})();
