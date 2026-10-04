// The shared browser script, served as /assets/app.js. It runs the CRT toggle (off unless the viewer turned it on,
// remembered in localStorage) and the copy buttons, and
// exposes `window.buckets` for page scripts:
//
//   buckets.post(path, body)   POST JSON with the server token, resolves to { status, body }
//   buckets.events(path, map)  opens a Server-Sent Events stream and calls map[event](data)
//   buckets.announce(text)     reads text out through the shared polite live region
//
// The token comes from <meta name="buckets-token">, which the layout writes into every page.
export const CLIENT_JS = String.raw`(() => {
  'use strict';
  const doc = document.documentElement;
  doc.classList.remove('no-js');
  doc.classList.add('js');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  doc.classList.add(reduced ? 'rm' : 'motion');

  const safe = (fn, fallback) => { try { return fn(); } catch (e) { return fallback; } };
  const local = {
    get: (k) => safe(() => localStorage.getItem(k), null),
    set: (k, v) => safe(() => localStorage.setItem(k, v), undefined),
  };
  const tokenMeta = document.querySelector('meta[name="buckets-token"]');
  const token = tokenMeta ? tokenMeta.getAttribute('content') : '';
  const live = document.getElementById('live-status');

  function announce(text) {
    if (!live) return;
    live.textContent = '';
    window.setTimeout(() => { live.textContent = text; }, 30);
  }

  async function post(path, body) {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-buckets-token': token },
      body: JSON.stringify(body === undefined ? {} : body),
      credentials: 'same-origin',
      cache: 'no-store',
    });
    let data = null;
    try { data = await response.json(); } catch (e) { data = null; }
    return { status: response.status, body: data };
  }

  function events(path, handlers) {
    const source = new EventSource(path);
    for (const name of Object.keys(handlers)) {
      source.addEventListener(name, (event) => {
        let data = null;
        try { data = JSON.parse(event.data); } catch (e) { data = event.data; }
        handlers[name](data);
      });
    }
    return source;
  }

  const crtBtn = document.getElementById('crt-toggle');
  if (crtBtn) {
    const state = crtBtn.querySelector('.crt-state');
    const setCrt = (on, save) => {
      doc.dataset.crt = on ? 'on' : 'off';
      crtBtn.setAttribute('aria-pressed', String(on));
      if (state) state.textContent = on ? 'on' : 'off';
      if (save) local.set('sb-crt', on ? 'on' : 'off');
    };
    // Off unless the viewer turned it on before. Without storage the page stays off.
    setCrt(local.get('sb-crt') === 'on', false);
    crtBtn.addEventListener('click', () => setCrt(doc.dataset.crt !== 'on', true));
  }

  for (const button of document.querySelectorAll('[data-copy]')) {
    let timer;
    const label = button.textContent;
    button.addEventListener('click', async () => {
      const target = document.getElementById(button.dataset.copy);
      if (!target) return;
      let ok = false;
      try { await navigator.clipboard.writeText(target.textContent.trim()); ok = true; } catch (e) { ok = false; }
      button.textContent = ok ? 'Copied' : 'Select it';
      announce(ok ? 'Copied to the clipboard.' : 'Copy failed. Select the text and copy it by hand.');
      window.clearTimeout(timer);
      timer = window.setTimeout(() => { button.textContent = label; }, 2000);
    });
  }

  window.buckets = { post, events, announce, reduced };
})();
`;
