/*
 * Gym Tracker — طبقة أندرويد
 * يشتغل قبل ملفات التطبيق. في المتصفح العادي ما يسوي شي (غير بوليفيل بسيط).
 * داخل تطبيق الأندرويد يصلّح الأشياء اللي تختلف عن Chrome:
 *  1) التصدير: زر التنزيل في الموقع ما يشتغل داخل WebView، فنحفظ الملف في المستندات/GymTracker ونعرض المشاركة.
 *  2) زر الرجوع في الجوال: يقفل النوافذ المفتوحة، يرجع لتبويب التمرين، وبعدها يصغّر التطبيق بدل ما يقفله.
 *  3) مؤقت الراحة: لو طلعت من التطبيق أو قفلت الشاشة، يجيك إشعار بصوت واهتزاز لما يخلص الوقت.
 *  4) Service Worker: يتعطل داخل التطبيق لأن الملفات أصلاً داخل الجهاز، وعشان التحديثات ما تعلق على نسخة قديمة.
 *  6) تنبيه الراحة على الثانية: من أندرويد 12 يحتاج إذن «المنبّهات والتذكيرات» يعطيه المستخدم بنفسه.
 *     بدونه التنبيه يشتغل بس ممكن يتأخر والجوال مقفول، فنشرح له مرة وحدة ونحط زر في البروفايل.
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

  function plugin(name) { return (cap.Plugins && cap.Plugins[name]) || (typeof cap.registerPlugin === 'function' ? cap.registerPlugin(name) : undefined); }
  var Filesystem = plugin('Filesystem');
  var Share = plugin('Share');
  var App = plugin('App');
  var LocalNotifications = plugin('LocalNotifications');
  var GymNative = plugin('GymNative');
  var state = window.__gymNative = { exports: [], notifications: [], errors: [] };
  // نصوص تطلع برا الصفحة (إشعارات، قائمة المشاركة) تترجم هنا؛ نصوص الصفحة تترجمها i18n.js لحالها
  function T(s) { return window.GymI18n ? GymI18n.t(s) : s; }
  function note(where, e) { try { state.errors.push(where + ': ' + (e && e.message ? e.message : String(e))); } catch (x) {} }

  /* ---------- 5) الشاشة تبقى شغالة + الاهتزاز (v10.7) ----------
   * الموقع ينادي window.GymNativeHooks لو موجودة، وإلا يستخدم بدائل المتصفح. */
  if (GymNative) {
    window.GymNativeHooks = {
      keepAwake: function (on) {
        return GymNative.keepAwake({ on: !!on }).then(function (r) { state.keepAwake = !!on; return r; }).catch(function (e) { note('keepAwake', e); });
      },
      setBars: function (color, light) {
        var c = String(color || '#121212').trim();
        if (/^#[0-9a-f]{3}$/i.test(c)) c = '#' + c[1] + c[1] + c[2] + c[2] + c[3] + c[3];
        return GymNative.setBars({ color: c, light: !!light }).then(function (r) { state.bars = r; return r; }).catch(function (e) { note('bars', e); });
      },
      haptic: function (kind) {
        return GymNative.haptic({ kind: kind || 'tap' }).then(function (r) { state.haptics = (state.haptics || 0) + 1; return r; }).catch(function (e) { note('haptic', e); });
      }
    };
  }

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
    '#gt-native-dialog{position:fixed;top:0;right:0;bottom:0;left:0;z-index:200;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,.82)}' +
    '#gt-native-dialog .box{width:100%;max-width:380px;max-height:90vh;overflow-y:auto;box-sizing:border-box;background:#1B1B1A;border:1px solid #333331;border-radius:4px;padding:18px;color:#EDEBE6;font-family:Alexandria,Tahoma,Arial,sans-serif;direction:rtl;text-align:right;box-shadow:0 12px 40px rgba(0,0,0,.6)}' +
    '#gt-native-dialog h3{margin:0 0 8px;font-size:16px;font-weight:800;color:#EDEBE6}' +
    '#gt-native-dialog p{margin:0 0 14px;font-size:13px;line-height:1.7;white-space:pre-line;color:#C9C6BE;word-break:break-word}' +
    '#gt-native-dialog .row{display:flex;gap:8px;flex-wrap:wrap}' +
    '#gt-native-dialog button{flex:1;min-height:44px;border-radius:8px;border:1px solid #333331;background:#222221;color:#EDEBE6;font:inherit;font-size:13px;font-weight:700;padding:8px 10px}' +
    '#gt-native-dialog button.primary{background:#C8322A;border-color:transparent;color:#fff}' +
    '#gt-exact-card[hidden]{display:none!important}' +
    ':root[dir="ltr"] #gt-native-dialog .box{direction:ltr;text-align:left}';
  (document.head || document.documentElement).appendChild(css);

  function closeDialog() {
    var d = document.getElementById('gt-native-dialog');
    if (!d) return false;
    d.remove();
    return true;
  }
  function showDialog(title, message, buttons, extra) {
    closeDialog();
    var wrap = document.createElement('div');
    wrap.id = 'gt-native-dialog';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    var box = document.createElement('div'); box.className = 'box';
    var h = document.createElement('h3'); h.textContent = title;
    var p = document.createElement('p'); p.textContent = message;
    var row = document.createElement('div'); row.className = 'row';
    (buttons || []).forEach(function (b) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = b.label;
      if (b.primary) btn.className = 'primary';
      if (b.id) btn.id = b.id;
      btn.addEventListener('click', function () { if (!b.keepOpen) closeDialog(); if (b.action) b.action(); });
      row.appendChild(btn);
    });
    box.appendChild(h); box.appendChild(p);
    if (extra) box.appendChild(extra);
    box.appendChild(row);
    wrap.appendChild(box);
    wrap.addEventListener('click', function (e) { if (e.target === wrap) closeDialog(); });
    document.body.appendChild(wrap);
  }
  window.__gymNativeUI = { show: showDialog, close: closeDialog };

  /* ---------- 1) التصدير ---------- */
  function stamp() {
    var d = new Date();
    return [d.getHours(), d.getMinutes(), d.getSeconds()].map(function (n) { return String(n).padStart(2, '0'); }).join('');
  }
  async function saveBackup(blobUrl, filename) {
    // v1.37: the site also exports a CSV for Excel; keep its extension and talk about "the file", not "the backup"
    var ext = (/\.([a-z0-9]{1,5})$/i.exec(String(filename)) || [0, 'json'])[1].toLowerCase();
    var csv = ext === 'csv';
    var finalName = String(filename).replace(/\.[a-z0-9]{1,5}$/i, '') + '_' + stamp() + '.' + ext;
    var text;
    try {
      text = await (await fetch(blobUrl)).text();
      // text() drops the byte-order mark, and Excel needs it to read Arabic as UTF-8
      if (csv && text.charCodeAt(0) !== 0xFEFF) text = '\uFEFF' + text;
    } catch (e) {
      note('export-read', e);
      showDialog('تعذر تجهيز الملف', csv ? 'صار خطأ أثناء تجهيز الملف. حاول مرة ثانية.' : 'صار خطأ أثناء تجهيز النسخة الاحتياطية. حاول مرة ثانية.', [{ label: 'حسنًا', primary: true }]);
      return;
    }
    var savedUri = null, shareUri = null, place = null;
    // التنزيلات أسهل مكان يلقاه منتقي الملفات وقت الاستيراد (له اختصار مباشر)، والمستندات احتياط
    var targets = [
      { dir: 'EXTERNAL_STORAGE', path: 'Download/GymTracker/', label: 'التنزيلات (Download) ← GymTracker' },
      { dir: 'DOCUMENTS', path: 'GymTracker/', label: 'المستندات (Documents) ← GymTracker' }
    ];
    for (var i = 0; i < targets.length && !savedUri; i++) {
      try {
        var r = await Filesystem.writeFile({ path: targets[i].path + finalName, data: text, directory: targets[i].dir, encoding: 'utf8', recursive: true });
        savedUri = shareUri = r.uri; place = targets[i].label;
      } catch (e) { note('export-' + targets[i].dir, e); }
    }
    if (!shareUri) {
      try {
        var c = await Filesystem.writeFile({ path: finalName, data: text, directory: 'CACHE', encoding: 'utf8' });
        shareUri = c.uri;
      } catch (e) { note('export-cache', e); }
    }
    state.exports.push({ name: finalName, saved: !!savedUri, place: place, uri: shareUri, bytes: text.length });
    if (!shareUri) {
      showDialog('تعذر حفظ الملف', csv ? 'ما قدرت أحفظ الملف على الجهاز. تأكد إن فيه مساحة كافية وحاول مرة ثانية.' : 'ما قدرت أحفظ النسخة على الجهاز. تأكد إن فيه مساحة كافية وحاول مرة ثانية.', [{ label: 'حسنًا', primary: true }]);
      return;
    }
    var share = function () {
      Share.share({ title: finalName, files: [shareUri], dialogTitle: T(csv ? 'مشاركة ملف Excel' : 'حفظ النسخة الاحتياطية') }).catch(function (e) {
        if (!/cancel/i.test(String(e && e.message))) note('share', e);
      });
    };
    if (savedUri && csv) {
      showDialog('تم حفظ ملف Excel',
        'انحفظ في جوالك داخل:\n' + place + '\n' + finalName +
        '\n\nتقدر تفتحه بـ Excel أو Google Sheets، أو ترسله لنفسك.',
        [{ label: 'إرسال / فتح', primary: true, action: share, id: 'gt-share-btn' }, { label: 'تم', id: 'gt-done-btn' }]);
    } else if (csv) {
      showDialog('الملف جاهز', 'اختر وين ترسله أو تفتحه من القائمة اللي بتطلع لك.',
        [{ label: 'إرسال / فتح', primary: true, action: share, id: 'gt-share-btn' }, { label: 'إلغاء', id: 'gt-done-btn' }]);
    } else if (savedUri) {
      showDialog('تم حفظ النسخة الاحتياطية',
        'انحفظت في جوالك داخل:\n' + place + '\n' + finalName +
        '\n\nوقت الاستيراد: اضغط ☰ في منتقي الملفات واختر التنزيلات ثم GymTracker.' +
        '\n\nللأمان أكثر أرسلها لـ Google Drive أو لنفسك في واتساب، عشان ما تضيع لو ضاع الجوال.',
        [{ label: 'إرسال / حفظ في Drive', primary: true, action: share, id: 'gt-share-btn' }, { label: 'تم', id: 'gt-done-btn' }]);
    } else {
      showDialog('النسخة جاهزة', 'اختر مكان الحفظ (Drive أو الملفات أو واتساب) من القائمة اللي بتطلع لك.',
        [{ label: 'اختيار مكان الحفظ', primary: true, action: share, id: 'gt-share-btn' }, { label: 'إلغاء', id: 'gt-done-btn' }]);
    }
  }
  // v1.38: the session summary image goes straight to the share sheet (WhatsApp, Instagram, gallery…)
  async function shareImage(blobUrl, filename) {
    var uri = null;
    try {
      var buf = new Uint8Array(await (await fetch(blobUrl)).arrayBuffer());
      var bin = '';
      for (var i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      var r = await Filesystem.writeFile({ path: 'share/' + filename, data: btoa(bin), directory: 'CACHE', recursive: true });
      uri = r.uri;
      state.exports.push({ name: filename, saved: false, place: 'cache', uri: uri, bytes: buf.length, image: true });
    } catch (e) {
      note('share-image', e);
      showDialog('تعذر تجهيز الصورة', 'صار خطأ أثناء تجهيز صورة الجلسة. حاول مرة ثانية.', [{ label: 'حسنًا', primary: true }]);
      return;
    }
    try { await Share.share({ title: 'Gym Tracker', files: [uri], dialogTitle: T('شارك ملخص الجلسة') }); }
    catch (e) { if (!/cancel/i.test(String(e && e.message))) note('share', e); }
  }
  var originalClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    var name = this.getAttribute('download');
    var href = this.href || '';
    if (name && href.indexOf('blob:') === 0 && Filesystem && /\.png$/i.test(name)) { shareImage(href, name); return; }
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
        id: 'rest-timer', name: T('مؤقت الراحة'), description: T('تنبيه لما يخلص وقت الراحة بين الجولات'),
        importance: 5, visibility: 1, vibration: true, lights: true, lightColor: '#C8322A'
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
    if (GymNative) GymNative.cancelRestCountdown().catch(function () {});
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
        title: T('انتهى وقت الراحة'),
        body: T('حان وقت الجولة التالية' + (d.name ? ' — ' + d.name : '')),
        channelId: 'rest-timer',
        schedule: { at: new Date(d.endsAt), allowWhileIdle: true }
      }] });
      state.notifications.push({ at: d.endsAt, scheduledAt: Date.now() });
    } catch (e) { note('schedule', e); }
    // عداد تنازلي في شريط الإشعارات وشاشة القفل لين يخلص الوقت
    if (GymNative) {
      try { var r = await GymNative.restCountdown({ endsAt: d.endsAt, title: T('الراحة'), text: d.name ? T(d.name) : '' }); state.countdown = { endsAt: d.endsAt, shown: !!(r && r.shown) }; }
      catch (e) { note('countdown', e); }
    }
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
        hasPermission(true).then(function (ok) { if (ok) exactHintOnce(); });
      }
      return result;
    };
    Storage.prototype.removeItem = function (k) {
      var result = originalRemove.apply(this, arguments);
      // في الخلفية المؤقت يخلص لحاله (والإشعار هو التنبيه)، فلا نلغيه. نلغيه بس لو المستخدم أوقفه وهو داخل التطبيق.
      if (k === KEY && this === window.localStorage && !document.hidden) cancelRest();
      return result;
    };
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) onBackground(); else cancelRest();
    });
  }

  /* ---------- 6) إذن التنبيه على الثانية (المنبّهات والتذكيرات) ---------- */
  var LS_EXACT_HINT = 'gt_exact_hint_shown';
  var exactCard = null;
  async function exactAllowed() {
    if (!LocalNotifications || !LocalNotifications.checkExactNotificationSetting) return true;
    try { return (await LocalNotifications.checkExactNotificationSetting()).exact_alarm === 'granted'; }
    catch (e) { note('exact-check', e); return true; }
  }
  function openExactSettings() {
    // يفتح صفحة الإذن لهذا التطبيق بالذات في إعدادات أندرويد، ويرجع لنا لما يضغط رجوع
    return LocalNotifications.changeExactNotificationSetting().then(function (r) {
      var on = r && r.exact_alarm === 'granted';
      state.exact = on;
      renderExact(on);
      if (on && window.GymApp && GymApp.showToast) GymApp.showToast('تمام، تنبيه الراحة صار يجي على الثانية ✓');
    }).catch(function (e) { note('exact-open', e); });
  }
  async function exactHintOnce() {
    try { if (localStorage.getItem(LS_EXACT_HINT)) return; } catch (e) { return; }
    if (await exactAllowed()) return;
    try { localStorage.setItem(LS_EXACT_HINT, '1'); } catch (e) {}
    showDialog('تنبيه الراحة والجوال مقفول',
      'عشان يجيك تنبيه نهاية الراحة على الثانية حتى والشاشة مقفولة، فعّل «المنبّهات والتذكيرات» لـ Gym Tracker.\n\n' +
      'بدونه التنبيه يجيك برضو، بس ممكن يتأخر شوي. والعداد اللي في شاشة القفل دقيق في الحالتين.\n\n' +
      'تقدر تغيّره بعدين من البروفايل.',
      [{ label: 'تفعيل', primary: true, id: 'gt-exact-hint-on', action: openExactSettings }, { label: 'بعدين', id: 'gt-exact-hint-later' }]);
  }
  function renderExact(on) {
    if (exactCard) exactCard.hidden = !!on;
  }
  function buildExactCard() {
    var exportBtn = document.getElementById('btn-export-json');
    if (!exportBtn || document.getElementById('gt-exact-card') || !LocalNotifications || !LocalNotifications.checkExactNotificationSetting) return;
    var dataCard = exportBtn.closest('.glass-card');
    exactCard = document.createElement('div');
    exactCard.className = 'glass-card p-4 space-y-3'; exactCard.id = 'gt-exact-card'; exactCard.hidden = true;
    var h = document.createElement('h3'); h.className = 'font-bold text-xs text-slate-300'; h.textContent = 'تنبيه نهاية الراحة';
    var p = document.createElement('p'); p.className = 'text-xs text-slate-400'; p.id = 'gt-exact-msg';
    p.textContent = 'إذن «المنبّهات والتذكيرات» مطفي، فممكن يتأخر التنبيه شوي والجوال مقفول. فعّله عشان يجيك على الثانية.';
    var b = document.createElement('button'); b.type = 'button'; b.id = 'gt-exact-on';
    b.className = 'w-full py-2 px-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold text-xs border border-slate-700 flex items-center justify-center gap-2';
    b.textContent = 'تفعيل التنبيه على الثانية';
    b.addEventListener('click', openExactSettings);
    exactCard.append(h, p, b);
    dataCard.parentNode.insertBefore(exactCard, dataCard);
    refreshExact();
  }
  function refreshExact() { exactAllowed().then(function (on) { state.exact = on; renderExact(on); }); }
  if (LocalNotifications) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', buildExactCard); else buildExactCard();
    document.addEventListener('visibilitychange', function () { if (!document.hidden && exactCard) refreshExact(); });
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
