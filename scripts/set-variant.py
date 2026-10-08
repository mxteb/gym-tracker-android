"""Switches the generated Android project between the two builds. Run after patch-android.py.

  github  the APK on GitHub Releases. Needs internet only for the "new version available" check.
  play    the Google Play build. No internet permission at all (M1): the app works fully offline,
          so nothing can leave the phone, even by mistake. Every library's INTERNET request is removed too.
"""
import os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MANIFEST = os.path.join(ROOT, 'android', 'app', 'src', 'main', 'AndroidManifest.xml')
variant = sys.argv[1] if len(sys.argv) > 1 else ''
if variant not in ('github', 'play'):
    sys.exit('usage: set-variant.py github|play')

with open(MANIFEST, encoding='utf-8') as f:
    m = f.read()
if 'xmlns:tools=' not in m:
    m, n = re.subn(r'<manifest\b', '<manifest xmlns:tools="http://schemas.android.com/tools"', m, count=1)
    if n != 1:
        sys.exit('SET-VARIANT FAILED: manifest tag')
m = re.sub(r'\s*<uses-permission[^>]*android:name="android\.permission\.INTERNET"[^>]*/>', '', m)
line = ('<uses-permission android:name="android.permission.INTERNET" tools:node="remove" />' if variant == 'play'
        else '<uses-permission android:name="android.permission.INTERNET" />')
m = m.replace('</manifest>', '    ' + line + '\n</manifest>')
with open(MANIFEST, 'w', encoding='utf-8') as f:
    f.write(m)
print('variant:', variant)
