// ==UserScript==
// @name         GitHub Follow (daily limit)
// @namespace    local.tampermonkey.github-follow
// @version      1.0.8
// @description  Follow accounts on GitHub followers/following pages, then continue to the next page.
// @match        https://github.com/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @grant        GM_notification
// @noframes
// ==/UserScript==

/*
  Install: Tampermonkey → Create a new script → paste this file → Save.
  Use: open a followers or following page (for example
  https://github.com/orgs/ccxt/followers) and press Start.
  When the Follow buttons on that page are done, it opens Next and continues.
  Defaults: 200 follows per day, random wait of 5–6 minutes between follows.
*/

(function () {
  'use strict';

  if (window.__ghfLoaded) return;
  window.__ghfLoaded = true;

  const DEFAULTS = { dailyMax: 200, delayMinMin: 5, delayMaxMin: 6 };

  const store = {
    get(key, fallback) {
      try {
        if (typeof GM_getValue === 'function') {
          const value = GM_getValue(key, fallback);
          return value === undefined ? fallback : value;
        }
      } catch (err) { /* localStorage fallback */ }
      try {
        const raw = localStorage.getItem('ghf_' + key);
        return raw == null ? fallback : JSON.parse(raw);
      } catch (err) {
        return fallback;
      }
    },
    set(key, value) {
      try {
        if (typeof GM_setValue === 'function') {
          GM_setValue(key, value);
          return;
        }
      } catch (err) { /* localStorage fallback */ }
      try {
        localStorage.setItem('ghf_' + key, JSON.stringify(value));
      } catch (err) { /* storage blocked */ }
    }
  };

  let settings = loadSettings();
  let running = false;
  let abort = null;
  let warnedHidden = false;
  let waitLine = null;
  const doneUsers = new Set();
  const ui = {};

  function clampInt(value, min, max, fallback) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function clampNum(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function loadSettings() {
    const saved = store.get('settings', null);
    const merged = Object.assign({}, DEFAULTS, saved && typeof saved === 'object' ? saved : {});
    return {
      dailyMax: clampInt(merged.dailyMax, 1, 5000, DEFAULTS.dailyMax),
      delayMinMin: clampNum(merged.delayMinMin, 0.1, 180, DEFAULTS.delayMinMin),
      delayMaxMin: clampNum(merged.delayMaxMin, 0.1, 180, DEFAULTS.delayMaxMin)
    };
  }

  function todayKey() {
    const d = new Date();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  }

  function loadDaily() {
    const today = todayKey();
    let daily = store.get('daily', null);
    if (!daily || daily.date !== today) {
      daily = { date: today, follows: 0 };
      store.set('daily', daily);
    }
    daily.follows = clampInt(daily.follows, 0, 100000, 0);
    return daily;
  }

  function myLogin() {
    const meta = document.querySelector('meta[name="user-login"]');
    return ((meta && meta.content) || '').toLowerCase();
  }

  function onListPage() {
    const path = location.pathname;
    return /\/followers\/?$/.test(path)
      || /\/following\/?$/.test(path)
      || /[?&]tab=(followers|following)\b/.test(location.search);
  }

  function targetOf(form) {
    try {
      const url = new URL(form.getAttribute('action') || '', location.origin);
      return url.searchParams.get('target') || '';
    } catch (err) {
      return '';
    }
  }

  function listRoot() {
    return document.querySelector('#repos-user-list-container, .application-main, main, [role="main"]')
      || document.body;
  }

  function isVisible(el) {
    if (!el || !el.isConnected || el.closest('#ghf-panel')) return false;
    if (el.closest('[hidden], [aria-hidden="true"], .d-none, .hidden')) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function buttonText(btn) {
    if (!btn) return '';
    const aria = (btn.getAttribute('aria-label') || '').trim();
    const value = (btn.value || '').trim();
    const text = (btn.textContent || '').replace(/\s+/g, ' ').trim();
    return (text || value || aria).toLowerCase();
  }

  function formState(form, btn) {
    const action = (form.getAttribute('action') || '').toLowerCase();
    const text = buttonText(btn);
    if (/\/users\/unfollow\b/.test(action) || text.indexOf('unfollow') !== -1 || text === 'following') {
      return 'followed';
    }
    if (/\/users\/follow\b/.test(action) && !/\/users\/unfollow\b/.test(action)) {
      if (text.indexOf('unfollow') !== -1) return 'followed';
      return 'follow';
    }
    return '';
  }

  function followFormsOnPage() {
    const root = listRoot();
    return Array.from(root.querySelectorAll('form')).filter(function (form) {
      const action = form.getAttribute('action') || '';
      return /\/users\/(?:follow|unfollow)\b/.test(action);
    });
  }

  function scanPage() {
    const me = myLogin();
    const byName = new Map();
    followFormsOnPage().forEach(function (form) {
      const target = targetOf(form);
      const key = target.toLowerCase();
      if (!key || key === me) return;
      const btn = form.querySelector('button, input[type="submit"]');
      if (!btn || !isVisible(btn)) return;
      const state = formState(form, btn);
      if (!state) return;
      const current = byName.get(key);
      if (!current || state === 'followed') {
        byName.set(key, { target: target, key: key, form: form, btn: btn, state: state });
      }
    });
    return Array.from(byName.values());
  }

  function people() {
    return scanPage().filter(function (person) { return !doneUsers.has(person.key); });
  }

  async function waitForPeople(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (scanPage().length) return true;
      await sleep(400, abort && abort.signal);
    }
    return scanPage().length > 0;
  }

  function followQueue() {
    return people().filter(function (person) { return person.state === 'follow'; });
  }

  function followedOnPage() {
    return scanPage().filter(function (person) { return person.state === 'followed'; });
  }

  function pendingFollowOnPage() {
    return scanPage().filter(function (person) { return person.state === 'follow'; });
  }

  function nextLink() {
    const direct = document.querySelector('a.next_page, a[rel="next"], a[aria-label="Next Page"], a[aria-label="Next"]');
    if (direct && direct.getAttribute('aria-disabled') !== 'true') return direct;

    const nodes = document.querySelectorAll('a[href], button');
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      if (el.closest('#ghf-panel')) continue;
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const label = (el.getAttribute('aria-label') || '').trim().toLowerCase();
      if (text !== 'next' && label !== 'next' && label !== 'next page') continue;
      if (el.getAttribute('aria-disabled') === 'true' || el.classList.contains('disabled')) continue;
      return el;
    }
    return null;
  }

  function openNext(next) {
    const href = next.getAttribute('href');
    if (href) {
      location.assign(new URL(href, location.href).href);
      return;
    }
    next.click();
  }

  function sleep(ms, signal) {
    return new Promise(function (resolve, reject) {
      if (signal && signal.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      const timer = setTimeout(function () {
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      function onAbort() {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      }
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  function randomGap() {
    let minM = Number(settings.delayMinMin);
    let maxM = Number(settings.delayMaxMin);
    if (minM > maxM) {
      const swap = minM;
      minM = maxM;
      maxM = swap;
    }
    const minMs = Math.max(3000, Math.round(minM * 60 * 1000));
    const maxMs = Math.max(minMs, Math.round(maxM * 60 * 1000));
    return minMs + Math.floor(Math.random() * (maxMs - minMs + 1));
  }

  function formatDuration(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    if (minutes <= 0) return seconds + 's';
    return minutes + 'm ' + String(seconds).padStart(2, '0') + 's';
  }

  function formatHours(totalMinutes) {
    const rounded = Math.round(totalMinutes);
    const hours = Math.floor(rounded / 60);
    const minutes = rounded % 60;
    if (hours <= 0) return minutes + 'm';
    return hours + 'h ' + minutes + 'm';
  }

  async function countdown(ms) {
    const signal = abort && abort.signal;
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (!running || (signal && signal.aborted)) {
        throw new DOMException('Aborted', 'AbortError');
      }
      setStatus('Waiting · ' + formatDuration(end - Date.now()));
      await sleep(Math.min(1000, end - Date.now()), signal);
    }
  }

  function log(message) {
    if (!ui.log) return;
    const line = document.createElement('div');
    const now = new Date();
    const stamp = [now.getHours(), now.getMinutes(), now.getSeconds()].map(function (n) {
      return String(n).padStart(2, '0');
    }).join(':');
    line.textContent = stamp + '  ' + message;
    ui.log.appendChild(line);
    return line;
    while (ui.log.childNodes.length > 80) ui.log.removeChild(ui.log.firstChild);
    ui.log.scrollTop = ui.log.scrollHeight;
  }

  function notify(text) {
    try {
      if (typeof GM_notification === 'function') {
        GM_notification({ title: 'GitHub Follow', text: text, timeout: 8000 });
      }
    } catch (err) { /* optional */ }
  }

  function setStatus(text) {
    if (!ui.status) return;
    if (!running && text.indexOf('Waiting') === 0) return;
    ui.status.textContent = text;
  }

  function updatePanel() {
    if (!ui.today) return;
    const daily = loadDaily();
    const left = pendingFollowOnPage().length;
    ui.today.textContent = daily.follows + ' / ' + settings.dailyMax;
    ui.screen.textContent = left + ' to follow · ' + followedOnPage().length + ' already followed on this page'
      + (nextLink() ? ' · next page ready' : ' · no next page');
    const avg = (Number(settings.delayMinMin) + Number(settings.delayMaxMin)) / 2;
    ui.pace.textContent = 'Full day of ' + settings.dailyMax + ' is about ' + formatHours(avg * settings.dailyMax) + '.';
    ui.start.disabled = running;
    ui.stop.disabled = !running;
    ui.reset.disabled = running;
  }

  function readSettings() {
    settings = {
      dailyMax: clampInt(ui.dailyMax.value, 1, 5000, settings.dailyMax),
      delayMinMin: clampNum(ui.delayMin.value, 0.1, 180, settings.delayMinMin),
      delayMaxMin: clampNum(ui.delayMax.value, 0.1, 180, settings.delayMaxMin)
    };
    store.set('settings', settings);
    updatePanel();
  }

  async function followOne(form) {
    const target = targetOf(form);
    const params = new URLSearchParams();
    new FormData(form).forEach(function (value, key) {
      if (typeof value === 'string') params.append(key, value);
    });
    const res = await fetch(form.action, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'Accept': 'text/html'
      },
      body: params.toString()
    });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' for @' + target);
    const btn = form.querySelector('button, input[type="submit"]');
    if (btn) {
      if (btn.type === 'submit') btn.value = 'Unfollow';
      btn.textContent = 'Unfollow';
    }
    doneUsers.add(target.toLowerCase());
    const action = form.getAttribute('action') || '';
    form.setAttribute('action', action.replace('/users/follow', '/users/unfollow'));
    return target;
  }

  async function runLoop() {
    if (!onListPage()) {
      store.set('running', false);
      setStatus('Open a followers or following page');
      log('This page is not a followers or following list.');
      return;
    }

    log('Started. Today ' + loadDaily().follows + '/' + settings.dailyMax
      + '. Gap ' + settings.delayMinMin + '–' + settings.delayMaxMin + ' min.');
    setStatus('Loading page…');
    await waitForPeople(8000);
    setStatus('Starting · 3s');
    await countdown(3000);

    let failures = 0;
    while (!abort.signal.aborted) {
      const daily = loadDaily();
      if (daily.follows >= settings.dailyMax) {
        store.set('running', false);
        setStatus('Daily limit reached');
        log('Daily limit reached. Counts reset after local midnight.');
        notify('Daily limit reached.');
        return;
      }

      updatePanel();
      const skipped = followedOnPage().filter(function (person) { return !doneUsers.has(person.key); });
      skipped.forEach(function (person) { doneUsers.add(person.key); });
      if (skipped.length) {
        log('Skipped ' + skipped.length + ' already followed. No wait.');
        updatePanel();
      }
      if (!followQueue().length) {
        if (pendingFollowOnPage().length) {
          pendingFollowOnPage().forEach(function (person) { doneUsers.delete(person.key); });
          continue;
        }
        if (!scanPage().length) {
          setStatus('Loading user list…');
          const loaded = await waitForPeople(8000);
          if (loaded) continue;
          log('No user buttons found on this page yet.');
        }
        if (followQueue().length || pendingFollowOnPage().length) continue;
        const next = nextLink();
        if (!next) {
          store.set('running', false);
          setStatus('Finished — no next page');
          log('No Follow buttons left and no Next link.');
          notify('Finished this list.');
          return;
        }
        store.set('running', true);
        doneUsers.clear();
        setStatus('Opening the next page…');
        log('This page is done. Opening the next page.');
        openNext(next);
        return;
      }

      const person = followQueue()[0];
      const form = person.form;
      const target = person.target;
      if (formState(form, person.btn) !== 'follow') {
        doneUsers.add(person.key);
        log('Skipped @' + target + ' (already followed). No wait.');
        continue;
      }
      setStatus('Follow @' + target);
      try {
        await followOne(form);
        failures = 0;
        const fresh = loadDaily();
        fresh.follows += 1;
        store.set('daily', fresh);
        log('Followed @' + target + ' (' + fresh.follows + '/' + settings.dailyMax + ')');
        updatePanel();
        if (fresh.follows >= settings.dailyMax) {
          store.set('running', false);
          setStatus('Daily limit reached');
          log('Daily limit reached. Counts reset after local midnight.');
          notify('Daily limit reached.');
          return;
        }
        const gap = randomGap();
        waitLine = log('Next action in ' + formatDuration(gap) + '.');
        await countdown(gap);
        waitLine = null;
      } catch (err) {
        if (err && err.name === 'AbortError') throw err;
        failures += 1;
        doneUsers.add(target.toLowerCase());
        log('Could not follow @' + target + ' (' + ((err && err.message) || err) + ').');
        if (failures >= 3) {
          store.set('running', false);
          setStatus('Stopped — follows were not confirmed');
          log('Stopped after 3 failures. Reload the page and start again.');
          notify('GitHub follow script stopped.');
          return;
        }
        log('Short pause, then the next account.');
        await countdown(30000);
      }
    }
  }

  function startRun() {
    if (running) return;
    readSettings();
    if (loadDaily().follows >= settings.dailyMax) {
      setStatus('Daily limit reached');
      log('Daily limit is already reached. Reset the count or wait until midnight.');
      return;
    }
    running = true;
    warnedHidden = false;
    doneUsers.clear();
    store.set('running', true);
    abort = new AbortController();
    updatePanel();
    runLoop().catch(function (err) {
      if (!err || err.name !== 'AbortError') {
        log('Error: ' + ((err && err.message) || err));
        setStatus('Error');
      }
    }).finally(function () {
      running = false;
      updatePanel();
    });
  }

  function stopRun() {
    running = false;
    if (abort) abort.abort();
    store.set('running', false);
    if (waitLine) {
      waitLine.textContent = waitLine.textContent.replace(/Next action in .*/, 'Wait cancelled.');
      waitLine = null;
    }
    setStatus('Stopped');
    log('Stopped. No follow is scheduled.');
    updatePanel();
  }

  function resetToday() {
    if (running) return;
    store.set('daily', { date: todayKey(), follows: 0 });
    log('Today’s count was reset.');
    setStatus('Idle');
    updatePanel();
  }

  function node(tag, attrs, children) {
    const el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (key) {
      if (key === 'class') el.className = attrs[key];
      else if (key === 'text') el.textContent = attrs[key];
      else el.setAttribute(key, attrs[key]);
    });
    (children || []).forEach(function (child) {
      if (child) el.appendChild(child);
    });
    return el;
  }

  function ensurePanel() {
    if (document.getElementById('ghf-panel') || !document.body) return;

    const panel = node('section', { id: 'ghf-panel' }, [
      node('header', { class: 'ghf-head' }, [
        node('strong', { text: 'GitHub Follow' }),
        node('button', { type: 'button', 'data-ui': 'collapse', 'aria-label': 'Collapse', text: '–' })
      ]),
      node('div', { class: 'ghf-body' }, [
        node('p', { class: 'ghf-status', 'data-ui': 'status', text: 'Idle' }),
        node('p', { class: 'ghf-meta', 'data-ui': 'screen' }),
        node('div', { class: 'ghf-row' }, [
          node('button', { type: 'button', class: 'ghf-go', 'data-ui': 'start', text: 'Start' }),
          node('button', { type: 'button', class: 'ghf-stop', 'data-ui': 'stop', text: 'Stop' })
        ]),
        node('label', { class: 'ghf-field', text: 'Daily max' }, [
          node('input', { type: 'number', min: '1', max: '5000', step: '1', 'data-ui': 'daily' })
        ]),
        node('div', { class: 'ghf-split' }, [
          node('label', { class: 'ghf-field', text: 'Min minutes' }, [
            node('input', { type: 'number', min: '0.1', max: '180', step: '0.1', 'data-ui': 'min' })
          ]),
          node('label', { class: 'ghf-field', text: 'Max minutes' }, [
            node('input', { type: 'number', min: '0.1', max: '180', step: '0.1', 'data-ui': 'max' })
          ])
        ]),
        node('p', { class: 'ghf-meta', text: 'Today ' }, [
          node('b', { 'data-ui': 'today' })
        ]),
        node('p', { class: 'ghf-pace', 'data-ui': 'pace' }),
        node('div', { class: 'ghf-row' }, [
          node('button', { type: 'button', class: 'ghf-quiet', 'data-ui': 'reset', text: 'Reset today’s count' })
        ]),
        node('div', { class: 'ghf-log', 'data-ui': 'log' }),
        node('p', {
          class: 'ghf-hint',
          text: 'Open a followers or following page. When this page is done, it opens Next and keeps going. Leave this tab open.'
        })
      ])
    ]);
    panel.style.cssText = 'position:fixed;bottom:16px;left:16px;z-index:2147483647;width:300px;background:#161b22;color:#e6edf3;border:1px solid #58a6ff;border-radius:12px;font:13px/1.4 sans-serif;';

    document.body.appendChild(panel);
    ui.status = panel.querySelector('[data-ui="status"]');
    ui.screen = panel.querySelector('[data-ui="screen"]');
    ui.start = panel.querySelector('[data-ui="start"]');
    ui.stop = panel.querySelector('[data-ui="stop"]');
    ui.dailyMax = panel.querySelector('[data-ui="daily"]');
    ui.delayMin = panel.querySelector('[data-ui="min"]');
    ui.delayMax = panel.querySelector('[data-ui="max"]');
    ui.today = panel.querySelector('[data-ui="today"]');
    ui.pace = panel.querySelector('[data-ui="pace"]');
    ui.reset = panel.querySelector('[data-ui="reset"]');
    ui.log = panel.querySelector('[data-ui="log"]');

    ui.dailyMax.value = String(settings.dailyMax);
    ui.delayMin.value = String(settings.delayMinMin);
    ui.delayMax.value = String(settings.delayMaxMin);

    ui.stop.disabled = true;
    ui.start.addEventListener('click', startRun);
    ui.stop.addEventListener('click', stopRun);
    ui.reset.addEventListener('click', resetToday);
    panel.querySelector('[data-ui="collapse"]').addEventListener('click', function () {
      panel.classList.toggle('ghf-collapsed');
      this.textContent = panel.classList.contains('ghf-collapsed') ? '+' : '–';
    });
    [ui.dailyMax, ui.delayMin, ui.delayMax].forEach(function (el) {
      el.addEventListener('input', readSettings);
      el.addEventListener('change', readSettings);
    });
    window.addEventListener('keydown', function (event) {
      if (panel.contains(event.target)) event.stopPropagation();
    }, true);

    updatePanel();
    log('Ready. Defaults are ' + settings.dailyMax + ' per day, '
      + settings.delayMinMin + '–' + settings.delayMaxMin + ' min between follows.');
    if (loadDaily().follows >= settings.dailyMax) setStatus('Daily limit reached');
  }

  const css = [
    '#ghf-panel{position:fixed;bottom:16px;left:16px;z-index:2147483647;width:300px;max-width:calc(100vw - 24px);',
    'background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:12px;',
    'box-shadow:0 8px 24px rgba(0,0,0,.45);font:13px/1.4 ui-sans-serif,system-ui,Segoe UI,sans-serif;color-scheme:dark;}',
    '#ghf-panel *{box-sizing:border-box;}',
    '#ghf-panel .ghf-head{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid #30363d;}',
    '#ghf-panel .ghf-head button{background:transparent;color:#8b949e;border:0;font:18px/1 inherit;cursor:pointer;}',
    '#ghf-panel .ghf-body{padding:10px 12px 12px;display:flex;flex-direction:column;gap:8px;}',
    '#ghf-panel.ghf-collapsed .ghf-body{display:none;}',
    '#ghf-panel.ghf-collapsed .ghf-head{border-bottom:0;}',
    '#ghf-panel .ghf-status{margin:0;font-weight:650;}',
    '#ghf-panel .ghf-meta,#ghf-panel .ghf-pace,#ghf-panel .ghf-hint{margin:0;color:#8b949e;font-size:12px;}',
    '#ghf-panel .ghf-meta b{color:#e6edf3;font-weight:650;}',
    '#ghf-panel .ghf-row,#ghf-panel .ghf-split{display:flex;gap:8px;}',
    '#ghf-panel .ghf-split label{flex:1;}',
    '#ghf-panel .ghf-field{display:flex;flex-direction:column;gap:4px;color:#8b949e;font-size:12px;}',
    '#ghf-panel input{width:100%;background:#010409;color:#e6edf3;border:1px solid #30363d;border-radius:8px;padding:6px 8px;font:inherit;}',
    '#ghf-panel .ghf-go,#ghf-panel .ghf-stop,#ghf-panel .ghf-quiet{border:0;border-radius:999px;padding:7px 12px;font:inherit;font-weight:700;cursor:pointer;}',
    '#ghf-panel .ghf-go{background:#e6edf3;color:#0d1117;flex:1;}',
    '#ghf-panel .ghf-stop{background:#da3633;color:#fff;flex:1;}',
    '#ghf-panel .ghf-quiet{background:transparent;color:#2f81f7;border:1px solid #30363d;}',
    '#ghf-panel button:disabled{opacity:.45;cursor:default;}',
    '#ghf-panel .ghf-log{max-height:140px;overflow:auto;background:#010409;border-radius:8px;padding:8px;font:12px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace;color:#c9d1d9;}',
    '#ghf-panel .ghf-log div{white-space:pre-wrap;word-break:break-word;}'
  ].join('');

  if (typeof GM_addStyle === 'function') GM_addStyle(css);
  else {
    const style = document.createElement('style');
    style.textContent = css;
    document.documentElement.appendChild(style);
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden && running && !warnedHidden) {
      warnedHidden = true;
      log('Tab is hidden. Leave it open in the foreground so the 5–6 min gap stays accurate.');
    }
  });

  function boot() {
    try { ensurePanel(); } catch (err) { console.error('[GitHub Follow]', err); }
    if (store.get('running', false) && onListPage() && loadDaily().follows < settings.dailyMax) {
      setTimeout(startRun, 1500);
    }
    setInterval(function () {
      try {
        ensurePanel();
        if (!running) updatePanel();
      } catch (err) { console.error('[GitHub Follow]', err); }
    }, 2000);
  }

  if (document.body) boot();
  else document.addEventListener('DOMContentLoaded', boot);
})();
