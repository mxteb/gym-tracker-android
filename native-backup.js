/*
 * Gym Tracker — النسخ الاحتياطية في الجوال (التطبيق فقط)
 *  D1  نسخة تلقائية بعد كل جلسة في التنزيلات ← GymTracker ← auto، ويحتفظ بآخر 10.
 *  D2  قائمة بالنسخ المحفوظة وتسترجع أي وحدة بضغطة.
 *  D3  تذكير أسبوعي (تختار اليوم والساعة) يفتح لك إرسال النسخة لـ Drive.
 */
(function () {
  'use strict';
  var cap = window.Capacitor;
  if (!cap || !cap.isNativePlatform || !cap.isNativePlatform()) return;
  function plugin(name) { return (cap.Plugins && cap.Plugins[name]) || (typeof cap.registerPlugin === 'function' ? cap.registerPlugin(name) : undefined); }
  var Filesystem = plugin('Filesystem');
  var Share = plugin('Share');
  var LocalNotifications = plugin('LocalNotifications');
  var N = window.__gymNative || (window.__gymNative = { exports: [], notifications: [], errors: [] });
  N.backups = [];
  function note(where, e) { try { N.errors.push(where + ': ' + (e && e.message ? e.message : String(e))); } catch (x) {} }

  var ROOT = 'Download/GymTracker', AUTO = ROOT + '/auto', KEEP = 10, WEEKLY_ID = 7100;
  var LS_LAST = 'gt_last_backup', LS_WEEKLY = 'gt_weekly_reminder';
  var DAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت']; // Capacitor weekday 1..7 = Sunday..Saturday

  function ls(key, value) {
    try {
      if (value === undefined) return JSON.parse(localStorage.getItem(key) || 'null');
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) { return null; }
  }
  function pad(n) { return String(n).padStart(2, '0'); }
  function stampName(prefix) {
    var d = new Date();
    return prefix + '_' + d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + '_' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) + '.json';
  }
  function toast(msg) { if (window.GymApp && GymApp.showToast) GymApp.showToast(msg); }
  function dialog() { return window.__gymNativeUI; }
  function ago(ms) {
    var m = Math.round((Date.now() - ms) / 60000);
    if (m < 2) return 'قبل لحظات';
    if (m < 60) return 'قبل ' + m + ' دقيقة';
    var h = Math.round(m / 60); if (h < 24) return 'قبل ' + h + ' ساعة';
    var d = Math.round(h / 24); return d === 1 ? 'أمس' : 'قبل ' + d + ' يوم';
  }
  function fmtDate(ms) {
    var d = new Date(ms);
    return d.getFullYear() + '/' + pad(d.getMonth() + 1) + '/' + pad(d.getDate()) + ' — ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  /* ---------- writing ---------- */
  async function writeBackup(folder, name) {
    if (!window.GymApp || !GymApp.buildBackup) throw new Error('التطبيق ما جهز');
    var backup = GymApp.buildBackup();
    var text = JSON.stringify(backup, null, 2);
    var r = await Filesystem.writeFile({ path: folder + '/' + name, data: text, directory: 'EXTERNAL_STORAGE', encoding: 'utf8', recursive: true });
    ls(LS_LAST, { at: Date.now(), name: name, logs: (backup.logs || []).length });
    N.backups.push({ name: name, folder: folder, uri: r.uri, logs: (backup.logs || []).length });
    renderStatus();
    return r.uri;
  }
  async function prune() {
    try {
      var list = await Filesystem.readdir({ path: AUTO, directory: 'EXTERNAL_STORAGE' });
      var files = (list.files || []).filter(function (f) { return /\.json$/i.test(f.name); }).sort(function (a, b) { return a.name < b.name ? 1 : -1; });
      for (var i = KEEP; i < files.length; i++) await Filesystem.deleteFile({ path: AUTO + '/' + files[i].name, directory: 'EXTERNAL_STORAGE' });
    } catch (e) { note('prune', e); }
  }
  document.addEventListener('gym:session-finished', function () {
    writeBackup(AUTO, stampName('gym_tracker_auto')).then(function () {
      toast('انحفظت نسخة احتياطية تلقائية ✓');
      return prune();
    }).catch(function (e) {
      note('auto-backup', e);
      toast('ما قدرت أحفظ النسخة التلقائية. صدّر نسخة يدوياً من البروفايل.');
    });
  });

  /* ---------- listing & restoring ---------- */
  async function listBackups() {
    var out = [];
    for (var folder of [AUTO, ROOT]) {
      try {
        var r = await Filesystem.readdir({ path: folder, directory: 'EXTERNAL_STORAGE' });
        (r.files || []).forEach(function (f) {
          if (f.type === 'directory' || !/\.json$/i.test(f.name)) return;
          out.push({ name: f.name, folder: folder, auto: folder === AUTO, mtime: Number(f.mtime) || 0, size: Number(f.size) || 0 });
        });
      } catch (e) { /* folder not created yet */ }
    }
    out.sort(function (a, b) { return b.mtime - a.mtime; });
    return out;
  }
  async function restore(item) {
    var ui = dialog();
    try {
      var r = await Filesystem.readFile({ path: item.folder + '/' + item.name, directory: 'EXTERNAL_STORAGE', encoding: 'utf8' });
      var ok = await GymApp.importBackupText(r.data);
      if (ok) { N.lastRestore = item.name; ui.close(); }
    } catch (e) {
      note('restore', e);
      ui.show('تعذر فتح النسخة', 'ما قدرت أقرأ الملف. ممكن انحذف أو انتقل. جرّب «استيراد JSON» واختره من منتقي الملفات.', [{ label: 'حسنًا', primary: true }]);
    }
  }
  async function openRestoreList() {
    var ui = dialog();
    ui.show('النسخ المحفوظة في جوالك', 'أدور على النسخ…', []);
    var items = await listBackups();
    if (!items.length) {
      ui.show('ما فيه نسخ محفوظة', 'لما تنهي جلسة تنحفظ نسخة تلقائياً، ولما تصدّر نسخة تنحفظ هنا بعد.\n\nنسخ من نسخة قديمة من التطبيق ما تظهر هنا: افتحها من «استيراد JSON» ← ☰ ← التنزيلات ← GymTracker.', [{ label: 'حسنًا', primary: true }]);
      return;
    }
    var list = document.createElement('div');
    list.className = 'gt-list';
    items.slice(0, 30).forEach(function (it, i) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'gt-row'; b.id = 'gt-backup-' + i;
      var t = document.createElement('span'); t.className = 'gt-row-title'; t.textContent = fmtDate(it.mtime);
      var s = document.createElement('span'); s.className = 'gt-row-sub';
      s.textContent = (it.auto ? 'تلقائية بعد جلسة' : 'تصدير يدوي') + ' · ' + Math.max(1, Math.round(it.size / 1024)) + ' KB';
      b.append(t, s);
      b.addEventListener('click', function () {
        ui.show('استرجاع نسخة ' + fmtDate(it.mtime) + '؟',
          'تنضاف كل الجولات والجلسات اللي في النسخة وناقصة عندك. ما ينمسح شي من بياناتك الحالية، والمكرر ما يتكرر.',
          [{ label: 'استرجاع', primary: true, id: 'gt-restore-confirm', action: function () { restore(it); }, keepOpen: true }, { label: 'رجوع', action: openRestoreList, keepOpen: true }]);
      });
      list.append(b);
    });
    ui.show('النسخ المحفوظة في جوالك', 'اختر النسخة اللي تبي تسترجعها (الأحدث فوق).', [{ label: 'إغلاق' }], list);
  }

  /* ---------- weekly Drive reminder ---------- */
  async function applyWeekly(cfg) {
    try { await LocalNotifications.cancel({ notifications: [{ id: WEEKLY_ID }] }); } catch (e) {}
    if (!cfg || !cfg.on) return true;
    var p = await LocalNotifications.checkPermissions().catch(function () { return {}; });
    if (p.display !== 'granted') p = await LocalNotifications.requestPermissions().catch(function () { return {}; });
    if (p.display !== 'granted') return false;
    await LocalNotifications.createChannel({ id: 'backup-reminder', name: 'تذكير النسخة الاحتياطية', description: 'تذكير أسبوعي ترسل نسختك لـ Drive', importance: 4, visibility: 1 }).catch(function () {});
    await LocalNotifications.schedule({ notifications: [{
      id: WEEKLY_ID, title: 'وقت النسخة الاحتياطية', body: 'اضغط هنا وأرسل نسخة تمارينك لـ Google Drive عشان تكون بأمان.',
      channelId: 'backup-reminder', schedule: { on: { weekday: cfg.day, hour: cfg.hour, minute: 0 }, allowWhileIdle: true }
    }] });
    return true;
  }
  async function shareFreshBackup() {
    try {
      var uri = await writeBackup(ROOT, stampName('gym_tracker_backup'));
      await Share.share({ title: 'Gym Tracker', files: [uri], dialogTitle: 'إرسال النسخة الاحتياطية' }).catch(function () {});
    } catch (e) { note('weekly-share', e); toast('ما قدرت أجهز النسخة. صدّرها من البروفايل.'); }
  }
  if (LocalNotifications && LocalNotifications.addListener) {
    LocalNotifications.addListener('localNotificationActionPerformed', function (ev) {
      if (ev && ev.notification && ev.notification.id === WEEKLY_ID) {
        var go = function () { var nav = document.getElementById('nav-profile'); if (nav) nav.click(); shareFreshBackup(); };
        if (window.GymApp) setTimeout(go, 600); else document.addEventListener('DOMContentLoaded', function () { setTimeout(go, 1200); });
      }
    });
  }

  /* ---------- the card on the profile screen ---------- */
  var statusEl = null;
  function renderStatus() {
    if (!statusEl) return;
    var last = ls(LS_LAST);
    statusEl.textContent = last && last.at ? 'آخر نسخة: ' + ago(last.at) + ' (' + last.logs + ' جولة)' : 'ما فيه نسخة محفوظة للحين. أول ما تنهي جلسة تنحفظ وحدة تلقائياً.';
  }
  function buildCard() {
    var exportBtn = document.getElementById('btn-export-json');
    if (!exportBtn || document.getElementById('gt-backup-card')) return;
    var dataCard = exportBtn.closest('.glass-card');
    var card = document.createElement('div');
    card.className = 'glass-card p-4 space-y-3'; card.id = 'gt-backup-card';
    var h = document.createElement('h3'); h.className = 'font-bold text-xs text-slate-300'; h.textContent = 'النسخ الاحتياطية في جوالك';
    statusEl = document.createElement('p'); statusEl.className = 'text-xs text-slate-400'; statusEl.id = 'gt-backup-status';
    var restoreBtn = document.createElement('button');
    restoreBtn.type = 'button'; restoreBtn.id = 'gt-open-restore';
    restoreBtn.className = 'w-full py-2 px-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold text-xs border border-slate-700 flex items-center justify-center gap-2';
    restoreBtn.textContent = 'استرجاع نسخة محفوظة';
    restoreBtn.addEventListener('click', openRestoreList);
    // M3: النسخ ملفات عادية في التنزيلات عشان تبقى لو انحذف التطبيق، فنقول بوضوح مين يقدر يشوفها
    var where = document.createElement('p'); where.className = 'text-xs text-slate-500'; where.id = 'gt-backup-where';
    where.textContent = 'النسخ تنحفظ في التنزيلات ← GymTracker عشان تبقى حتى لو حذفت التطبيق. أي أحد يفتح ملفات جوالك يقدر يشوفها (فيها وزنك وقياساتك).';

    var cfg = ls(LS_WEEKLY) || { on: false, day: 6, hour: 20 };
    var row = document.createElement('div'); row.className = 'gt-weekly';
    var lab = document.createElement('label'); lab.className = 'gt-switch';
    var chk = document.createElement('input'); chk.type = 'checkbox'; chk.id = 'gt-weekly-on'; chk.checked = !!cfg.on;
    var txt = document.createElement('span'); txt.textContent = 'ذكّرني كل أسبوع أرسل نسخة لـ Drive';
    lab.append(chk, txt);
    var when = document.createElement('div'); when.className = 'gt-when';
    var day = document.createElement('select'); day.id = 'gt-weekly-day'; day.className = 'glass-input px-3 py-2 rounded-xl text-xs'; day.setAttribute('aria-label', 'يوم التذكير');
    DAYS.forEach(function (n, i) { var o = document.createElement('option'); o.value = String(i + 1); o.textContent = n; day.append(o); });
    day.value = String(cfg.day);
    var hour = document.createElement('select'); hour.id = 'gt-weekly-hour'; hour.className = 'glass-input px-3 py-2 rounded-xl text-xs'; hour.setAttribute('aria-label', 'ساعة التذكير');
    for (var hh = 6; hh <= 23; hh++) { var o = document.createElement('option'); o.value = String(hh); o.textContent = (hh % 12 || 12) + (hh < 12 ? ' الصبح' : hh < 17 ? ' الظهر' : ' المساء'); hour.append(o); }
    hour.value = String(cfg.hour);
    when.append(day, hour); when.hidden = !cfg.on;
    var weeklyMsg = document.createElement('p'); weeklyMsg.className = 'text-xs text-slate-400'; weeklyMsg.id = 'gt-weekly-msg';
    function save() {
      var next = { on: chk.checked, day: Number(day.value), hour: Number(hour.value) };
      when.hidden = !next.on;
      applyWeekly(next).then(function (ok) {
        if (!ok) { chk.checked = false; when.hidden = true; next.on = false; weeklyMsg.textContent = 'التذكير يحتاج إذن الإشعارات. فعّله من إعدادات الجوال ← التطبيقات ← Gym Tracker.'; }
        else weeklyMsg.textContent = next.on ? 'بيجيك التذكير كل ' + DAYS[next.day - 1] + ' الساعة ' + hour.options[hour.selectedIndex].textContent + '.' : '';
        ls(LS_WEEKLY, next);
      }).catch(function (e) { note('weekly', e); weeklyMsg.textContent = 'ما قدرت أضبط التذكير. جرّب مرة ثانية.'; });
    }
    chk.addEventListener('change', save); day.addEventListener('change', save); hour.addEventListener('change', save);
    if (cfg.on) weeklyMsg.textContent = 'بيجيك التذكير كل ' + DAYS[cfg.day - 1] + ' الساعة ' + hour.options[hour.selectedIndex].textContent + '.';
    row.append(lab, when, weeklyMsg);
    card.append(h, statusEl, where, restoreBtn, row);
    dataCard.parentNode.insertBefore(card, dataCard);
    renderStatus();
    if (cfg.on) applyWeekly(cfg).catch(function () {});
  }
  var css = document.createElement('style');
  css.textContent =
    '.gt-weekly{display:flex;flex-direction:column;gap:8px}' +
    '.gt-switch{display:flex;align-items:center;gap:10px;font-size:13px;color:#EDEBE6;min-height:44px;cursor:pointer}' +
    '.gt-switch input{width:20px;height:20px;accent-color:#E3B21B;flex:none}' +
    '.gt-when{display:grid;grid-template-columns:1fr 1fr;gap:8px}' +
    '.gt-when[hidden]{display:none}' +
    '.gt-list{display:flex;flex-direction:column;gap:6px;max-height:50vh;overflow-y:auto;margin:0 0 12px}' +
    '.gt-row{display:flex;flex-direction:column;align-items:flex-start;gap:2px;text-align:right;width:100%;min-height:52px;padding:8px 12px;border-radius:4px;border:1px solid #333331;background:#0A0A0A;color:#EDEBE6;font:inherit;cursor:pointer}' +
    '.gt-row-title{font-size:13px;font-weight:700}.gt-row-sub{font-size:12px;color:#9A978F}';
  (document.head || document.documentElement).appendChild(css);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', buildCard); else buildCard();
  document.addEventListener('visibilitychange', function () { if (!document.hidden) renderStatus(); });
})();
