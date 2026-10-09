package com.mxteb.gymtracker;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.view.Window;
import android.os.Build;
import android.view.HapticFeedbackConstants;
import android.view.View;
import android.view.WindowManager;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Gym Tracker — أشياء أندرويد الصغيرة اللي ما لها إضافة جاهزة:
 *  keepAwake    الشاشة ما تنطفي أثناء الجلسة (FLAG_KEEP_SCREEN_ON على نافذة التطبيق فقط).
 *  haptic       اهتزاز خفيف من نظام الجوال نفسه (يحترم إعداد "اللمس والاهتزاز" عند المستخدم).
 *  restCountdown  إشعار صامت فيه عداد تنازلي يظهر في شريط الإشعارات وشاشة القفل، ويختفي لحاله لما يخلص الوقت.
 *                 v1.39: فيه زر «كرر: 60 كجم × 8» يفتح التطبيق ويحفظ نفس الجولة (الحدث notificationAction).
 */
@CapacitorPlugin(name = "GymNative")
public class GymNativePlugin extends Plugin {
    static final String CHANNEL = "rest-countdown";
    static final int COUNTDOWN_ID = 7002;
    static final String EXTRA_ACTION = "gt_action", EXTRA_EX = "gt_ex";

    @Override
    public void load() {
        // the app was closed and the repeat button started it: the web listener picks this up when it registers
        deliverAction(getActivity().getIntent());
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        deliverAction(intent);
    }

    private void deliverAction(Intent intent) {
        if (intent == null || !"repeat".equals(intent.getStringExtra(EXTRA_ACTION))) return;
        JSObject data = new JSObject();
        data.put("action", "repeat");
        data.put("exerciseId", intent.getStringExtra(EXTRA_EX));
        data.put("at", System.currentTimeMillis());
        intent.removeExtra(EXTRA_ACTION); // never twice for the same tap (rotation, back and forth)
        NotificationManagerCompat.from(getContext()).cancel(COUNTDOWN_ID);
        notifyListeners("notificationAction", data, true);
    }

    @PluginMethod
    public void keepAwake(PluginCall call) {
        final boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        getActivity().runOnUiThread(() -> {
            if (on) getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            JSObject ret = new JSObject();
            ret.put("on", on);
            call.resolve(ret);
        });
    }

    /** حالة علم النافذة نفسه (مو المحسوب من العناصر). للاختبارات: أدوات المطور في WebView تمسك الشاشة بنفسها وقت الاتصال. */
    @PluginMethod
    public void keepAwakeState(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            boolean on = (getActivity().getWindow().getAttributes().flags & WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) != 0;
            JSObject ret = new JSObject();
            ret.put("on", on);
            call.resolve(ret);
        });
    }

    /** لون شريط الساعة فوق وشريط التنقل تحت حسب الثيم، وأيقوناتهم غامقة في الثيم الفاتح. */
    @PluginMethod
    public void setBars(PluginCall call) {
        final String color = call.getString("color", "#121212");
        final boolean light = Boolean.TRUE.equals(call.getBoolean("light", false));
        getActivity().runOnUiThread(() -> {
            try {
                int c = Color.parseColor(color);
                Window w = getActivity().getWindow();
                w.setStatusBarColor(c);
                w.setNavigationBarColor(c);
                w.getDecorView().setBackgroundColor(c);
                WindowInsetsControllerCompat ctl = new WindowInsetsControllerCompat(w, w.getDecorView());
                ctl.setAppearanceLightStatusBars(light);
                ctl.setAppearanceLightNavigationBars(light);
                JSObject ret = new JSObject();
                ret.put("color", color);
                ret.put("light", light);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("bad color: " + color);
            }
        });
    }

    @PluginMethod
    public void haptic(PluginCall call) {
        String kind = call.getString("kind", "tap");
        int constant = HapticFeedbackConstants.VIRTUAL_KEY;
        if ("long".equals(kind)) constant = HapticFeedbackConstants.LONG_PRESS;
        else if ("confirm".equals(kind)) constant = Build.VERSION.SDK_INT >= 30 ? HapticFeedbackConstants.CONFIRM : HapticFeedbackConstants.LONG_PRESS;
        final int feedback = constant;
        getActivity().runOnUiThread(() -> {
            View view = getBridge().getWebView();
            boolean done = view != null && view.performHapticFeedback(feedback);
            JSObject ret = new JSObject();
            ret.put("performed", done);
            call.resolve(ret);
        });
    }

    @PluginMethod
    public void restCountdown(PluginCall call) {
        Long endsAt = call.getLong("endsAt");
        if (endsAt == null) { call.reject("endsAt is required"); return; }
        long left = endsAt - System.currentTimeMillis();
        Context ctx = getContext();
        if (left <= 1000) { NotificationManagerCompat.from(ctx).cancel(COUNTDOWN_ID); call.resolve(); return; }

        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26 && nm != null && nm.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "عداد الراحة", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("العداد التنازلي للراحة في شريط الإشعارات وشاشة القفل");
            ch.setShowBadge(false);
            ch.setSound(null, null);
            ch.enableVibration(false);
            ch.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            nm.createNotificationChannel(ch);
        }

        Intent open = ctx.getPackageManager().getLaunchIntentForPackage(ctx.getPackageName());
        PendingIntent pi = null;
        if (open != null) {
            open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED);
            pi = PendingIntent.getActivity(ctx, COUNTDOWN_ID, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        }
        int icon = ctx.getResources().getIdentifier("ic_stat_timer", "drawable", ctx.getPackageName());
        if (icon == 0) icon = ctx.getApplicationInfo().icon;

        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CHANNEL)
            .setSmallIcon(icon)
            .setColor(0xFFC8322A)
            .setContentTitle(call.getString("title", "الراحة"))
            .setContentText(call.getString("text", ""))
            .setWhen(endsAt)
            .setShowWhen(true)
            .setUsesChronometer(true)
            .setChronometerCountDown(true)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setTimeoutAfter(left)
            .setCategory(NotificationCompat.CATEGORY_STOPWATCH)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setPriority(NotificationCompat.PRIORITY_LOW);
        if (pi != null) b.setContentIntent(pi);
        String repeat = call.getString("repeat", null);
        Intent launch = ctx.getPackageManager().getLaunchIntentForPackage(ctx.getPackageName());
        if (repeat != null && !repeat.isEmpty() && launch != null) {
            launch.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            launch.putExtra(EXTRA_ACTION, "repeat");
            launch.putExtra(EXTRA_EX, call.getString("exerciseId", ""));
            PendingIntent repeatPi = PendingIntent.getActivity(ctx, COUNTDOWN_ID + 1, launch, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            b.addAction(0, repeat, repeatPi);
        }
        try {
            NotificationManagerCompat.from(ctx).notify(COUNTDOWN_ID, b.build());
            JSObject ret = new JSObject();
            ret.put("shown", true);
            call.resolve(ret);
        } catch (SecurityException e) {
            JSObject ret = new JSObject();
            ret.put("shown", false);
            call.resolve(ret);
        }
    }

    @PluginMethod
    public void cancelRestCountdown(PluginCall call) {
        NotificationManagerCompat.from(getContext()).cancel(COUNTDOWN_ID);
        call.resolve();
    }
}
