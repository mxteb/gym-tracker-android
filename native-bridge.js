// يشتغل فقط داخل تطبيق الأندرويد. في المتصفح ما يسوي شي.
// المشكلة: زر "تصدير" يعتمد على رابط تنزيل (blob)، وهذا ما يشتغل داخل WebView.
// الحل: نلتقط النقرة، نحفظ الملف داخل التطبيق، ونفتح قائمة المشاركة (Drive، واتساب، الملفات...).
(function () {
  var cap = window.Capacitor;
  if (!cap || !cap.isNativePlatform || !cap.isNativePlatform()) return;

  var originalClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    var href = this.href || '';
    var name = this.getAttribute('download');
    if (name && href.indexOf('blob:') === 0) {
      saveAndShare(href, name);
      return;
    }
    return originalClick.apply(this, arguments);
  };

  async function saveAndShare(blobUrl, filename) {
    try {
      var text = await (await fetch(blobUrl)).text();
      var Filesystem = cap.Plugins.Filesystem;
      var Share = cap.Plugins.Share;
      var res = await Filesystem.writeFile({
        path: filename,
        data: text,
        directory: 'CACHE',
        encoding: 'utf8'
      });
      await Share.share({ title: filename, files: [res.uri], dialogTitle: 'حفظ النسخة الاحتياطية' });
    } catch (e) {
      if (e && /cancel/i.test(String(e.message || e))) return;
      alert('تعذر حفظ الملف: ' + (e && e.message ? e.message : e));
    }
  }
})();
