// Android-only preferences. Installed before page code, on YouTube origins only.
(() => {
  let background = false;
  const hidden = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden');
  const visibility = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => background ? false : hidden.get.call(document) });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => background ? 'visible' : visibility.get.call(document) });
  document.addEventListener('visibilitychange', e => { if (background) e.stopImmediatePropagation(); }, true);
  window.__yttvPreferences = (fill, keepPlaying) => {
    background = keepPlaying;
    const apply = () => {
      document.documentElement.dataset.yttvFit = fill ? 'fill' : 'fit';
      if (!document.getElementById('yttv-android-fit')) {
        const style = document.createElement('style');
        style.id = 'yttv-android-fit';
        style.textContent = `
          html[data-yttv-fit][data-yttv-fit] body.WEB_PAGE_TYPE_WATCH video.html5-main-video {
            position: fixed !important; left: 0 !important; top: 0 !important;
            width: 100vw !important; height: 100vh !important; transform: none !important;
            object-fit: contain !important;
          }
          html[data-yttv-fit][data-yttv-fit="fill"] body.WEB_PAGE_TYPE_WATCH video.html5-main-video { object-fit: cover !important; }
        `;
        document.documentElement.appendChild(style);
      }
    };
    if (document.documentElement) apply();
    else document.addEventListener('DOMContentLoaded', apply, {once:true});
  };
})();
