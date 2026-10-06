/*
 * Gym Tracker — طبقة أندرويد
 * يشتغل قبل ملفات التطبيق. في المتصفح العادي ما يسوي شي (غير بوليفيل بسيط).
 * داخل تطبيق الأندرويد يصلّح الأشياء اللي تختلف عن Chrome:
 *  1) التصدير: زر التنزيل في الموقع ما يشتغل داخل WebView، فنحفظ الملف في المستندات/GymTracker ونعرض المشاركة.
 *  2) زر الرجوع في الجوال: يقفل النوافذ المفتوحة، يرجع لتبويب التمرين، وبعدها يصغّر التطبيق بدل ما يقفله.
 *  3) مؤقت الراحة: لو طلعت من التطبيق أو قفلت الشاشة، يجيك إشعار بصوت واهتزاز لما يخلص الوقت.
 *  4) Service Worker: يتعطل داخل التطبيق لأن الملفات أصلاً داخل الجهاز، وعشان التحديثات ما تعلق على نسخة قديمة.
 */
(function () {
  'use strict';

  // بوليفيل لأجهزة WebView القديمة
  if (typeof Element !== 'undefined' && !Element.prototype.replaceChildren) {
    Element.prototype.replaceChildren = function () {
      while (this.firstChild) this.removeChild(this.firstChild);
      for (var i = 0; i < arguments.length; i++) {
        var n = arguments[i];
        this.appendChild(typeof n === 'string' ? document.createTextNode(n) : n);
      }
    };
  }

  var cap = window.Capacitor;
  if (!cap || !cap.isNativePlatform || !cap.isNativePlatform()) return;

  function plugin(name) {
    try { if (cap.registerPlugin) return cap.registerPlugin(name); } catch (e) {}
    return cap.Plugins ? cap.Plugins[name] : undefined;
  }
  var Filesystem = plugin('Filesystem');
  var Share = plugin('Share');
  var App = plugin('App');
  var LocalNotifications = plugin('LocalNotifications');
  var state = window.__gymNative = { exports: [], notifications: [], errors: [] };
  function note(where, e) { try { state.errors.push(where + ': ' + (e && e.message ? e.message : String(e))); } catch (x) {} }

  /* ---------- 4) Service Worker ---------- */
  if ('serviceWorker' in navigator) {
    try {
      var stub = function () { return Promise.resolve({ update: function () { return Promise.resolve(); } }); };
      Object.defineProperty(ServiceWorkerContainer.prototype, 'register', { value: stub, configurable: true, writable: true });
      navigator.serviceWorker.getRegistrations().then(function (rs) { rs.forEach(function (r) { r.unregister(); }); }).catch(function () {});
    } catch (e) { note('sw', e); }
  }
  if (window.caches && caches.keys) {
    caches.keys().then(function (keys) {
      keys.forEach(function (k) { if (k.indexOf('gym-tracker-') === 0) caches.delete(k); });
    }).catch(function () {});
  }

  /* ---------- واجهة صغيرة (نافذة) بنفس ألوان التطبيق ---------- */
  var css = document.createElement('style');
  css.textContent =
    '#gt-native-dialog{position:fixed;inset:0;z-index:200;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(2,6,23,.75)}' +
    '#gt-native-dialog .box{width:100%;max-width:380px;background:#0f172a;border:1px solid rgba(34,211,238,.35);border-radius:20px;padding:18px;color:#e2e8f0;font-family:Tahoma,Arial,sans-serif;direction:rtl;text-align:right;box-shadow:0 20px 50px rgba(0,0,0,.5)}' +
    '#gt-native-dialog h3{margin:0 0 8px;font-size:15px;color:#67e8f9}' +
    '#gt-native-dialog p{margin:0 0 14px;font-size:13px;line-height:1.7;white-space:pre-line;color:#cbd5e1;word-break:break-word}' +
    '#gt-native-dialog .row{display:flex;gap:8px;flex-wrap:wrap}' +
    '#gt-native-dialog button{flex:1;min-height:44px;border-radius:12px;border:1px solid #334155;background:#1e293b;color:#e2e8f0;font:inherit;font-size:13px;font-weight:700;padding:8px 10px}' +
    '#gt-native-dialog button.primary{background:linear-gradient(90deg,#06b6d4,#2563eb);border-color:transparent;color:#fff}';
  (document.head || document.documentElement).appendChild(css);

  function closeDialog() {
    var d = document.getElementById('gt-native-dialog');
    if (!d) return false;
    d.remove();
    return true;
  }
  function showDialog(title, message, buttons) {
    closeDialog();
    var wrap = document.createElement('div');
    wrap.id = 'gt-native-dialog';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    var box = document.createElement('div'); box.className = 'box';
    var h = document.createElement('h3'); h.textContent = title;
    var p = document.createElement('p'); p.textContent = message;
    var row = document.createElement('div'); row.className = 'row';
    buttons.forEach(function (b) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = b.label;
      if (b.primary) btn.className = 'primary';
      if (b.id) btn.id = b.id;
      btn.addEventListener('click', function () { closeDialog(); if (b.action) b.action(); });
      row.appendChild(btn);
    });
    box.appendChild(h); box.appendChild(p); box.appendChild(row);
    wrap.appendChild(box);
    wrap.addEventListener('click', function (e) { if (e.target === wrap) closeDialog(); });
    document.body.appendChild(wrap);
  }

  /* ---------- 1) التصدير ---------- */
  function stamp() {
    var d = new Date();
    return [d.getHours(), d.getMinutes(), d.getSeconds()].map(function (n) { return String(n).padStart(2, '0'); }).join('');
  }
  async function saveBackup(blobUrl, filename) {
    var text, finalName = String(filename).replace(/\.json$/i, '') + '_' + stamp() + '.json';
    try {
      text = await (await fetch(blobUrl)).text();
    } catch (e) {
      note('export-read', e);
      showDialog('تعذر تجهيز الملف', 'صار خطأ أثناء تجهيز النسخة الاحتياطية. حاول مرة ثانية.', [{ label: 'حسنًا', primary: true }]);
      return;
    }
    var savedUri = null, shareUri = null;
    try {
      var r = await Filesystem.writeFile({ path: 'GymTracker/' + finalName, data: text, directory: 'DOCUMENTS', encoding: 'utf8', recursive: true });
      savedUri = shareUri = r.uri;
    } catch (e) { note('export-documents', e); }
    if (!shareUri) {
      try {
        var c = await Filesystem.writeFile({ path: finalName, data: text, directory: 'CACHE', encoding: 'utf8' });
        shareUri = c.uri;
      } catch (e) { note('export-cache', e); }
    }
    state.exports.push({ name: finalName, savedToDocuments: !!savedUri, uri: shareUri, bytes: text.length });
    if (!shareUri) {
      showDialog('تعذر حفظ الملف', 'ما قدرت أحفظ النسخة على الجهاز. تأكد إن فيه مساحة كافية وحاول مرة ثانية.', [{ label: 'حسنًا', primary: true }]);
      return;
    }
    var share = function () {
      Share.share({ title: finalName, files: [shareUri], dialogTitle: 'حفظ النسخة الاحتياطية' }).catch(function (e) {
        if (!/cancel/i.test(String(e && e.message))) note('share', e);
      });
    };
    if (savedUri) {
      showDialog('تم حفظ النسخة الاحتياطية ✅',
        'انحفظت في جوالك داخل:\nالمستندات (Documents) ← GymTracker\n' + finalName +
        '\n\nللأمان أكثر أرسلها لـ Google Drive أو لنفسك في واتساب، عشان ما تضيع لو ضاع الجوال.',
        [{ label: 'إرسال / حفظ في Drive', primary: true, action: share, id: 'gt-share-btn' }, { label: 'تم', id: 'gt-done-btn' }]);
    } else {
      showDialog('النسخة جاهزة', 'اختر مكان الحفظ (Drive أو الملفات أو واتساب) من القائمة اللي بتطلع لك.',
        [{ label: 'اختيار مكان الحفظ', primary: true, action: share, id: 'gt-share-btn' }, { label: 'إلغاء', id: 'gt-done-btn' }]);
    }
  }
  var originalClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    var name = this.getAttribute('download');
    var href = this.href || '';
    if (name && href.indexOf('blob:') === 0 && Filesystem) { saveBackup(href, name); return; }
    return originalClick.apply(this, arguments);
  };

  /* ---------- 3) إشعار انتهاء الراحة ---------- */
  var REST_ID = 7001, KEY = 'gym_rest_deadline';
  var channelReady = null, permissionAsked = false;
  function readDeadline() {
    try {
      var d = JSON.parse(localStorage.getItem(KEY) || 'null');
      return d && isFinite(d.endsAt) ? d : null;
    } catch (e) { return null; }
  }
  function ensureChannel() {
    if (!channelReady) {
      channelReady = LocalNotifications.createChannel({
        id: 'rest-timer', name: 'مؤقت الراحة', description: 'تنبيه لما يخلص وقت الراحة بين الجولات',
        importance: 5, visibility: 1, vibration: true, lights: true, lightColor: '#22D3EE'
      }).catch(function (e) { note('channel', e); });
    }
    return channelReady;
  }
  async function hasPermission(ask) {
    try {
      var p = await LocalNotifications.checkPermissions();
      if (p.display === 'granted') return true;
      if (!ask) return false;
      p = await LocalNotifications.requestPermissions();
      return p.display === 'granted';
    } catch (e) { note('permission', e); return false; }
  }
  function cancelRest() {
    if (!LocalNotifications) return Promise.resolve();
    return LocalNotifications.cancel({ notifications: [{ id: REST_ID }] }).catch(function () {});
  }
  var scheduling = null;
  async function scheduleRest() {
    var d = readDeadline();
    if (!d || d.endsAt - Date.now() < 1500) return;
    if (!(await hasPermission(false))) return;
    await ensureChannel();
    try {
      await LocalNotifications.schedule({ notifications: [{
        id: REST_ID,
        title: 'انتهى وقت الراحة ⏱️',
        body: 'حان وقت الجولة التالية' + (d.name ? ' — ' + d.name : ''),
        channelId: 'rest-timer',
        schedule: { at: new Date(d.endsAt), allowWhileIdle: true }
      }] });
      state.notifications.push({ at: d.endsAt, scheduledAt: Date.now() });
    } catch (e) { note('schedule', e); }
  }
  function onBackground() {
    if (!LocalNotifications || scheduling) return;
    scheduling = scheduleRest().finally(function () { scheduling = null; });
  }
  if (LocalNotifications) {
    var originalSet = Storage.prototype.setItem, originalRemove = Storage.prototype.removeItem;
    Storage.prototype.setItem = function (k) {
      var result = originalSet.apply(this, arguments);
      if (k === KEY && this === window.localStorage && !permissionAsked) {
        permissionAsked = true;
        ensureChannel();
        hasPermission(true);
      }
      return result;
    };
    Storage.prototype.removeItem = function (k) {
      var result = originalRemove.apply(this, arguments);
      if (k === KEY && this === window.localStorage) cancelRest();
      return result;
    };
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) onBackground(); else cancelRest();
    });
  }

  /* ---------- 2) زر الرجوع + الخروج/العودة ---------- */
  if (App) {
    App.addListener('backButton', function () {
      if (closeDialog()) return;
      if (document.querySelector('.modal-overlay:not(.hidden)')) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        return;
      }
      var active = document.querySelector('.dock-item.active');
      var home = document.getElementById('nav-workout');
      if (active && home && active !== home) { home.click(); window.scrollTo(0, 0); return; }
      App.minimizeApp();
    });
    App.addListener('pause', onBackground);
    App.addListener('resume', function () { cancelRest(); });
  }
  cancelRest();
})();
