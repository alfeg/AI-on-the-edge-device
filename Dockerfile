# syntax=docker/dockerfile:1
# ============================================================
# Local firmware build in Docker — no PlatformIO, ESP-IDF or
# Python setup needed on the host.
#
# Mirrors .github/workflows/build.yaml (build + pack-for-update):
#
#   docker build --output build-output .
#
# writes to ./build-output/:
#   firmware.bin, bootloader.bin, partitions.bin
#   html/          gzip-compressed web UI
#   demo/          demo mode files
#   config/        default config + CNN models (sd-card/config)
#   update.zip     OTA package: firmware + html + demo + *.tfl/*.tflite
#   update-with-config.zip
#                  same, plus the complete default config/ (config.ini,
#                  reference images) — resets the device configuration
#
# See code/README.md ("Build with Docker") for details.
# ============================================================

# ------------------------------------------------------------
# Stage 1: firmware (PlatformIO, env:esp32cam)
# ------------------------------------------------------------
FROM python:3.12-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    wget \
    unzip \
    zip \
    gzip \
    cmake \
    ninja-build \
    ccache \
    libusb-1.0-0 \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir --upgrade pip && pip install --no-cache-dir --upgrade platformio

# Fetch toolchain, ESP-IDF and libraries with only platformio.ini in place,
# so this (large, slow) layer stays cached until platformio.ini changes.
WORKDIR /project/code
COPY code/platformio.ini platformio.ini
RUN platformio pkg install --environment esp32cam

# Full source. .git is needed for the submodules and the version string.
WORKDIR /project
COPY .git/  .git/
COPY code/  code/

RUN git config --global --add safe.directory '*' && \
    git submodule update --init --recursive

WORKDIR /project/code
RUN platformio run --environment esp32cam

# ------------------------------------------------------------
# Stage 2: web UI (same steps as "Prepare Web UI" in build.yaml)
# ------------------------------------------------------------
FROM python:3.12-slim AS webui

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    gzip \
    findutils \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir markdown

WORKDIR /project
COPY .git/        .git/
COPY sd-card/     sd-card/
COPY param-docs/  param-docs/
COPY tools/parameter-tooltip-generator/ tools/parameter-tooltip-generator/

# version.txt is written by the firmware build (code/main/CMakeLists.txt).
COPY --from=builder /project/sd-card/html/version.txt sd-card/html/version.txt

RUN git config --global --add safe.directory '*' && \
    SHA=$(git rev-parse --short HEAD 2>/dev/null || echo local) && \
    mkdir html && \
    cp -r sd-card/html/* html/ && \
    mkdir -p html/param-tooltips && \
    (cd tools/parameter-tooltip-generator && python generate-param-doc-tooltips.py) && \
    cp -r sd-card/html/* html/ && \
    rm -f html/edit_config_template.html && \
    cd html && \
    find . -type f -exec sed -i "s/\$COMMIT_HASH/${SHA}/g" {} \; && \
    for ext in html css js jpg png svg map; do \
        find . -name "*.${ext}" -type f -exec gzip -f {} \; ; \
    done

# ------------------------------------------------------------
# Stage 3: collect artifacts and pack the OTA zips
# (update.zip has the same content as the CI "update" artifact)
# ------------------------------------------------------------
FROM debian:bookworm-slim AS package

RUN apt-get update && apt-get install -y --no-install-recommends zip \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /project/code/.pio/build/esp32cam/firmware.bin   /out/firmware.bin
COPY --from=builder /project/code/.pio/build/esp32cam/bootloader.bin /out/bootloader.bin
COPY --from=builder /project/code/.pio/build/esp32cam/partitions.bin /out/partitions.bin
COPY --from=webui   /project/html/           /out/html/
COPY --from=webui   /project/sd-card/demo/   /out/demo/
COPY --from=webui   /project/sd-card/config/ /out/config/

# Only CNN models go into config/ of the update package, so an OTA update
# never overwrites the device's config.ini, prevalue.ini or reference images.
RUN mkdir -p /tmp/update/config && \
    cp /out/firmware.bin /tmp/update/ && \
    cp -r /out/html /out/demo /tmp/update/ && \
    find /out/config -maxdepth 1 -type f \( -name '*.tfl' -o -name '*.tflite' \) \
        -exec cp {} /tmp/update/config/ \; && \
    cd /tmp/update && zip -qr /out/update.zip . && \
    cp -r /out/config/. /tmp/update/config/ && \
    zip -qr /out/update-with-config.zip .

# ------------------------------------------------------------
# Stage 4: export — `docker build --output <dir> .` writes /out here
# ------------------------------------------------------------
FROM scratch AS export
COPY --from=package /out/ /
