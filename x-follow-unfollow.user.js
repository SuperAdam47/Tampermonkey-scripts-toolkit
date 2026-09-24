// ==UserScript==
// @name         X Follow / Unfollow (daily limit)
// @namespace    local.tampermonkey.x-follow
// @version      1.0.0
// @description  Follow or unfollow accounts on X with a daily cap and a random delay between each action.
// @match        https://x.com/*
// @match        https://twitter.com/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @grant        GM_notification
// @noframes
// ==/UserScript==

/*
  Install
  -------
  Tampermonkey → Create a new script → replace the template with this file → Save.

  Use
  ---
  1. Stay logged in on X.
  2. Follow mode: open someone’s Followers page, or a People search.
  3. Unfollow mode: open your own Following page.
  4. Press Start. The first click is after a few seconds, then each
     successful action waits a random time between the min and max you set.

  Defaults: 200 actions per day (follows and unfollows share one cap),
  random gap of 5–6 minutes. Counters reset at local midnight.
*/

(function () {
  'use strict';

  if (window.__xfuLoaded) return;
  window.__xfuLoaded = true;

  const DEFAULTS = {
    mode: 'follow',
    dailyMax: 200,
    delayMinMin: 5,
    delayMaxMin: 6,
    nonFollowersOnly: true,
    followsYouLabel: 'Follows you',
    whitelist: ''
  };

  const RESERVED = new Set([
    'home', 'explore', 'search', 'notifications', 'messages', 'settings',
    'i', 'compose', 'intent', 'jobs', 'premium', 'tos', 'privacy',
    'login', 'signup', 'logout', 'share', 'hashtag'
  ]);

  const store = {
    get(key, fallback) {
      try {
        if (typeof GM_getValue === 'function') {
          const value = GM_getValue(key, fallback);
          return value === undefined ? fallback : value;
        }
      } catch (err) {
        /* use localStorage */
      }
      try {
        const raw = localStorage.getItem('xfu_' + key);
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
      } catch (err) {
        /* use localStorage */
      }
      try {
        localStorage.setItem('xfu_' + key, JSON.stringify(value));
      } catch (err) {
        /* storage full or blocked */
      }
    }
  };

  let settings = loadSettings();
  let running = false;
  let abort = null;
  let statusText = 'Idle';
  let statusTone = 'idle';
  let warnedHidden = false;
  const done = new Set();
  const observed = new Set();
  const ui = {};

  function loadSettings() {
    const saved = store.get('settings', null);
    const merged = Object.assign({}, DEFAULTS, saved && typeof saved === 'object' ? saved : {});
    merged.mode = merged.mode === 'unfollow' ? 'unfollow' : 'follow';
    merged.dailyMax = clampInt(merged.dailyMax, 1, 5000, DEFAULTS.dailyMax);
    merged.delayMinMin = clampNum(merged.delayMinMin, 0.1, 180, DEFAULTS.delayMinMin);
    merged.delayMaxMin = clampNum(merged.delayMaxMin, 0.1, 180, DEFAULTS.delayMaxMin);
    merged.nonFollowersOnly = Boolean(merged.nonFollowersOnly);
    merged.followsYouLabel = String(merged.followsYouLabel || DEFAULTS.followsYouLabel);
    merged.whitelist = String(merged.whitelist || '');
    return merged;
  }

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
      daily = { date: today, follows: 0, unfollows: 0 };
      store.set('daily', daily);
    }
    daily.follows = clampInt(daily.follows, 0, 100000, 0);
    daily.unfollows = clampInt(daily.unfollows, 0, 100000, 0);
    return daily;
  }

  function used(daily) {
    return daily.follows + daily.unfollows;
  }

  function whitelistSet() {
    const parts = settings.whitelist.split(/[\s,]+/);
    const set = new Set();
    parts.forEach(function (part) {
      const name = part.replace(/^@+/, '').trim().toLowerCase();
      if (name) set.add(name);
    });
    return set;
  }

  function mainColumn() {
    return document.querySelector('[data-testid="primaryColumn"]')
      || document.querySelector('main[role="main"]')
      || document.querySelector('main');
  }

  function handleFrom(root) {
    const links = root.querySelectorAll('a[href]');
    for (let i = 0; i < links.length; i++) {
      const href = links[i].getAttribute('href') || '';
      const match = href.match(/^\/([A-Za-z0-9_]{1,15})$/);
      if (match && !RESERVED.has(match[1].toLowerCase())) return match[1];
    }
    return null;
  }

  function buttonKind(btn) {
    const id = btn.getAttribute('data-testid') || '';
    if (id === 'unfollow' || id.endsWith('-unfollow')) return 'following';
    if (id === 'follow' || id.endsWith('-follow')) return 'follow';
    const label = btn.getAttribute('aria-label') || '';
    if (/^following\b/i.test(label)) return 'following';
    if (/^follow\b/i.test(label)) return 'follow';
    return null;
  }

  function isPending(btn) {
    const label = (btn.getAttribute('aria-label') || '') + ' ' + (btn.innerText || '');
    return /pending/i.test(label);
  }

  function actionButton(root) {
    const buttons = root.querySelectorAll('button[data-testid], [role="button"][data-testid]');
    for (let i = 0; i < buttons.length; i++) {
      if (buttonKind(buttons[i])) return buttons[i];
    }
    return null;
  }

  function followsYou(root) {
    if (root.querySelector('[data-testid="userFollowIndicator"]')) return true;
    const label = (settings.followsYouLabel || '').trim().toLowerCase();
    if (!label) return false;
    return (root.innerText || '').toLowerCase().includes(label);
  }

  function readCell(cell) {
    const handle = handleFrom(cell);
    const button = actionButton(cell);
    if (!handle || !button) return null;
    return {
      handle: handle,
      kind: buttonKind(button),
      pending: isPending(button),
      followsYou: followsYou(cell),
      button: button,
      root: cell
    };
  }

  function readHeader(column) {
    const parts = location.pathname.split('/').filter(Boolean);
    if (parts.length !== 1 || RESERVED.has(parts[0].toLowerCase())) return null;
    const buttons = column.querySelectorAll('button[data-testid], [role="button"][data-testid]');
    for (let i = 0; i < buttons.length; i++) {
      const btn = buttons[i];
      if (btn.closest('[data-testid="UserCell"]')) continue;
      if (!buttonKind(btn)) continue;
      return {
        handle: parts[0],
        kind: buttonKind(btn),
        pending: isPending(btn),
        followsYou: followsYou(column),
        button: btn,
        root: column
      };
    }
    return null;
  }

  function listAccounts() {
    const column = mainColumn();
    const found = [];
    if (!column) return found;
    const cells = column.querySelectorAll('[data-testid="UserCell"]');
    for (let i = 0; i < cells.length; i++) {
      const acc = readCell(cells[i]);
      if (acc) found.push(acc);
    }
    const header = readHeader(column);
    if (header && !found.some(function (acc) {
      return acc.handle.toLowerCase() === header.handle.toLowerCase();
    })) {
      found.unshift(header);
    }
    return found;
  }

  function findAccount(handle) {
    const key = handle.toLowerCase();
    const accounts = listAccounts();
    for (let i = 0; i < accounts.length; i++) {
      if (accounts[i].handle.toLowerCase() === key) return accounts[i];
    }
    return null;
  }

  function classify(acc) {
    if (!acc || !acc.kind) return 'skip-state';
    if (acc.pending) return 'skip-pending';
    if (settings.mode === 'follow') {
      return acc.kind === 'follow' ? 'ready' : 'skip-state';
    }
    if (whitelistSet().has(acc.handle.toLowerCase())) return 'skip-whitelist';
    if (acc.kind !== 'following') return 'skip-state';
    if (settings.nonFollowersOnly && acc.followsYou) return 'skip-follows';
    return 'ready';
  }

  function screenCounts() {
    let onScreen = 0;
    let ready = 0;
    const seen = new Set();
    listAccounts().forEach(function (acc) {
      const key = acc.handle.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      onScreen += 1;
      if (!done.has(key) && classify(acc) === 'ready') ready += 1;
    });
    return { onScreen: onScreen, ready: ready };
  }

  function takeNext() {
    const seen = new Set();
    const accounts = listAccounts();
    for (let i = 0; i < accounts.length; i++) {
      const acc = accounts[i];
      const key = acc.handle.toLowerCase();
      if (seen.has(key) || done.has(key)) continue;
      seen.add(key);
      if (classify(acc) === 'ready') return acc.handle;
    }
    return null;
  }

  function noteObserved() {
    listAccounts().forEach(function (acc) {
      observed.add(acc.handle.toLowerCase());
    });
  }

  function findScroller() {
    let el = mainColumn();
    while (el && el !== document.body && el !== document.documentElement) {
      const style = getComputedStyle(el);
      const overflow = style.overflowY;
      if ((overflow === 'auto' || overflow === 'scroll') && el.scrollHeight > el.clientHeight + 80) {
        return el;
      }
      el = el.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  function scrollMore() {
    const scroller = findScroller();
    const delta = Math.max(500, (scroller.clientHeight || window.innerHeight) * 0.8);
    scroller.scrollTop += delta;
  }

  function press(el) {
    el.click();
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

  async function countdown(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const left = end - Date.now();
      setStatus('Waiting · ' + formatDuration(left), 'wait');
      await sleep(Math.min(1000, left), abort.signal);
    }
  }

  function randomGap() {
    let minM = Number(settings.delayMinMin);
    let maxM = Number(settings.delayMaxMin);
    if (minM > maxM) {
      const swap = minM;
      minM = maxM;
      maxM = swap;
    }
    let minMs = Math.round(minM * 60 * 1000);
    let maxMs = Math.round(maxM * 60 * 1000);
    const floor = 3000;
    minMs = Math.max(floor, minMs);
    maxMs = Math.max(floor, maxMs);
    if (minMs > maxMs) maxMs = minMs;
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

  function paceText() {
    let minM = Number(settings.delayMinMin);
    let maxM = Number(settings.delayMaxMin);
    if (minM > maxM) {
      const swap = minM;
      minM = maxM;
      maxM = swap;
    }
    const avg = (minM + maxM) / 2;
    return 'Full day of ' + settings.dailyMax + ' is about ' + formatHours(avg * settings.dailyMax) + ' at this pace.';
  }

  function rateLimited() {
    const toast = document.querySelector('[data-testid="toast"]');
    if (!toast) return false;
    return /rate limit|over the limit|try again later|temporarily limited/i.test(toast.innerText || '');
  }

  function blockingDialog() {
    const dialogs = document.querySelectorAll('[role="dialog"], [data-testid="sheetDialog"], [aria-modal="true"]');
    for (let i = 0; i < dialogs.length; i++) {
      if (dialogs[i].querySelector('[data-testid="confirmationSheetConfirm"]')) continue;
      if (dialogs[i].querySelector('[data-testid="confirmationSheetCancel"]')) continue;
      const text = dialogs[i].innerText || '';
      if (/unfollow @/i.test(text)) continue;
      return true;
    }
    return false;
  }

  function closeConfirm() {
    const cancel = document.querySelector('[data-testid="confirmationSheetCancel"]');
    if (cancel) cancel.click();
  }

  async function waitForSelector(selector, timeout) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const el = document.querySelector(selector);
      if (el) return el;
      await sleep(200, abort.signal);
    }
    return null;
  }

  async function waitForOutcome(handle, timeout) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const acc = findAccount(handle);
      if (acc) {
        if (settings.mode === 'follow' && (acc.kind === 'following' || acc.pending)) return true;
        if (settings.mode === 'unfollow' && acc.kind === 'follow') return true;
      }
      await sleep(300, abort.signal);
    }
    return false;
  }

  async function perform(handle) {
    closeConfirm();
    let acc = findAccount(handle);
    if (!acc || !acc.button.isConnected) return 'fail';
    acc.root.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
    await sleep(800, abort.signal);
    acc = findAccount(handle);
    if (!acc || !acc.button.isConnected || classify(acc) !== 'ready') return 'fail';
    press(acc.button);
    if (settings.mode === 'unfollow') {
      const confirmBtn = await waitForSelector('[data-testid="confirmationSheetConfirm"]', 5000);
      if (confirmBtn) press(confirmBtn);
    }
    if (rateLimited()) return 'rate-limit';
    const ok = await waitForOutcome(handle, 8000);
    if (rateLimited()) return 'rate-limit';
    return ok ? 'ok' : 'fail';
  }

  function log(message) {
    const line = document.createElement('div');
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    line.textContent = hh + ':' + mm + ':' + ss + '  ' + message;
    if (!ui.log) return;
    ui.log.appendChild(line);
    while (ui.log.childNodes.length > 80) ui.log.removeChild(ui.log.firstChild);
    ui.log.scrollTop = ui.log.scrollHeight;
  }

  function notify(text) {
    try {
      if (typeof GM_notification === 'function') {
        GM_notification({ title: 'X Follow / Unfollow', text: text, timeout: 8000 });
      }
    } catch (err) {
      /* notifications are optional */
    }
  }

  function setStatus(text, tone) {
    statusText = text;
    statusTone = tone || 'idle';
    if (ui.status) {
      ui.status.textContent = statusText;
      ui.dot.className = 'xfu-dot xfu-dot-' + statusTone;
    }
  }

  function updatePanel() {
    if (!ui.panel) return;
    const daily = loadDaily();
    const counts = screenCounts();
    ui.status.textContent = statusText;
    ui.dot.className = 'xfu-dot xfu-dot-' + statusTone;
    ui.today.textContent = used(daily) + ' / ' + settings.dailyMax;
    ui.follows.textContent = String(daily.follows);
    ui.unfollows.textContent = String(daily.unfollows);
    ui.screen.textContent = counts.onScreen + ' on screen · ' + counts.ready + ' ready';
    ui.pace.textContent = paceText();
    ui.start.disabled = running;
    ui.stop.disabled = !running;
    ui.reset.disabled = running;
    ui.modeFollow.disabled = running;
    ui.modeUnfollow.disabled = running;
  }

  function readSettingsFromUI() {
    settings = {
      mode: ui.modeUnfollow.checked ? 'unfollow' : 'follow',
      dailyMax: clampInt(ui.dailyMax.value, 1, 5000, settings.dailyMax),
      delayMinMin: clampNum(ui.delayMin.value, 0.1, 180, settings.delayMinMin),
      delayMaxMin: clampNum(ui.delayMax.value, 0.1, 180, settings.delayMaxMin),
      nonFollowersOnly: ui.nonFollowers.checked,
      followsYouLabel: (ui.followsLabel.value || '').trim() || DEFAULTS.followsYouLabel,
      whitelist: ui.whitelist.value
    };
    store.set('settings', settings);
    updatePanel();
  }

  function fillUI() {
    ui.modeFollow.checked = settings.mode !== 'unfollow';
    ui.modeUnfollow.checked = settings.mode === 'unfollow';
    ui.dailyMax.value = String(settings.dailyMax);
    ui.delayMin.value = String(settings.delayMinMin);
    ui.delayMax.value = String(settings.delayMaxMin);
    ui.nonFollowers.checked = settings.nonFollowersOnly;
    ui.followsLabel.value = settings.followsYouLabel;
    ui.whitelist.value = settings.whitelist;
  }

  async function runLoop() {
    let stagnant = 0;
    let failures = 0;
    log('Started ' + settings.mode + '. Today ' + used(loadDaily()) + '/' + settings.dailyMax + '. Gap ' + settings.delayMinMin + '–' + settings.delayMaxMin + ' min.');
    setStatus('Starting · 3s', 'run');
    await countdown(3000);

    while (!abort.signal.aborted) {
      const daily = loadDaily();
      if (used(daily) >= settings.dailyMax) {
        setStatus('Daily limit reached', 'stop');
        log('Daily limit reached. Counts reset after local midnight.');
        notify('Daily limit reached.');
        return;
      }
      if (blockingDialog()) {
        setStatus('Close the dialog on X, then it will continue', 'wait');
        await sleep(1000, abort.signal);
        continue;
      }

      const handle = takeNext();
      if (!handle) {
        noteObserved();
        const before = observed.size;
        scrollMore();
        setStatus('Loading more accounts…', 'run');
        await sleep(2500, abort.signal);
        noteObserved();
        if (observed.size === before) {
          stagnant += 1;
          if (stagnant >= 4) {
            setStatus('No more accounts on this page', 'stop');
            log('Stopped. Scroll did not reveal new accounts. Open a followers, following, or people-search page.');
            notify('No more accounts on this page.');
            return;
          }
        } else {
          stagnant = 0;
        }
        continue;
      }

      stagnant = 0;
      setStatus((settings.mode === 'follow' ? 'Follow ' : 'Unfollow ') + '@' + handle, 'run');
      const result = await perform(handle);
      done.add(handle.toLowerCase());

      if (result === 'rate-limit') {
        setStatus('X rate limit — stopped', 'bad');
        log('Stopped because X showed a rate-limit message. Try again later.');
        notify('X rate limit. Script stopped.');
        return;
      }

      if (result === 'ok') {
        failures = 0;
        const fresh = loadDaily();
        if (settings.mode === 'follow') fresh.follows += 1;
        else fresh.unfollows += 1;
        store.set('daily', fresh);
        const verb = settings.mode === 'follow' ? 'Followed' : 'Unfollowed';
        log(verb + ' @' + handle + ' (' + used(fresh) + '/' + settings.dailyMax + ')');
        updatePanel();
        if (used(fresh) >= settings.dailyMax) {
          setStatus('Daily limit reached', 'stop');
          log('Daily limit reached. Counts reset after local midnight.');
          notify('Daily limit reached.');
          return;
        }
        const gap = randomGap();
        log('Next action in ' + formatDuration(gap) + '.');
        await countdown(gap);
      } else {
        failures += 1;
        log('Could not confirm @' + handle + '. Skipped.');
        if (failures >= 3) {
          setStatus('Stopped — clicks were not confirmed', 'bad');
          log('Stopped after 3 unconfirmed actions. Reload the list page and start again.');
          notify('Script stopped: actions were not confirmed.');
          return;
        }
        log('Short pause, then the next account.');
        await countdown(30000);
      }
    }
  }

  function startRun() {
    if (running) return;
    readSettingsFromUI();
    const daily = loadDaily();
    if (used(daily) >= settings.dailyMax) {
      setStatus('Daily limit reached', 'stop');
      log('Daily limit is already reached. Reset the count or wait until midnight.');
      return;
    }
    running = true;
    warnedHidden = false;
    abort = new AbortController();
    updatePanel();
    runLoop().catch(function (err) {
      if (!err || err.name !== 'AbortError') {
        log('Error: ' + (err && err.message ? err.message : err));
        setStatus('Error', 'bad');
      }
    }).finally(function () {
      running = false;
      updatePanel();
    });
  }

  function stopRun() {
    if (abort) abort.abort();
    running = false;
    closeConfirm();
    setStatus('Stopped', 'stop');
    log('Stopped.');
    updatePanel();
  }

  function resetToday() {
    if (running) return;
    store.set('daily', { date: todayKey(), follows: 0, unfollows: 0 });
    done.clear();
    log('Today’s counts were reset.');
    setStatus('Idle', 'idle');
    updatePanel();
  }

  function ensurePanel() {
    if (document.getElementById('xfu-panel')) return;
    if (!document.body) return;

    const panel = document.createElement('section');
    panel.id = 'xfu-panel';
    panel.innerHTML = [
      '<header class="xfu-head">',
      '  <span class="xfu-dot xfu-dot-idle" data-ui="dot"></span>',
      '  <strong>X Follow / Unfollow</strong>',
      '  <button type="button" class="xfu-icon" data-ui="collapse" aria-label="Collapse">–</button>',
      '</header>',
      '<div class="xfu-body">',
      '  <p class="xfu-status" data-ui="status">Idle</p>',
      '  <p class="xfu-meta" data-ui="screen">0 on screen · 0 ready</p>',
      '  <div class="xfu-row">',
      '    <button type="button" class="xfu-go" data-ui="start">Start</button>',
      '    <button type="button" class="xfu-stop" data-ui="stop" disabled>Stop</button>',
      '  </div>',
      '  <div class="xfu-modes">',
      '    <label><input type="radio" name="xfu-mode" value="follow" data-ui="mode-follow"> Follow</label>',
      '    <label><input type="radio" name="xfu-mode" value="unfollow" data-ui="mode-unfollow"> Unfollow</label>',
      '  </div>',
      '  <label class="xfu-check"><input type="checkbox" data-ui="non-followers"> Unfollow only if they do not follow you</label>',
      '  <label class="xfu-field">Daily max <input type="number" min="1" max="5000" step="1" data-ui="daily"></label>',
      '  <div class="xfu-split">',
      '    <label class="xfu-field">Min minutes <input type="number" min="0.1" max="180" step="0.1" data-ui="min"></label>',
      '    <label class="xfu-field">Max minutes <input type="number" min="0.1" max="180" step="0.1" data-ui="max"></label>',
      '  </div>',
      '  <p class="xfu-meta">Today <b data-ui="today">0 / 200</b> · Follows <b data-ui="follows">0</b> · Unfollows <b data-ui="unfollows">0</b></p>',
      '  <p class="xfu-pace" data-ui="pace"></p>',
      '  <label class="xfu-field">“Follows you” label <input type="text" data-ui="follows-label" spellcheck="false"></label>',
      '  <label class="xfu-field">Whitelist, never unfollow <textarea rows="3" data-ui="whitelist" spellcheck="false" placeholder="@name, one per line"></textarea></label>',
      '  <div class="xfu-row">',
      '    <button type="button" class="xfu-quiet" data-ui="reset">Reset today’s count</button>',
      '  </div>',
      '  <div class="xfu-log" data-ui="log"></div>',
      '  <p class="xfu-hint">Open a followers, following, or people-search page. Leave this tab open. Follows and unfollows share the daily max, which resets at local midnight.</p>',
      '</div>'
    ].join('');

    document.body.appendChild(panel);
    ui.panel = panel;
    ui.dot = panel.querySelector('[data-ui="dot"]');
    ui.status = panel.querySelector('[data-ui="status"]');
    ui.screen = panel.querySelector('[data-ui="screen"]');
    ui.start = panel.querySelector('[data-ui="start"]');
    ui.stop = panel.querySelector('[data-ui="stop"]');
    ui.modeFollow = panel.querySelector('[data-ui="mode-follow"]');
    ui.modeUnfollow = panel.querySelector('[data-ui="mode-unfollow"]');
    ui.nonFollowers = panel.querySelector('[data-ui="non-followers"]');
    ui.dailyMax = panel.querySelector('[data-ui="daily"]');
    ui.delayMin = panel.querySelector('[data-ui="min"]');
    ui.delayMax = panel.querySelector('[data-ui="max"]');
    ui.today = panel.querySelector('[data-ui="today"]');
    ui.follows = panel.querySelector('[data-ui="follows"]');
    ui.unfollows = panel.querySelector('[data-ui="unfollows"]');
    ui.pace = panel.querySelector('[data-ui="pace"]');
    ui.followsLabel = panel.querySelector('[data-ui="follows-label"]');
    ui.whitelist = panel.querySelector('[data-ui="whitelist"]');
    ui.reset = panel.querySelector('[data-ui="reset"]');
    ui.log = panel.querySelector('[data-ui="log"]');

    fillUI();
    updatePanel();

    ui.start.addEventListener('click', startRun);
    ui.stop.addEventListener('click', stopRun);
    ui.reset.addEventListener('click', resetToday);
    panel.querySelector('[data-ui="collapse"]').addEventListener('click', function () {
      panel.classList.toggle('xfu-collapsed');
      this.textContent = panel.classList.contains('xfu-collapsed') ? '+' : '–';
    });

    const save = function () { readSettingsFromUI(); };
    [ui.modeFollow, ui.modeUnfollow, ui.nonFollowers, ui.dailyMax, ui.delayMin, ui.delayMax, ui.followsLabel, ui.whitelist]
      .forEach(function (el) { el.addEventListener('input', save); el.addEventListener('change', save); });

    window.addEventListener('keydown', function (event) {
      if (panel.contains(event.target)) event.stopPropagation();
    }, true);

    log('Ready. Defaults are ' + settings.dailyMax + ' per day, ' + settings.delayMinMin + '–' + settings.delayMaxMin + ' min between actions.');
    const daily = loadDaily();
    if (used(daily) >= settings.dailyMax) setStatus('Daily limit reached', 'stop');
  }

  const css = [
    '#xfu-panel{position:fixed;top:72px;right:16px;z-index:2147483646;width:320px;max-width:calc(100vw - 24px);',
    'background:#15202b;color:#e7e9ea;border:1px solid #38444d;border-radius:16px;',
    'box-shadow:0 8px 28px rgba(0,0,0,.45);font:13px/1.4 ui-sans-serif,system-ui,Segoe UI,sans-serif;color-scheme:dark;}',
    '#xfu-panel *{box-sizing:border-box;}',
    '#xfu-panel .xfu-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #38444d;}',
    '#xfu-panel .xfu-head strong{flex:1;font-size:14px;}',
    '#xfu-panel .xfu-dot{width:8px;height:8px;border-radius:50%;background:#8b98a5;flex:none;}',
    '#xfu-panel .xfu-dot-run{background:#00ba7c;}',
    '#xfu-panel .xfu-dot-wait{background:#1d9bf0;}',
    '#xfu-panel .xfu-dot-stop{background:#ffd400;}',
    '#xfu-panel .xfu-dot-bad{background:#f4212e;}',
    '#xfu-panel .xfu-icon,#xfu-panel button{font:inherit;color:inherit;cursor:pointer;}',
    '#xfu-panel .xfu-icon{border:0;background:transparent;color:#8b98a5;font-size:18px;line-height:1;padding:0 4px;}',
    '#xfu-panel .xfu-body{padding:10px 12px 12px;display:flex;flex-direction:column;gap:8px;}',
    '#xfu-panel.xfu-collapsed .xfu-body{display:none;}',
    '#xfu-panel.xfu-collapsed .xfu-head{border-bottom:0;}',
    '#xfu-panel .xfu-status{margin:0;font-weight:650;}',
    '#xfu-panel .xfu-meta,#xfu-panel .xfu-pace,#xfu-panel .xfu-hint{margin:0;color:#8b98a5;font-size:12px;}',
    '#xfu-panel .xfu-meta b{color:#e7e9ea;font-weight:650;}',
    '#xfu-panel .xfu-row,#xfu-panel .xfu-modes,#xfu-panel .xfu-split{display:flex;gap:8px;}',
    '#xfu-panel .xfu-split label{flex:1;}',
    '#xfu-panel .xfu-modes label,#xfu-panel .xfu-check{display:flex;align-items:center;gap:6px;}',
    '#xfu-panel .xfu-field{display:flex;flex-direction:column;gap:4px;color:#8b98a5;font-size:12px;}',
    '#xfu-panel input,#xfu-panel textarea{width:100%;background:#192734;color:#e7e9ea;border:1px solid #38444d;border-radius:8px;padding:6px 8px;font:inherit;}',
    '#xfu-panel textarea{resize:vertical;min-height:52px;}',
    '#xfu-panel .xfu-go,#xfu-panel .xfu-stop,#xfu-panel .xfu-quiet{border:0;border-radius:999px;padding:7px 12px;font-weight:700;}',
    '#xfu-panel .xfu-go{background:#eff3f4;color:#0f1419;flex:1;}',
    '#xfu-panel .xfu-stop{background:#f4212e;color:#fff;flex:1;}',
    '#xfu-panel .xfu-quiet{background:transparent;color:#1d9bf0;border:1px solid #38444d;}',
    '#xfu-panel button:disabled{opacity:.45;cursor:default;}',
    '#xfu-panel .xfu-log{max-height:140px;overflow:auto;background:#0f1419;border-radius:8px;padding:8px;font:12px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace;color:#c4cdd4;}',
    '#xfu-panel .xfu-log div{white-space:pre-wrap;word-break:break-word;}'
  ].join('');

  if (typeof GM_addStyle === 'function') GM_addStyle(css);
  else {
    const style = document.createElement('style');
    style.textContent = css;
    document.documentElement.appendChild(style);
  }

  function boot() {
    ensurePanel();
    setInterval(function () {
      ensurePanel();
      if (!running) updatePanel();
    }, 2000);
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden && running && !warnedHidden) {
      warnedHidden = true;
      log('Tab is hidden. Leave it open in the foreground so the 5–6 min gap stays accurate.');
    }
  });

  if (document.body) boot();
  else document.addEventListener('DOMContentLoaded', boot);
})();
