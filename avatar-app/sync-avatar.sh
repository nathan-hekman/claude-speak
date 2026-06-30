#!/usr/bin/env bash
#
# Refresh the vendored Claudette avatar (3D head, lip-sync, look/feel settings, the GLB
# models, and three.js) from the claudette repo into this app. Run it whenever you improve
# the avatar over in claudette, then rebuild the app (npm run dist).
#
# The avatar source path defaults to ~/Documents/Other Projects/claudette; override with
#   CLAUDETTE_REPO=/path/to/claudette ./sync-avatar.sh
#
# Bash 3.2 compatible (macOS default).

set -e
SRC="${CLAUDETTE_REPO:-$HOME/Documents/Other Projects/claudette}/pwa/static"
DST="$(cd "$(dirname "$0")" && pwd)/renderer"

[ -d "$SRC" ] || { echo "claudette static dir not found: $SRC"; echo "set CLAUDETTE_REPO to your claudette checkout."; exit 1; }
mkdir -p "$DST/cc" "$DST/vendor"

echo "from: $SRC"
echo "to:   $DST"

echo "avatar modules:"
for f in avatar-ascii3d-loader.js avatar-ascii3d-module.js avatar-head3d.js \
         ascii-render-classic.js ascii-render-blocks.js avatar-settings.js avatar-bg.js; do
  cp "$SRC/cc/$f" "$DST/cc/$f" && echo "  cc/$f"
done

echo "three.js:"
cp "$SRC/vendor/three.module.js" "$DST/vendor/three.module.js" && echo "  three.module.js"
cp "$SRC/vendor/three.core.js"   "$DST/vendor/three.core.js"   && echo "  three.core.js"
rm -rf "$DST/vendor/three-addons"
cp -R "$SRC/vendor/three-addons" "$DST/vendor/three-addons"     && echo "  three-addons/"

echo "models (the avatar GLBs — A, B, and the fallback):"
for g in model6.glb model4.glb avatar-clean.glb; do
  cp "$SRC/vendor/$g" "$DST/vendor/$g" && echo "  $g ($(du -h "$DST/vendor/$g" | cut -f1))"
done

echo
echo "done. rebuild the app with:  npm run dist"
