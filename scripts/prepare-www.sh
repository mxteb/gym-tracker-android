#!/usr/bin/env bash
# Copies the website into www/ and loads the Android layer before the app scripts.
# Usage: prepare-www.sh <site dir> [github|play]
#   github (default): the APK published on GitHub, with the "new version available" check.
#   play: the Google Play build. No self-update code at all (Play policy), Play updates it.
set -euo pipefail
SITE="${1:-site}"
DIST="${2:-github}"
case "$DIST" in github|play) ;; *) echo "unknown variant: $DIST"; exit 1 ;; esac
rm -rf www && mkdir -p www
# everything the site serves, except its tests, git files and the service worker (not used inside the app)
( cd "$SITE" && find . -type f ! -path './.git/*' ! -path './.github/*' ! -path './tests/*' ! -name 'sw.js' ! -name '*.md' -print0 ) |
  while IFS= read -r -d '' f; do mkdir -p "www/$(dirname "$f")"; cp "$SITE/$f" "www/$f"; done
for f in index.html app.js data.js storage.js styles.css manifest.json; do test -f "www/$f" || { echo "missing $f"; exit 1; }; done
cp native-en.js native-bridge.js native-backup.js native-whatsnew.js www/
if [ "$DIST" = github ]; then cp native-updates.js www/; fi
cp release-notes.md www/whats-new.txt
cp release-notes.en.md www/whats-new.en.txt
DIST="$DIST" python3 - <<'PY'
import os
p = 'www/index.html'
s = open(p, encoding='utf-8').read()
tag = '<script src="./storage.js" defer></script>'
assert s.count(tag) == 1, 'storage.js script tag not found exactly once'
layer = ['native-en.js', 'native-bridge.js', 'native-backup.js', 'native-whatsnew.js'] + (['native-updates.js'] if os.environ['DIST'] == 'github' else [])
s = s.replace(tag, ''.join('<script src="./%s"></script>\n    ' % f for f in layer) + tag)
icon = '<link rel="apple-touch-icon" href="./assets/icon-192.png">'
assert s.count(icon) == 1, 'icon link not found'
s = s.replace(icon, icon + '\n    <link rel="icon" href="./assets/icon-192.png">')
open(p, 'w', encoding='utf-8').write(s)
PY
grep -q 'native-bridge.js' www/index.html
if [ "$DIST" = play ]; then
  # the Play build must not contain any self-update code
  if grep -rq 'native-updates\|releases/latest' www; then echo "play build still has the GitHub updater"; exit 1; fi
fi
echo "www ($DIST) ready: $(ls www | tr '\n' ' ')"
