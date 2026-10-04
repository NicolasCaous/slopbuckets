// Stylesheet and script of the `buckets refresh --web` review page, served as /assets/refresh.css and
// /assets/refresh.js. The script sends Approve and Cancel to the server and shows the answer.
export const REFRESH_CSS = String.raw`
html { scroll-padding-bottom: calc(var(--decide-h, 0px) + 16px); }
body.has-decide { padding-bottom: calc(var(--decide-h, 96px) + 8px); }

.callout { font-size: 14px; }

/* the confirmation code the human types in the native window */
.code-box { margin: 18px 0 0; padding: 14px 16px; border: 1px solid var(--amber); background: rgba(0, 0, 0, 0.35); max-width: 80ch; }
.code-line { margin: 0; display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 16px; min-width: 0; }
.code-label { color: var(--dim); font-size: 14px; }
.code { font-size: clamp(28px, 7vw, 40px); font-weight: 800; letter-spacing: 0.2em; color: var(--amber); font-variant-numeric: tabular-nums; user-select: all; overflow-wrap: anywhere; }
.code-help { margin: 8px 0 0; color: var(--dim); font-size: 13.5px; }

/* shown when the project changed after the page loaded; the page itself keeps the old state and code */
.stale-banner { position: sticky; top: calc(var(--bar-h, 0px) + 8px); z-index: 50; max-width: none; background: rgba(28, 20, 4, 0.97); }
.stale-banner[hidden] { display: none; }
.stale-banner p { margin: 0; overflow-wrap: anywhere; }
.stale-banner .result-actions { margin-top: 12px; }

/* +/-/~ rows, in the colors of the terminal diff */
.add { --tone: var(--phos); }
.del { --tone: var(--red); }
.chg { --tone: var(--amber); }

ul.diff { list-style: none; margin: 0; padding: 0; }
ul.diff li {
  display: grid; grid-template-columns: 2ch minmax(14ch, max-content) minmax(0, 1fr); gap: 0 14px; align-items: baseline;
  padding: 8px 0; border-bottom: 1px dashed var(--faint);
}
ul.diff .sign, .dmz-file .sign, ul.symbols .sign { color: var(--tone); font-weight: 800; }
ul.diff .label { color: var(--tone); }
ul.diff code { overflow-wrap: anywhere; justify-self: start; max-width: 100%; }
ul.diff .item { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; min-width: 0; }
ul.diff .item .note { color: var(--dim); font-size: 13px; overflow-wrap: anywhere; min-width: 0; }

/* one group of screens per project when several projects wait for approval */
.project-group { display: block; margin-top: 56px; }
.project-group > .screen { border-left: 3px solid var(--tone, var(--line)); }
.project-group > .screen:first-child { margin-top: 0; }

.project-group h2 { overflow-wrap: anywhere; }
.project-group h2 .dim { color: var(--dim); font-weight: 400; }
.project-decide { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px 20px; margin-top: 16px; padding-top: 14px; border-top: 1px dashed var(--faint); }
.project-decide .btn { flex: none; max-width: 100%; overflow-wrap: anywhere; }
.project-decide .btn[hidden] { display: none; }
.project-msg { margin: 0; flex: 1 1 28ch; min-width: 0; font-size: 14px; }
.project-msg.hint { color: var(--dim); }
.project-msg.warn { color: var(--amber); }
.project-msg.bad { color: var(--red); }
.project-msg.ok { color: var(--phos); }


tr.chg th { color: var(--amber); font-weight: 600; }
td { overflow-wrap: break-word; }

.dmz-list { display: grid; gap: 18px; }
.dmz-file { border: 1px solid var(--faint); border-left: 3px solid var(--tone); background: rgba(0, 0, 0, 0.35); padding: 14px 16px 16px; min-width: 0; }
.dmz-file header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 12px; }
.dmz-file .head { display: flex; align-items: baseline; gap: 12px; min-width: 0; }
.dmz-file .path { font-size: 15px; color: var(--phos-hi); background: none; border: 0; padding: 0; overflow-wrap: anywhere; min-width: 0; }
.dmz-file .badge {
  font-size: 11.5px; font-weight: 800; letter-spacing: 0.06em; text-transform: uppercase;
  padding: 0 6px; background: var(--tone); color: var(--ink); text-shadow: none;
}
.dmz-file.del .badge { color: #1a0402; }
.dmz-file .about { margin: 6px 0 0; color: var(--dim); font-size: 13.5px; }
.dmz-file pre.term { margin-top: 12px; }
.dmz-file details { margin-top: 10px; }
.dmz-file summary { cursor: pointer; color: var(--dim); font-size: 13.5px; width: fit-content; }
.dmz-file summary:hover { color: var(--phos-hi); }
.note-line { margin: 10px 0 0; font-size: 13.5px; }

ul.symbols { list-style: none; margin: 10px 0 0; padding: 0; display: grid; gap: 2px; }
ul.symbols li { display: grid; grid-template-columns: 2ch minmax(0, max-content) minmax(0, 1fr); gap: 0 12px; align-items: baseline; }
ul.symbols code { color: var(--tone); border-color: var(--faint); overflow-wrap: anywhere; justify-self: start; max-width: 100%; }
ul.symbols .note { color: var(--dim); font-size: 13px; }
/* the published symbols of a link, under its row in the link list */
ul.diff ul.symbols { grid-column: 2 / -1; margin-top: 6px; }
ul.diff ul.symbols li { padding: 0; border-bottom: 0; }
ul.diff ul.symbols li code { grid-column: auto; }

/* decision bar: a second tmux line at the bottom of the screen */
.decide {
  position: fixed; left: 0; right: 0; bottom: 0; z-index: 70;
  display: flex; align-items: center; justify-content: space-between; gap: 12px 24px; flex-wrap: wrap;
  padding: 12px max(var(--gutter), calc((100% - 1180px) / 2)) max(12px, env(safe-area-inset-bottom));
  background: rgba(2, 12, 6, 0.96);
  border-top: 1px solid var(--line);
  box-shadow: 0 -10px 40px rgba(0, 0, 0, 0.6);
}
.decide-msg { margin: 0; flex: 1 1 32ch; min-width: 0; font-size: 14px; }
.decide-msg.warn { color: var(--amber); }
.decide-msg.bad { color: var(--red); }
.decide-msg.ok { color: var(--phos); }
.decide-actions { display: flex; gap: 10px; flex: none; }
.decide-actions .btn { min-width: 9.5rem; }
.decide[data-state="done"] .decide-actions { display: none; }
.decide[hidden] { display: none; }
.decide .pulse { display: inline-block; width: 0.62em; height: 1em; vertical-align: -0.12em; margin-right: 8px; background: var(--amber); animation: blink 1s steps(1) infinite; }

.screen.result .screen-bar { background: var(--tone, var(--phos)); }
.screen.result.del .screen-bar { color: #1a0402; }
.screen.result h1 { color: var(--tone, var(--phos-hi)); }
.screen.result h1:focus, .screen.result h1:focus-visible { outline: none; box-shadow: none; }
.result-actions { display: flex; flex-wrap: wrap; gap: 10px; margin: 18px 0 0; }
.result-actions[hidden] { display: none; }

@media (max-width: 640px) {
  ul.diff li { grid-template-columns: 2ch minmax(0, 1fr); }
  ul.diff li code { grid-column: 2; }
  ul.symbols li { grid-template-columns: 2ch minmax(0, 1fr); }
  ul.symbols .note { grid-column: 2; }
  .decide { padding-top: 10px; gap: 10px; }
  .decide-msg { flex-basis: 100%; font-size: 13px; }
  .decide-msg.hint { display: none; }
  table.stack thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  table.stack tr { display: block; padding: 10px 0; border-bottom: 1px dashed var(--faint); }
  table.stack th, table.stack td { display: block; border: 0; padding: 2px 0; }
  table.stack td[data-label]::before { content: attr(data-label) " "; display: inline-block; min-width: 10ch; color: var(--dim); }
  .decide-actions { width: 100%; }
  .decide-actions .btn { flex: 1 1 0; min-width: 0; }
}
`;

export const REFRESH_JS = String.raw`(() => {
  'use strict';
  const api = window.buckets;
  if (!api) return;
  const bar = document.getElementById('decide');
  const approve = document.getElementById('approve');
  const cancel = document.getElementById('cancel') || document.getElementById('cancel-only');
  const message = document.getElementById('decide-msg');
  const status = document.getElementById('server-status');
  const result = document.getElementById('result');
  const hash = bar ? bar.dataset.hash : '';
  const banner = document.getElementById('stale-banner');
  // With several projects, each section has its own Approve button and the bar keeps only Cancel.
  const projectButtons = Array.prototype.slice.call(document.querySelectorAll('.approve-project'));
  let active = null;
  let pending = false;
  let done = false;
  let stale = false;

  function restoreButtons() {
    pending = false;
    if (approve) { approve.disabled = stale; approve.textContent = 'Approve'; }
    projectButtons.forEach((b) => {
      if (b.dataset.done) return;
      b.disabled = stale;
      if (b.dataset.label) b.innerHTML = b.dataset.label;
    });
    active = null;
  }

  // The hash each section rendered, by project. The page never replaces what it shows: when the server reports a
  // different state, the banner asks the human to reload, and the code on the page stays the one it rendered.
  function renderedHashes() {
    const out = {};
    if (approve && bar && bar.dataset.project) out[bar.dataset.project] = hash;
    projectButtons.forEach((b) => { if (!b.dataset.done) out[b.dataset.project] = b.dataset.hash; });
    return out;
  }

  function setStale(value) {
    if (value === stale || done) return;
    stale = value;
    if (banner) banner.hidden = !value;
    if (!pending) restoreButtons();
    if (value) {
      setStatus('wait', 'reload needed');
      api.announce('The project changed after this page loaded. Reload to review the current changes.');
    } else {
      setStatus('live', 'waiting for you');
    }
  }

  const POLL_MS = 5000;
  let polling = false;
  async function poll() {
    if (done || polling || document.visibilityState !== 'visible') return;
    if (!approve && projectButtons.length === 0) return;
    polling = true;
    try {
      const reply = await api.post('/api/state', { projects: renderedHashes() });
      const body = reply.body || {};
      if (body.status === 'waiting' || body.status === 'confirming') setStale(Array.isArray(body.changed) && body.changed.length > 0);
      else if (!pending) handle(reply);
    } catch (e) {
      serverGone();
    } finally {
      polling = false;
    }
  }
  window.setInterval(poll, POLL_MS);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') poll(); });

  function sectionMessage(button, text, tone) {
    const id = button.getAttribute('aria-describedby');
    const el = id ? document.getElementById(id) : null;
    if (!el) { api.announce(text); return; }
    el.className = 'project-msg' + (tone ? ' ' + tone : '');
    el.textContent = text;
  }

  function finishProject(button, text, tone) {
    button.dataset.done = '1';
    button.hidden = true;
    sectionMessage(button, text, tone);
    const left = projectButtons.filter((b) => !b.dataset.done).length;
    restoreButtons();
    setStatus('live', 'waiting for you');
    say(left === 1 ? '1 project waits for your decision.' : left + ' projects wait for your decision.', '');
    const next = projectButtons.find((b) => !b.dataset.done);
    if (next) next.focus();
  }

  if (bar) {
    document.body.classList.add('has-decide');
    const measure = () => document.documentElement.style.setProperty('--decide-h', bar.offsetHeight + 'px');
    if ('ResizeObserver' in window) new ResizeObserver(measure).observe(bar);
    else measure();
  }

  function setStatus(state, label) {
    if (!status) return;
    status.dataset.state = state;
    const text = status.querySelector('.label');
    if (text) text.textContent = label;
  }

  function say(text, tone, waiting) {
    if (!message) { api.announce(text); return; }
    message.className = 'decide-msg' + (tone ? ' ' + tone : '');
    message.textContent = '';
    if (waiting) {
      const pulse = document.createElement('span');
      pulse.className = 'pulse';
      pulse.setAttribute('aria-hidden', 'true');
      message.append(pulse);
    }
    message.append(text);
    api.announce(text);
  }

  function showResult(tone, title, text, options) {
    done = true;
    if (bar) bar.dataset.state = 'done';
    if (approve) approve.disabled = true;
    if (cancel) cancel.disabled = true;
    projectButtons.forEach((b) => { b.disabled = true; });
    const reload = options && options.reload;
    setStatus(reload ? 'wait' : 'off', reload ? 'reload needed' : 'closed');
    if (!result) {
      if (bar) say(text, tone === 'add' ? 'ok' : tone === 'del' ? 'bad' : 'warn');
      return;
    }
    // The result screen at the top replaces the decision bar.
    api.announce(text);
    if (bar) {
      bar.hidden = true;
      document.body.classList.remove('has-decide');
    }
    result.classList.remove('add', 'del', 'chg');
    result.classList.add(tone);
    document.getElementById('result-title').textContent = title;
    document.getElementById('result-text').textContent = text;
    document.getElementById('result-bar').textContent = title.toLowerCase();
    document.getElementById('result-state').textContent = reload ? 'reload needed' : 'closed';
    document.getElementById('result-cmd').textContent = options && options.cmd ? options.cmd : 'echo $?';
    document.getElementById('result-actions').hidden = !reload;
    result.hidden = false;
    window.scrollTo({ top: 0, behavior: api.reduced ? 'auto' : 'smooth' });
    document.getElementById('result-title').focus({ preventScroll: true });
  }

  function serverGone() {
    if (done) return;
    showResult('del', 'Server stopped', 'The command that served this page is no longer running, so nothing more can happen here. If buckets.lock.json still needs approval, ask the agent to run buckets refresh --web again, or run buckets refresh in a terminal.');
  }

  function handle(reply) {
    // A reply that arrives after the page already shows a result, such as the approve request that a
    // Cancel click closed, changes nothing.
    if (done) return;
    const body = reply.body || {};
    switch (body.status) {
      case 'approved':
        showResult('add', 'Approved', body.message || 'buckets.lock.json is written. You can close this tab.', { cmd: 'echo $?  # 0' });
        return;
      case 'rejected':
        showResult('del', 'Not approved', body.message || 'You cancelled in the confirmation window. Nothing was written.', { cmd: 'echo $?  # 1' });
        return;
      case 'cancelled':
        showResult('del', 'Cancelled', body.message || 'Nothing was written. You can close this tab.', { cmd: 'echo $?  # 1' });
        return;
      case 'partial':
        showResult('chg', 'Partly approved', body.message || 'Some projects were approved and the others are unchanged.', { cmd: 'echo $?  # 1' });
        return;
      case 'current':
        showResult('add', 'Nothing to approve', body.message || 'buckets.lock.json already matches the project. You can close this tab.', { cmd: 'echo $?  # 0' });
        return;
      case 'timeout':
        showResult('del', 'Timed out', body.message || 'This review closed without a decision. Nothing was written.', { cmd: 'echo $?  # 1' });
        return;
      case 'wrong-code':
        if (active) sectionMessage(active, body.message || 'The code you typed is not the code on this page. Nothing was written.', 'bad');
        restoreButtons();
        setStatus(stale ? 'wait' : 'live', stale ? 'reload needed' : 'waiting for you');
        say(body.message || 'The code you typed is not the code on this page. Nothing was written. Approve again and type the code exactly as shown.', 'bad');
        return;
      case 'project-approved':
        if (active) finishProject(active, body.message || 'Approved. Its buckets.lock.json is written.', 'ok');
        return;
      case 'project-rejected':
        if (active) finishProject(active, body.message || 'Not approved. Its buckets.lock.json is unchanged.', 'bad');
        return;
      case 'closed':
        showResult('chg', 'Already closed', body.message || 'This review already ended.', {});
        return;
      case 'stale':
        showResult('chg', 'The project changed', body.message || 'The project changed after this page loaded, so this review is out of date. Reload the page to review the current changes.', { reload: true, cmd: 'buckets check' });
        return;
      case 'invalid':
        showResult('chg', 'Rules broken', body.message || 'The project now breaks bucket rules, so there is nothing to approve. Reload the page to see the violations.', { reload: true, cmd: 'buckets check' });
        return;
      case 'busy':
        restoreButtons();
        say(body.message || 'A confirmation window is already open. Answer it first.', 'warn');
        return;
      default:
        restoreButtons();
        setStatus('live', 'waiting for you');
        say(body.message || 'Something went wrong. Try again, or run buckets refresh in a terminal.', 'bad');
    }
  }

  if (approve) {
    approve.addEventListener('click', async () => {
      if (pending || done) return;
      pending = true;
      approve.disabled = true;
      approve.textContent = 'Waiting…';
      setStatus('wait', 'type the code in the window');
      say('Type the confirmation code from this page in the window your operating system opened. It can open behind the browser. Nothing is written until you approve there.', 'warn', true);
      try {
        handle(await api.post('/api/approve', { hash }));
      } catch (e) {
        serverGone();
      }
    });
  }

  projectButtons.forEach((button) => {
    button.dataset.label = button.innerHTML;
    button.addEventListener('click', async () => {
      if (pending || done) return;
      pending = true;
      active = button;
      projectButtons.forEach((b) => { b.disabled = true; });
      button.textContent = 'Waiting…';
      setStatus('wait', 'type the code in the window');
      sectionMessage(button, 'Type the confirmation code from this page in the window your operating system opened. It can open behind the browser. Nothing is written until you approve there.', 'warn');
      say('A confirmation window is open for one project. Answer it before you approve another.', 'warn', true);
      try {
        handle(await api.post('/api/approve', { hash: button.dataset.hash, project: button.dataset.project }));
      } catch (e) {
        serverGone();
      }
    });
  });

  if (cancel) {

    cancel.addEventListener('click', async () => {
      if (done) return;
      cancel.disabled = true;
      try {
        handle(await api.post('/api/cancel', {}));
      } catch (e) {
        serverGone();
      }
    });
  }
})();
`;
