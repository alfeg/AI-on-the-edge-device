#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# build-update-package.sh
#
# Builds the AI-on-the-edge-device firmware with Docker and packages it
# for OTA deployment to a running device.
#
# Usage:
#   ./tools/build-update-package.sh [OPTIONS]
#
# Options:
#   -t TAG            Docker image tag (default: ai-edge-build)
#   -o DIR            Output directory (default: <repo-root>/build-output)
#   -f                Firmware-only: zip contains only firmware.bin
#   -h                Show this help
#
# The zip produced can be uploaded directly via the device OTA page:
#   http://<device-ip>/ota
# ---------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

TAG="ai-edge-build"
OUT_DIR="$REPO_ROOT/build-output"
FIRMWARE_ONLY=0

usage() {
    grep '^#' "$0" | sed 's/^# \{0,1\}//'
    exit 0
}

while getopts ":t:o:fh" opt; do
    case $opt in
        t) TAG="$OPTARG" ;;
        o) OUT_DIR="$OPTARG" ;;
        f) FIRMWARE_ONLY=1 ;;
        h) usage ;;
        *) echo "Unknown option -$OPTARG"; usage ;;
    esac
done

ARTIFACTS_DIR="$OUT_DIR/artifacts"
ZIP_PATH="$OUT_DIR/ai-edge-update.zip"
ZIP_PATH_WITH_CFG="$OUT_DIR/ai-edge-update-with-config.zip"
STAGING_DIR="$OUT_DIR/_staging"
TMP_CONTAINER="ai-edge-tmp-$$"

echo ""
echo "=== AI-on-the-edge-device build + package ==="
echo "  Repo:       $REPO_ROOT"
echo "  Output:     $OUT_DIR"
echo "  Docker tag: $TAG"
echo "  Mode:       $([ $FIRMWARE_ONLY -eq 1 ] && echo 'firmware-only' || echo 'full')"
echo ""

# ---------------------------------------------------------------------------
# Step 1 — Docker build
# ---------------------------------------------------------------------------
echo "[1/4] Building Docker image (target: artifacts)..."
(cd "$REPO_ROOT" && docker build --target artifacts -t "$TAG" .)

# ---------------------------------------------------------------------------
# Step 2 — Extract artifacts from image
# ---------------------------------------------------------------------------
echo ""
echo "[2/4] Extracting artifacts from image..."
rm -rf "$ARTIFACTS_DIR"
mkdir -p "$ARTIFACTS_DIR"

cleanup_container() { docker rm "$TMP_CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup_container EXIT

docker create --name "$TMP_CONTAINER" "$TAG" >/dev/null
docker cp "${TMP_CONTAINER}:/artifacts/." "$ARTIFACTS_DIR"
cleanup_container
trap - EXIT

echo "  Artifacts written to: $ARTIFACTS_DIR"

# ---------------------------------------------------------------------------
# Step 3 — Stage files for the zip
# ---------------------------------------------------------------------------
echo ""
echo "[3/4] Staging OTA package..."
rm -rf "$STAGING_DIR"
mkdir -p "$STAGING_DIR"

cp "$ARTIFACTS_DIR/firmware.bin" "$STAGING_DIR/firmware.bin"

if [ $FIRMWARE_ONLY -eq 0 ]; then
    for subdir in html demo; do
        if [ -d "$ARTIFACTS_DIR/$subdir" ]; then
            cp -r "$ARTIFACTS_DIR/$subdir" "$STAGING_DIR/$subdir"
        else
            echo "  WARNING: $subdir/ not found in artifacts — skipping"
        fi
    done
    # TFLite CNN models — copy config/ but exclude config.ini and prevalue.ini
    # to avoid overwriting the user's running configuration on the device.
    if [ -d "$ARTIFACTS_DIR/config" ]; then
        mkdir -p "$STAGING_DIR/config"
        find "$ARTIFACTS_DIR/config" -maxdepth 1 -type f \
            ! -name 'config.ini' ! -name 'prevalue.ini' \
            -exec cp {} "$STAGING_DIR/config/" \;
    else
        echo "  WARNING: config/ not found in artifacts — skipping"
    fi
fi

# ---------------------------------------------------------------------------
# Step 4 — Create the zip archives
# ---------------------------------------------------------------------------
echo ""
echo "[4/4] Creating OTA zips..."
rm -f "$ZIP_PATH" "$ZIP_PATH_WITH_CFG"

# --- Archive WITHOUT config (for OTA updates preserving user config) ---
(cd "$STAGING_DIR" && zip -r "$ZIP_PATH" .)

# --- Archive WITH config folder (for fresh installs / full reset) ---
if [ $FIRMWARE_ONLY -eq 0 ] && [ -d "$ARTIFACTS_DIR/config" ]; then
    mkdir -p "$STAGING_DIR/config"
    cp -f "$ARTIFACTS_DIR/config/"* "$STAGING_DIR/config/" 2>/dev/null || true
fi
(cd "$STAGING_DIR" && zip -r "$ZIP_PATH_WITH_CFG" .)

rm -rf "$STAGING_DIR"

ZIP_SIZE_MB=$(du -m "$ZIP_PATH" | cut -f1)
ZIP_SIZE_WITH_CFG_MB=$(du -m "$ZIP_PATH_WITH_CFG" | cut -f1)
echo "  Created: $ZIP_PATH (${ZIP_SIZE_MB} MB) — update only, preserves user config"
echo "  Created: $ZIP_PATH_WITH_CFG (${ZIP_SIZE_WITH_CFG_MB} MB) — includes config/ for fresh install"

if [ "$ZIP_SIZE_MB" -gt 8 ]; then
    echo "  WARNING: Update zip is larger than 8 MB — the device OTA page may reject it."
    echo "  Consider using -f and uploading html/ separately."
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "=== Done ==="
echo ""
echo "Artifacts:"
for item in "$ARTIFACTS_DIR"/*; do
    name="$(basename "$item")"
    if [ -d "$item" ]; then
        size="$(du -sh "$item" 2>/dev/null | cut -f1)"
    else
        size="$(du -sh "$item" 2>/dev/null | cut -f1)"
    fi
    printf "  %-20s %s\n" "$name" "$size"
done
echo ""
echo "OTA packages:"
echo "  $ZIP_PATH"
echo "    -> For updates (preserves device config)"
echo "  $ZIP_PATH_WITH_CFG"
echo "    -> For fresh installs (includes config/)"
echo ""
echo "To flash, open your device's OTA page and upload the zip:"
echo "  http://<device-ip>/ota"
echo ""
