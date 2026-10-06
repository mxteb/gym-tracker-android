#!/usr/bin/env bash
# Copies the website into www/ and loads the Android layer before the app scripts.
set -euo pipefail
SITE="${1:-site}"
rm -rf www && mkdir -p www
cp "$SITE"/index.html "$SITE"/app.js "$SITE"/data.js "$SITE"/storage.js "$SITE"/styles.css "$SITE"/manifest.json www/
cp -r "$SITE"/assets www/
cp native-bridge.js www/
python3 - <<'PY'
p = 'www/index.html'
s = open(p, encoding='utf-8').read()
tag = '<script src="./storage.js" defer></script>'
assert s.count(tag) == 1, 'storage.js script tag not found exactly once'
s = s.replace(tag, '<script src="./native-bridge.js"></script>\n    ' + tag)
icon = '<link rel="apple-touch-icon" href="./assets/icon-192.png">'
assert s.count(icon) == 1, 'icon link not found'
s = s.replace(icon, icon + '\n    <link rel="icon" href="./assets/icon-192.png">')
open(p, 'w', encoding='utf-8').write(s)
PY
grep -q 'native-bridge.js' www/index.html
echo "www ready: $(ls www | tr '\n' ' ')"
