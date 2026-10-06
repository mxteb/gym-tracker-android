#!/usr/bin/env bash
# Copies the website into www/ and loads the Android layer before the app scripts.
set -euo pipefail
SITE="${1:-site}"
rm -rf www && mkdir -p www
# everything the site serves, except its tests, git files and the service worker (not used inside the app)
( cd "$SITE" && find . -type f ! -path './.git/*' ! -path './.github/*' ! -path './tests/*' ! -name 'sw.js' ! -name '*.md' -print0 ) |
  while IFS= read -r -d '' f; do mkdir -p "www/$(dirname "$f")"; cp "$SITE/$f" "www/$f"; done
for f in index.html app.js data.js storage.js styles.css manifest.json; do test -f "www/$f" || { echo "missing $f"; exit 1; }; done
cp native-bridge.js native-backup.js native-updates.js www/
cp release-notes.md www/whats-new.txt
python3 - <<'PY'
p = 'www/index.html'
s = open(p, encoding='utf-8').read()
tag = '<script src="./storage.js" defer></script>'
assert s.count(tag) == 1, 'storage.js script tag not found exactly once'
s = s.replace(tag, '<script src="./native-bridge.js"></script>\n    <script src="./native-backup.js"></script>\n    <script src="./native-updates.js"></script>\n    ' + tag)
icon = '<link rel="apple-touch-icon" href="./assets/icon-192.png">'
assert s.count(icon) == 1, 'icon link not found'
s = s.replace(icon, icon + '\n    <link rel="icon" href="./assets/icon-192.png">')
open(p, 'w', encoding='utf-8').write(s)
PY
grep -q 'native-bridge.js' www/index.html
echo "www ready: $(ls www | tr '\n' ' ')"
