# Gym Tracker — Android

تطبيق أندرويد (Capacitor WebView) لموقع [Gym Tracker Pro](https://mxteb.github.io/gym-tracker/).
ملفات الموقع تنضم داخل التطبيق، فيشتغل بدون إنترنت.

## تنزيل الـ APK
Actions ← آخر تشغيل لـ **Build Android APK** ← تحت Artifacts نزّل **GymTracker-APK**، فك الضغط وثبّت `GymTracker.apk`.

## تحديث التطبيق بعد تعديل الموقع
Actions ← Build Android APK ← **Run workflow**. البناء يسحب آخر نسخة من ريبو gym-tracker.
التحديث ينثبت فوق القديم وبياناتك تبقى (نفس مفتاح التوقيع `debug.keystore`).
