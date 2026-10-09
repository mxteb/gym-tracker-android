/*
 * Gym Tracker — الإنجليزي لطبقة أندرويد (النسخ الاحتياطية، النوافذ، الإشعارات، التحديث).
 * نفس طريقة en.js في الموقع: المفتاح النص العربي كما يظهر، والقيمة الإنجليزي. ما يشتغل إلا إذا اللغة English.
 */
(function () {
  'use strict';
  if (!window.GymI18n) return;
  var t = function (s) { return GymI18n.tq(s); };
  GymI18n.add({
    /* export */
    'تعذر تجهيز الملف': "Couldn't prepare the file",
    'صار خطأ أثناء تجهيز النسخة الاحتياطية. حاول مرة ثانية.': 'Something went wrong while preparing the backup. Try again.',
    'حسنًا': 'OK',
    'تعذر حفظ الملف': "Couldn't save the file",
    'ما قدرت أحفظ النسخة على الجهاز. تأكد إن فيه مساحة كافية وحاول مرة ثانية.': "Couldn't save the backup on this phone. Make sure there is enough space and try again.",
    'حفظ النسخة الاحتياطية': 'Save backup',
    'تم حفظ النسخة الاحتياطية': 'Backup saved',
    'انحفظت في جوالك داخل:': 'Saved on your phone in:',
    'التنزيلات (Download) ← GymTracker': 'Download / GymTracker',
    'المستندات (Documents) ← GymTracker': 'Documents / GymTracker',
    'وقت الاستيراد: اضغط ☰ في منتقي الملفات واختر التنزيلات ثم GymTracker.': 'To import it later: tap ☰ in the file picker, then Downloads, then GymTracker.',
    'للأمان أكثر أرسلها لـ Google Drive أو لنفسك في واتساب، عشان ما تضيع لو ضاع الجوال.': 'To be extra safe, send it to Google Drive or to yourself on WhatsApp, so it survives losing the phone.',
    'إرسال / حفظ في Drive': 'Send / save to Drive',
    'تم': 'Done',
    'النسخة جاهزة': 'Backup ready',
    'اختر مكان الحفظ (Drive أو الملفات أو واتساب) من القائمة اللي بتطلع لك.': 'Pick where to save it (Drive, Files or WhatsApp) from the list that opens.',
    'اختيار مكان الحفظ': 'Choose where to save',
    'صار خطأ أثناء تجهيز صورة الجلسة. حاول مرة ثانية.': 'Something went wrong while making the session image. Try again.',
    'شارك ملخص الجلسة': 'Share session summary',
    'صار خطأ أثناء تجهيز الملف. حاول مرة ثانية.': 'Something went wrong while preparing the file. Try again.',
    'ما قدرت أحفظ الملف على الجهاز. تأكد إن فيه مساحة كافية وحاول مرة ثانية.': "Couldn't save the file on this phone. Make sure there is enough space and try again.",
    'مشاركة ملف Excel': 'Share Excel file',
    'تم حفظ ملف Excel': 'Excel file saved',
    'انحفظ في جوالك داخل:': 'Saved on your phone in:',
    'تقدر تفتحه بـ Excel أو Google Sheets، أو ترسله لنفسك.': 'Open it with Excel or Google Sheets, or send it to yourself.',
    'إرسال / فتح': 'Send / open',
    'الملف جاهز': 'File ready',
    'اختر وين ترسله أو تفتحه من القائمة اللي بتطلع لك.': 'Pick where to send or open it from the list that opens.',

    /* rest notification */
    'مؤقت الراحة': 'Rest timer',
    'تنبيه لما يخلص وقت الراحة بين الجولات': 'Alerts you when rest between sets is over',
    'انتهى وقت الراحة': 'Rest is over',
    'حان وقت الجولة التالية': 'Time for the next set',
    'الراحة': 'Rest',

    /* exact alarm (P2) */
    'تنبيه نهاية الراحة': 'End-of-rest alert',
    'إذن «المنبّهات والتذكيرات» مطفي، فممكن يتأخر التنبيه شوي والجوال مقفول. فعّله عشان يجيك على الثانية.': '"Alarms & reminders" is off, so the alert may come a little late while the phone is locked. Turn it on to get it right on time.',
    'تفعيل التنبيه على الثانية': 'Turn on on-time alerts',
    'تمام، تنبيه الراحة صار يجي على الثانية ✓': 'Done, the rest alert now comes right on time ✓',
    'تنبيه الراحة والجوال مقفول': 'Rest alerts on a locked phone',
    'عشان يجيك تنبيه نهاية الراحة على الثانية حتى والشاشة مقفولة، فعّل «المنبّهات والتذكيرات» لـ Gym Tracker.': 'To get the end-of-rest alert right on time even with the screen locked, turn on "Alarms & reminders" for Gym Tracker.',
    'بدونه التنبيه يجيك برضو، بس ممكن يتأخر شوي. والعداد اللي في شاشة القفل دقيق في الحالتين.': 'Without it the alert still comes, maybe a little late. The lock-screen countdown is exact either way.',
    'تقدر تغيّره بعدين من البروفايل.': 'You can change this later in the Profile.',
    'تفعيل': 'Turn on',
    'بعدين': 'Later',

    /* backups (D1–D3, M3) */
    'النسخ الاحتياطية في جوالك': 'Backups on your phone',
    'آخر نسخة': 'Last backup',
    'ما فيه نسخة محفوظة للحين. أول ما تنهي جلسة تنحفظ وحدة تلقائياً.': 'No backup yet. One is saved automatically when you finish a session.',
    'النسخ تنحفظ في التنزيلات ← GymTracker عشان تبقى حتى لو حذفت التطبيق. أي أحد يفتح ملفات جوالك يقدر يشوفها (فيها وزنك وقياساتك).': 'Backups are saved in Download/GymTracker so they survive uninstalling the app. Anyone who opens your phone\'s files can see them (they include your weight and measurements).',
    'استرجاع نسخة محفوظة': 'Restore a saved backup',
    'ذكّرني كل أسبوع أرسل نسخة لـ Drive': 'Remind me weekly to send a backup to Drive',
    'يوم التذكير': 'Reminder day',
    'ساعة التذكير': 'Reminder time',
    'التذكير يحتاج إذن الإشعارات. فعّله من إعدادات الجوال ← التطبيقات ← Gym Tracker.': 'The reminder needs notification permission. Turn it on in Settings > Apps > Gym Tracker.',
    'ما قدرت أضبط التذكير. جرّب مرة ثانية.': "Couldn't set the reminder. Try again.",
    'انحفظت نسخة احتياطية تلقائية ✓': 'Automatic backup saved ✓',
    'ما قدرت أحفظ النسخة التلقائية. صدّر نسخة يدوياً من البروفايل.': "Couldn't save the automatic backup. Export one from the Profile.",
    'تعذر فتح النسخة': "Couldn't open the backup",
    'ما قدرت أقرأ الملف. ممكن انحذف أو انتقل. جرّب «استيراد JSON» واختره من منتقي الملفات.': "Couldn't read the file. It may have been deleted or moved. Try Import JSON and pick it in the file picker.",
    'النسخ المحفوظة في جوالك': 'Backups on your phone',
    'أدور على النسخ…': 'Looking for backups…',
    'ما فيه نسخ محفوظة': 'No saved backups',
    'لما تنهي جلسة تنحفظ نسخة تلقائياً، ولما تصدّر نسخة تنحفظ هنا بعد.': 'A backup is saved automatically when you finish a session, and exported backups show here too.',
    'نسخ من نسخة قديمة من التطبيق ما تظهر هنا: افتحها من «استيراد JSON» ← ☰ ← التنزيلات ← GymTracker.': "Backups from older app versions don't show here: open them from Import JSON > ☰ > Downloads > GymTracker.",
    'تلقائية بعد جلسة': 'Automatic, after a session',
    'تصدير يدوي': 'Manual export',
    'تنضاف كل الجولات والجلسات اللي في النسخة وناقصة عندك. ما ينمسح شي من بياناتك الحالية، والمكرر ما يتكرر.': "Adds every set and session from the backup that you don't have yet. Nothing current is deleted, and nothing is duplicated.",
    'استرجاع': 'Restore',
    'رجوع': 'Back',
    'اختر النسخة اللي تبي تسترجعها (الأحدث فوق).': 'Pick the backup to restore (newest first).',
    'إغلاق': 'Close',
    'تذكير النسخة الاحتياطية': 'Backup reminder',
    'تذكير أسبوعي ترسل نسختك لـ Drive': 'Weekly reminder to send your backup to Drive',
    'وقت النسخة الاحتياطية': 'Backup time',
    'اضغط هنا وأرسل نسخة تمارينك لـ Google Drive عشان تكون بأمان.': 'Tap here to send a copy of your workouts to Google Drive and keep it safe.',
    'إرسال النسخة الاحتياطية': 'Send backup',
    'ما قدرت أجهز النسخة. صدّرها من البروفايل.': "Couldn't prepare the backup. Export it from the Profile.",
    'التطبيق ما جهز': "The app isn't ready",
    'قبل لحظات': 'just now',
    'قبل {0} دقيقة': function (n) { return n + ' min ago'; },
    'قبل {0} ساعة': function (n) { return n + (n === '1' ? ' hour ago' : ' hours ago'); },
    'قبل {0} يوم': function (n) { return n + (n === '1' ? ' day ago' : ' days ago'); },
    'أمس': 'yesterday',
    '{0} الصبح': '{0} AM',
    '{0} الظهر': '{0} PM',
    '{0} المساء': '{0} PM',

    /* updates (GitHub build) and what's new */
    'وش الجديد؟': "What's new?",
    'تحميل التحديث': 'Download update',
    'تحسينات وإصلاحات.': 'Improvements and fixes.',
    'إخفاء': 'Hide',
    'تمام': 'OK',
    'نسخة جديدة متوفرة ({0})': 'New version available ({0})',
    'التحديث {0}': 'Update {0}',
    'وش الجديد في {0}': "What's new in {0}"
  }, [
    [/^بيجيك التذكير كل (.+?) الساعة (.+)\.$/, function (d, h) { return "You'll get the reminder every " + t(d) + ' at ' + t(h) + '.'; }],
    [/^استرجاع نسخة (.+)؟$/, function (d) { return 'Restore the backup from ' + d + '?'; }],
    [/^حان وقت الجولة التالية — (.+)$/, function (n) { return 'Time for the next set: ' + t(n); }]
  ]);
})();
