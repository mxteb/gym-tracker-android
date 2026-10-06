/*
 * Gym Tracker — التحديثات (التطبيق فقط) — E3
 *  - يشيك على GitHub (مرة كل 6 ساعات كحد أقصى، وبصمت لو ما فيه نت) وإذا فيه نسخة أحدث يطلع شريط فوق.
 *  - بعد ما تثبّت نسخة جديدة، يعرض لك «وش الجديد» مرة وحدة.
 */
(function () {
  'use strict';
  var cap = window.Capacitor;
  if (!cap || !cap.isNativePlatform || !cap.isNativePlatform()) return;
  var App = cap.registerPlugin('App');
  var N = window.__gymNative || (window.__gymNative = { exports: [], notifications: [], errors: [] });
  var REPO = 'mxteb/gym-tracker-android';
  var API = 'https://api.github.com/repos/' + REPO + '/releases/latest';
  var APK = 'https://github.com/' + REPO + '/releases/latest/download/GymTracker.apk';
  var LS_CHECK = 'gt_update_checked', LS_SEEN = 'gt_seen_build', LS_SKIP = 'gt_update_dismissed';
  var EVERY = 6 * 3600 * 1000;
  var info = null;
  N.update = { checks: 0 };

  function ls(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, String(v)); } catch (e) { return null; } }
  function ui() { return window.__gymNativeUI; }
  function buildOf(tag) { var m = /(\d+)\s*$/.exec(tag || ''); return m ? Number(m[1]) : 0; }

  async function appInfo() {
    if (!info) { try { info = await App.getInfo(); } catch (e) { info = { build: '0', version: '?' }; } }
    return info;
  }

  function openDownload() {
    // leaving the app's own origin opens the phone's browser, which downloads the APK
    window.location.href = APK;
  }

  function showBanner(rel, latest) {
    if (document.getElementById('gt-update-banner')) return;
    var bar = document.createElement('div');
    bar.id = 'gt-update-banner';
    bar.setAttribute('role', 'status');
    var t = document.createElement('span'); t.textContent = 'نسخة جديدة متوفرة (1.' + latest + ')';
    var more = document.createElement('button'); more.type = 'button'; more.id = 'gt-update-open'; more.textContent = 'وش الجديد؟';
    var x = document.createElement('button'); x.type = 'button'; x.className = 'gt-x'; x.setAttribute('aria-label', 'إخفاء'); x.textContent = '✕';
    more.addEventListener('click', function () {
      ui().show('التحديث 1.' + latest, (rel.body || '').trim() || 'تحسينات وإصلاحات.',
        [{ label: 'تحميل التحديث', primary: true, id: 'gt-update-download', action: openDownload }, { label: 'بعدين' }]);
    });
    x.addEventListener('click', function () { ls(LS_SKIP, latest); bar.remove(); });
    bar.append(t, more, x);
    var header = document.querySelector('header');
    if (header && header.parentNode) header.parentNode.insertBefore(bar, header.nextSibling); else document.body.prepend(bar);
  }

  async function check(force) {
    var last = Number(ls(LS_CHECK)) || 0;
    if (!force && Date.now() - last < EVERY) return;
    ls(LS_CHECK, Date.now());
    N.update.checks++;
    try {
      var ctrl = new AbortController(); var timer = setTimeout(function () { ctrl.abort(); }, 8000);
      var res = await fetch(API, { headers: { Accept: 'application/vnd.github+json' }, signal: ctrl.signal, cache: 'no-store' });
      clearTimeout(timer);
      if (!res.ok) { N.update.lastStatus = res.status; return; }
      var rel = await res.json();
      var latest = buildOf(rel.tag_name), mine = Number((await appInfo()).build) || 0;
      N.update.latest = latest; N.update.mine = mine;
      if (latest > mine && String(latest) !== ls(LS_SKIP)) showBanner(rel, latest);
    } catch (e) { N.update.lastError = String(e && e.message || e); }
  }

  async function whatsNew() {
    var mine = Number((await appInfo()).build) || 0;
    var seen = Number(ls(LS_SEEN)) || 0;
    var hadData = !!(window.GymApp && GymApp.logCount && GymApp.logCount() > 0);
    ls(LS_SEEN, mine);
    // first ever run of a fresh install: nothing is "new" yet
    if (mine <= seen || (!seen && !hadData)) return;
    var notes = '';
    try { notes = (await (await fetch('./whats-new.txt', { cache: 'no-store' })).text()).trim(); } catch (e) { }
    if (!notes) return;
    N.update.whatsNewShown = mine;
    ui().show('وش الجديد في 1.' + mine, notes, [{ label: 'تمام', primary: true, id: 'gt-whatsnew-ok' }]);
  }

  var css = document.createElement('style');
  css.textContent =
    '#gt-update-banner{display:flex;align-items:center;gap:10px;margin:0 16px 12px;padding:8px 12px;border-radius:14px;background:#0c2a33;border:1px solid #22d3ee;color:#cffafe;font-size:13px;font-weight:600}' +
    '#gt-update-banner span{flex:1}' +
    '#gt-update-banner button{font:inherit;font-size:13px;min-height:40px;border-radius:10px;border:none;background:#22d3ee;color:#04212a;font-weight:700;padding:6px 12px;cursor:pointer}' +
    '#gt-update-banner .gt-x{background:transparent;color:#67e8f9;min-width:40px;padding:6px}';
  (document.head || document.documentElement).appendChild(css);

  function start() {
    whatsNew().catch(function () {}); check(false);
    App.addListener('resume', function () { check(false); });
  }
  var started = false;
  function once() { if (!started) { started = true; start(); } }
  document.addEventListener('gym:ready', once);
  setTimeout(once, 8000); // the app failed to load its data: still offer updates
  N.update.check = check;
})();
