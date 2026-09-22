// Native WebView2 document-created script; remains usable when filtering is off.
(() => {
  if (window.__pakeBlockerUi) return;
  window.__pakeBlockerUi = true;
  const installCss = () => {
    if (!document.documentElement) return;
    if (window.__pakeBlockerCss && !document.getElementById('pake-blocker-cosmetics')) {
      const css = document.createElement('style');
      css.id = 'pake-blocker-cosmetics';
      css.textContent = window.__pakeBlockerCss;
      document.documentElement.append(css);
    }
  };
  // Styles apply to future SPA elements too; this observer only waits for a document root.
  if (document.documentElement) installCss();
  else {
    const observer = new MutationObserver(() => { if (document.documentElement) { installCss(); observer.disconnect(); } });
    observer.observe(document, { childList: true });
  }
  if (window !== window.top) return;
  const mount = () => {
    if (document.getElementById('pake-blocker-controls')) return;
    const host = document.createElement('div');
    host.id = 'pake-blocker-controls';
    host.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483645;font:13px system-ui;';
    const root = host.attachShadow({ mode: 'closed' });
    // YouTube enforces Trusted Types: never use innerHTML/HTML parsing here.
    const style = document.createElement('style');
    style.textContent = `
      :host{color-scheme:dark}button{font:inherit;color:#eee;background:#242424;border:1px solid #656565;border-radius:8px;padding:8px 12px;cursor:pointer}
      button:hover{background:#353535}button:disabled{opacity:.5;cursor:wait}
      section{position:absolute;right:0;bottom:46px;width:310px;max-height:65vh;overflow:auto;padding:18px;background:#181818;color:#eee;border:1px solid #555;border-radius:12px;box-shadow:0 8px 30px #0008}
      h2{font-size:16px;margin:0 0 12px}p{line-height:1.5;margin:10px 0}pre{white-space:pre-wrap;word-break:break-word;font:12px/1.5 system-ui;color:#bbb}
      .row{display:flex;gap:8px;flex-wrap:wrap}[hidden]{display:none}
    `;
    root.append(style);
    const add = (parent, tag, text, attributes = {}) => {
      const element = document.createElement(tag);
      if (text) element.textContent = text;
      for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
      parent.append(element);
      return element;
    };
    const section = add(root, 'section', '', { role: 'dialog', 'aria-label': 'Ad blocker', hidden: '' });
    add(section, 'h2', 'YouTube ad blocker');
    add(section, 'p', 'Loading status…', { id: 'state' });
    const row = add(section, 'div', '', { class: 'row' });
    add(row, 'button', 'Toggle blocking', { id: 'toggle' });
    add(row, 'button', 'Update filters', { id: 'update' });
    add(row, 'button', 'Close', { id: 'close' });
    add(section, 'pre', '', { id: 'details' });
    add(section, 'p', '', { id: 'message', role: 'status' });
    add(section, 'p', 'Changing blocking reloads this page. Filter updates apply after restarting the app.');
    add(root, 'button', 'Shield', { id: 'open', 'aria-label': 'Open ad blocker settings' });
    document.documentElement.append(host);
    const panel = root.querySelector('section');
    const statusText = root.getElementById('state');
    const message = root.getElementById('message');
    const toggle = root.getElementById('toggle');
    const details = root.getElementById('details');
    const invoke = (...args) => {
      if (!window.__TAURI__?.core?.invoke) return Promise.reject(new Error('App bridge not ready. Try again.'));
      return window.__TAURI__.core.invoke(...args);
    };
    let current;
    const refresh = async () => {
      try {
        current = await invoke('blocker_status');
        statusText.textContent = current.enabled ? 'Blocking is on' : 'Blocking is off';
        toggle.textContent = current.enabled ? 'Turn off & reload' : 'Turn on & reload';
        details.textContent = [
          'Blocked requests: ' + current.blocked,
          'Resource replacements: ' + current.redirected,
          'Requests checked: ' + current.checked,
          'Early scripts: ' + (current.script_ready ? 'installed' : 'not installed'),
          'Engine: ' + current.engine,
          'WebView2: ' + current.runtime,
          'Filters: ' + current.filters,
          'Bundle: ' + current.fingerprint.slice(0, 12),
          'Last rule ID: ' + (current.last_rule || 'none'),
          current.adapter_error || ''
        ].filter(Boolean).join('\n');
      } catch (error) { message.textContent = String(error); }
    };
    root.getElementById('open').onclick = () => { panel.hidden = !panel.hidden; if (!panel.hidden) refresh(); };
    root.getElementById('close').onclick = () => { panel.hidden = true; };
    toggle.onclick = async () => {
      toggle.disabled = true;
      try {
        if (!current) await refresh();
        if (!current) return;
        const enabled = !current.enabled;
        await invoke('blocker_set_enabled', { enabled });
        localStorage.setItem('pake-adblock-enabled', enabled ? '1' : '0');
        location.reload();
      } catch (error) { message.textContent = String(error); }
      finally { toggle.disabled = false; }
    };
    const update = root.getElementById('update');
    update.onclick = async () => {
      update.disabled = true; message.textContent = 'Downloading and validating filters…';
      try { message.textContent = await invoke('blocker_update'); }
      catch (error) { message.textContent = String(error); }
      finally { update.disabled = false; }
    };
    // The leanback UI is a controller/remote experience: keep the Shield button
    // out of the way until a mouse moves, and always hide it while the panel is
    // closed in fullscreen. Ctrl+Alt+B still opens the panel from the keyboard.
    let mouseIdleTimer;
    let mouseActive = false;
    const visibility = () => {
      const hide = panel.hidden && (document.fullscreenElement || !mouseActive);
      host.style.display = hide ? 'none' : '';
    };
    document.addEventListener('fullscreenchange', visibility);
    window.addEventListener('mousemove', () => {
      mouseActive = true; visibility();
      clearTimeout(mouseIdleTimer);
      mouseIdleTimer = setTimeout(() => { mouseActive = false; visibility(); }, 3000);
    }, { passive: true });
    visibility();
    window.addEventListener('keydown', event => {
      if (event.ctrlKey && event.altKey && !event.shiftKey && event.code === 'KeyB' && !event.repeat) {
        event.preventDefault(); event.stopImmediatePropagation();
        panel.hidden = !panel.hidden; visibility(); if (!panel.hidden) refresh();
      }
    }, true);
    root.getElementById('close').addEventListener('click', visibility);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})();
