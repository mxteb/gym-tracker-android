"""Patches the generated Capacitor Android project. Fails loudly if any patch doesn't apply."""
import os, re, shutil, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP = os.path.join(ROOT, 'android', 'app')
MAIN = os.path.join(APP, 'src', 'main')
BUILD_NUMBER = int(os.environ.get('BUILD_NUMBER', '1'))


def read(p):
    with open(p, encoding='utf-8') as f:
        return f.read()


def write(p, s):
    with open(p, 'w', encoding='utf-8') as f:
        f.write(s)


def must(cond, msg):
    if not cond:
        sys.exit('PATCH FAILED: ' + msg)


# 1) AndroidManifest: permissions, portrait, legacy storage for Android 10
manifest_path = os.path.join(MAIN, 'AndroidManifest.xml')
m = read(manifest_path)
perms = [
    '<uses-permission android:name="android.permission.VIBRATE" />',
    '<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />',
    # P2: no USE_EXACT_ALARM (Play allows it only for alarm/timer/calendar apps). SCHEDULE_EXACT_ALARM is
    # granted by the user from Settings ("Alarms & reminders"); without it the rest alert still comes, maybe a bit late.
    '<uses-permission android:name="android.permission.SCHEDULE_EXACT_ALARM" />',
    '<uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="29" />',
    '<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="29" />',
]
for name in ['android.permission.USE_EXACT_ALARM']:
    m = re.sub(r'\s*<uses-permission[^>]*android:name="%s"[^>]*/>' % re.escape(name), '', m)
for p in perms:
    name = re.search(r'android:name="([^"]+)"', p).group(1)
    m = re.sub(r'\s*<uses-permission[^>]*android:name="%s"[^>]*/>' % re.escape(name), '', m)
must('</manifest>' in m, 'manifest end tag')
m = m.replace('</manifest>', '    ' + '\n    '.join(perms) + '\n</manifest>')
m, n = re.subn(r'<application\b', '<application\n        android:requestLegacyExternalStorage="true"', m, count=1)
must(n == 1, 'application tag')
m, n = re.subn(r'(<activity\b)', r'\1\n            android:screenOrientation="portrait"', m, count=1)
must(n == 1, 'activity tag')
write(manifest_path, m)

# 2) Theme: dark status/navigation bars, dark window background, no white flash, no edge-to-edge overlap
styles_path = os.path.join(MAIN, 'res', 'values', 'styles.xml')
s = read(styles_path)
bars = ''.join([
    '\n        <item name="android:windowBackground">#FF121212</item>',
    '\n        <item name="android:statusBarColor">#FF121212</item>',
    '\n        <item name="android:navigationBarColor">#FF121212</item>',
    '\n        <item name="android:windowLightStatusBar">false</item>',
    '\n        <item name="android:windowLightNavigationBar">false</item>',
    # Android 15: keep the old layout (bars outside the app). Android 16 ignores this for apps targeting 36,
    # so there the value is false and Capacitor ("adjustMarginsForEdgeToEdge": "auto") keeps the page off the bars.
    '\n        <item name="android:windowOptOutEdgeToEdgeEnforcement">@bool/gt_edge_opt_out</item>',
    '\n        <item name="android:enforceNavigationBarContrast">false</item>',
])
s, n = re.subn(r'(<style name="AppTheme\.NoActionBar"[^>]*>)', lambda mm: mm.group(1) + bars, s, count=1)
must(n == 1, 'AppTheme.NoActionBar style')
s, n = re.subn(r'(<style name="AppTheme\.NoActionBarLaunch"[^>]*>)',
               lambda mm: mm.group(1) + '\n        <item name="windowSplashScreenBackground">#FF121212</item>'
               '\n        <item name="android:statusBarColor">#FF121212</item>'
               '\n        <item name="android:navigationBarColor">#FF121212</item>', s, count=1)
must(n == 1, 'AppTheme.NoActionBarLaunch style')
write(styles_path, s)
for folder, value in (('values', 'true'), ('values-v36', 'false')):
    os.makedirs(os.path.join(MAIN, 'res', folder), exist_ok=True)
    write(os.path.join(MAIN, 'res', folder, 'gt_bools.xml'),
          '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <bool name="gt_edge_opt_out">%s</bool>\n</resources>\n' % value)

# 2b) P3: target Android 16 (API 36), required by Google Play for new apps
ANDROID_DIR = os.path.dirname(APP)
vars_path = os.path.join(ANDROID_DIR, 'variables.gradle')
v = read(vars_path)
v, n1 = re.subn(r'compileSdkVersion\s*=\s*\d+', 'compileSdkVersion = 36', v)
v, n2 = re.subn(r'targetSdkVersion\s*=\s*\d+', 'targetSdkVersion = 36', v)
must(n1 == 1 and n2 == 1, 'variables.gradle sdk versions')
write(vars_path, v)
root_gradle = os.path.join(ANDROID_DIR, 'build.gradle')
r = read(root_gradle)
# compileSdk 36 needs a newer Android Gradle Plugin than Capacitor 7's template (8.7.2); 8.10 still runs on its Gradle 8.11.1
r, n = re.subn(r"com\.android\.tools\.build:gradle:[\d.]+", 'com.android.tools.build:gradle:8.10.1', r)
must(n == 1, 'android gradle plugin version')
write(root_gradle, r)

# 3) Gradle: version number from the build, release build signed with the repo key (same key every build)
gradle_path = os.path.join(APP, 'build.gradle')
g = read(gradle_path)
g, n = re.subn(r'versionCode\s+\d+', 'versionCode %d' % BUILD_NUMBER, g, count=1)
must(n == 1, 'versionCode')
g, n = re.subn(r'versionName\s+"[^"]*"', 'versionName "1.%d"' % BUILD_NUMBER, g, count=1)
must(n == 1, 'versionName')
if os.environ.get('GT_KEYSTORE'):
    # private key from the repository secret; passwords stay in environment variables, never in files
    g, n = re.subn(r'(\n\s*buildTypes\s*\{)', '''
    signingConfigs {
        gymtracker {
            storeFile file(System.getenv("GT_KEYSTORE"))
            storePassword System.getenv("GT_KEYSTORE_PASSWORD")
            keyAlias System.getenv("GT_KEY_ALIAS") ?: "gymtracker"
            keyPassword System.getenv("GT_KEYSTORE_PASSWORD")
        }
    }\\1''', g, count=1)
    must(n == 1, 'signingConfigs block')
    g, n = re.subn(r'(release\s*\{\s*\n\s*minifyEnabled false)', r'\1\n            signingConfig signingConfigs.gymtracker', g, count=1)
    print('signing: private key from secret')
else:
    sys.exit('PATCH FAILED: no signing key. Add the GT_KEYSTORE_B64 and GT_KEYSTORE_PASSWORD secrets '
             '(a build signed with any other key could not update the installed app).')
must(n == 1, 'release signing')
write(gradle_path, g)

# 4) Notification icon
dst = os.path.join(MAIN, 'res', 'drawable')
os.makedirs(dst, exist_ok=True)
shutil.copy(os.path.join(ROOT, 'android-res', 'drawable', 'ic_stat_timer.xml'), dst)

# 5) Our small native plugin (keep screen on, haptics, lock-screen rest countdown) + register it in MainActivity
java_dir = os.path.join(MAIN, 'java', 'com', 'mxteb', 'gymtracker')
must(os.path.isdir(java_dir), 'java package folder')
shutil.copy(os.path.join(ROOT, 'android-src', 'GymNativePlugin.java'), java_dir)
act_path = os.path.join(java_dir, 'MainActivity.java')
a = read(act_path)
must('registerPlugin(GymNativePlugin.class)' not in a, 'MainActivity already patched')
a, n = re.subn(r'public class MainActivity extends BridgeActivity\s*\{\s*\}',
               'public class MainActivity extends BridgeActivity {\n'
               '    @Override\n'
               '    public void onCreate(android.os.Bundle savedInstanceState) {\n'
               '        registerPlugin(GymNativePlugin.class);\n'
               '        super.onCreate(savedInstanceState);\n'
               '    }\n'
               '}', a, count=1)
must(n == 1, 'MainActivity body (expected an empty BridgeActivity)')
write(act_path, a)

print('patched: manifest, styles, gradle (versionCode %d), notification icon, GymNative plugin' % BUILD_NUMBER)
