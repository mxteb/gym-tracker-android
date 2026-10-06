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
    '<uses-permission android:name="android.permission.USE_EXACT_ALARM" />',
    '<uses-permission android:name="android.permission.SCHEDULE_EXACT_ALARM" android:maxSdkVersion="32" />',
    '<uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="29" />',
    '<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="29" />',
]
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
    '\n        <item name="android:windowOptOutEdgeToEdgeEnforcement">true</item>',
])
s, n = re.subn(r'(<style name="AppTheme\.NoActionBar"[^>]*>)', lambda mm: mm.group(1) + bars, s, count=1)
must(n == 1, 'AppTheme.NoActionBar style')
s, n = re.subn(r'(<style name="AppTheme\.NoActionBarLaunch"[^>]*>)',
               lambda mm: mm.group(1) + '\n        <item name="windowSplashScreenBackground">#FF121212</item>'
               '\n        <item name="android:statusBarColor">#FF121212</item>'
               '\n        <item name="android:navigationBarColor">#FF121212</item>', s, count=1)
must(n == 1, 'AppTheme.NoActionBarLaunch style')
write(styles_path, s)

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
    g, n = re.subn(r'(release\s*\{\s*\n\s*minifyEnabled false)', r'\1\n            signingConfig signingConfigs.debug', g, count=1)
    print('signing: repository debug key (add the GT_KEYSTORE_B64 secret to switch)')
must(n == 1, 'release signing')
write(gradle_path, g)

# 4) Notification icon
dst = os.path.join(MAIN, 'res', 'drawable')
os.makedirs(dst, exist_ok=True)
shutil.copy(os.path.join(ROOT, 'android-res', 'drawable', 'ic_stat_timer.xml'), dst)

print('patched: manifest, styles, gradle (versionCode %d), notification icon' % BUILD_NUMBER)
