/*
 * Gym Tracker — «وش الجديد» (التطبيق فقط، في نسخة المتجر ونسخة GitHub)
 *  بعد ما تتحدث النسخة، يعرض ملاحظات النسخة مرة وحدة. ما يتصل بالنت: يقرأ ملف whats-new.txt من داخل التطبيق.
 */
(function () {
  'use strict';
  var cap = window.Capacitor;
  if (!cap || !cap.isNativePlatform || !cap.isNativePlatform()) return;
  function plugin(name) { return (cap.Plugins && cap.Plugins[name]) || (typeof cap.registerPlugin === 'function' ? cap.registerPlugin(name) : undefined); }
  var App = plugin('App');
  var N = window.__gymNative || (window.__gymNative = { exports: [], notifications: [], errors: [] });
  var LS_SEEN = 'gt_seen_build';
  N.update = N.update || { checks: 0 };

  function ls(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, String(v)); } catch (e) { return null; } }

  async function whatsNew() {
    var info;
    try { info = await App.getInfo(); } catch (e) { info = { build: '0' }; }
    var mine = Number(info.build) || 0;
    var seen = Number(ls(LS_SEEN)) || 0;
    var hadData = !!(window.GymApp && GymApp.logCount && GymApp.logCount() > 0);
    ls(LS_SEEN, mine);
    // first ever run of a fresh install: nothing is "new" yet
    if (mine <= seen || (!seen && !hadData)) return;
    var notes = '';
    var en = window.GymI18n && GymI18n.lang === 'en';
    try { notes = (await (await fetch(en ? './whats-new.en.txt' : './whats-new.txt', { cache: 'no-store' })).text()).trim(); } catch (e) { }
    if (!notes) return;
    N.update.whatsNewShown = mine;
    window.__gymNativeUI.show('وش الجديد في 1.' + mine, notes, [{ label: 'تمام', primary: true, id: 'gt-whatsnew-ok' }]);
  }

  var started = false;
  function once() { if (!started) { started = true; whatsNew().catch(function () {}); } }
  document.addEventListener('gym:ready', once);
  setTimeout(once, 8000);
})();
