#!/usr/bin/env bash
# Rebuild the Iosevka subset in src/fonts/ (needs Python with fonttools + brotli:
#   pip install fonttools brotli). Keeps Latin-1, general punctuation, arrows and every
# other non-ASCII character used in index.html / src/*.js; drops ligatures and hinting.
set -euo pipefail
cd "$(dirname "$0")/.."
PY="${PYTHON:-python}"
SRC=node_modules/@fontsource/iosevka/files
"$PY" - <<'EOF'
import pathlib
txt = pathlib.Path("index.html").read_text(encoding="utf-8") + "".join(p.read_text(encoding="utf-8") for p in pathlib.Path("src").glob("*.js"))
pathlib.Path("src/fonts/.chars.txt").write_text("".join(sorted({c for c in txt if ord(c) > 126})), encoding="utf-8")
EOF
UNI="U+0020-007E,U+00A0-00FF,U+2010-2027,U+2030-203A,U+2190-2199,U+21BB,U+2212,U+2215,U+2318"
for w in 400 600; do
  "$PY" -m fontTools.subset "$SRC/iosevka-latin-$w-normal.woff2" --unicodes="$UNI" --text-file=src/fonts/.chars.txt \
    --layout-features=kern --flavor=woff2 --no-hinting --desubroutinize --output-file="src/fonts/iosevka-$w.woff2"
done
rm -f src/fonts/.chars.txt
cp node_modules/@fontsource/iosevka/LICENSE src/fonts/OFL-iosevka.txt
ls -la src/fonts
