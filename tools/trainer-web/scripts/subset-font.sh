#!/usr/bin/env bash
# Rebuild the Iosevka Extended subset (Latin-1 + Cyrillic) in src/fonts/ (needs fonttools + brotli:
#   pip install fonttools brotli). Keeps Latin-1, general punctuation, arrows and every
# other non-ASCII character used in index.html / src/*.js; drops ligatures and hinting.
#
# Fontsource ships only the normal width, so the source is the official release:
#   gh release download -R be5invis/Iosevka -p 'PkgTTF-Unhinted-Iosevka-*.zip'
#   unzip PkgTTF-Unhinted-Iosevka-*.zip Iosevka-Extended.ttf Iosevka-ExtendedSemiBold.ttf -d <dir>
#   scripts/subset-font.sh <dir>
set -euo pipefail
TTF="$(cd "${1:?usage: subset-font.sh <dir with Iosevka-Extended*.ttf>}" && pwd)"
cd "$(dirname "$0")/.."
PY="${PYTHON:-python}"
"$PY" - <<'EOF'
import pathlib
txt = pathlib.Path("index.html").read_text(encoding="utf-8") + "".join(p.read_text(encoding="utf-8") for p in pathlib.Path("src").glob("*.js"))
pathlib.Path("src/fonts/.chars.txt").write_text("".join(sorted({c for c in txt if ord(c) > 126})), encoding="utf-8")
EOF
UNI="U+0020-007E,U+00A0-00FF,U+0400-045F,U+2116,U+2010-2027,U+2030-203A,U+2190-2199,U+21BB,U+2212,U+2215,U+2318"
for pair in "400 Iosevka-Extended" "600 Iosevka-ExtendedSemiBold"; do
  set -- $pair
  "$PY" -m fontTools.subset "$TTF/$2.ttf" --unicodes="$UNI" --text-file=src/fonts/.chars.txt \
    --layout-features=kern --flavor=woff2 --no-hinting --desubroutinize --output-file="src/fonts/iosevka-ext-$1.woff2"
done
rm -f src/fonts/.chars.txt
ls -la src/fonts
