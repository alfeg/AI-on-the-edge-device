# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

ESP32-CAM firmware that digitises analog meters (water/gas/electricity) by capturing a photo, running CNN inference on cropped digit/analog ROIs, and publishing the reading via REST/MQTT/InfluxDB/Webhook. The firmware runs on the device and ships with a self-hosted web UI on the SD card.

## Build & flash

The project uses **ESP-IDF via PlatformIO**, not Arduino. Always run from `code/`:

```bash
cd code

# Compile (default env, what release builds use)
platformio run --environment esp32cam

# Upload over USB
pio run --target upload --upload-port /dev/ttyUSB0   # or e.g. COM5 on Windows

# Erase flash (recommended before first flash)
pio run --target erase

# Serial monitor (115200 baud)
pio device monitor -p /dev/ttyUSB0
```

Build artifacts land in `code/.pio/build/esp32cam/`: `firmware.bin`, `bootloader.bin`, `partitions.bin`.

There is no test framework. `code/test/` is a stub. Don't write or run unit tests — verify changes by compiling, then flashing onto a device.

### Build environments in `code/platformio.ini`

- `esp32cam` — release; what CI ships and what users flash.
- `esp32cam-dev` — runtime warnings, debug knobs (`DEBUG_DETAIL_ON`, `DEBUG_ENABLE_SYSINFO`, etc).
- `esp32cam-debug` — heavy debug; not standalone, extends others.
- `esp32cam-board-rev3`, `esp32cam-cpu-freq-240`, `esp32cam-dev-himem`, `esp32cam-dev-task-analysis`, `esp32cam-no-softap` — board/feature variants.

### Reproducible Docker build (matches CI)

```bash
docker build -t ai-edge .
# or, to also produce a flashable update zip:
./tools/build-update-package.sh        # Linux/macOS
.\tools\build-update-package.ps1       # Windows
```

Output lands in `build-output/artifacts/` plus `ai-edge-update.zip` (the OTA package, intentionally excludes `config/config.ini` and `config/prevalue.ini` so user state survives updates). See `docs/update-from-docker-build.md`.

## Architecture

### Two halves

1. **Firmware** (`code/`) — the per-cycle pipeline running on the ESP32.
2. **SD card** (`sd-card/`) — config (`config/config.ini`), CNN models (`.tflite`), and the entire web UI (`html/`). The firmware doesn't embed UI assets; it serves them from SD.

### The flow pipeline (`code/components/jomjol_flowcontroll/`)

The whole reading cycle is built as a chain of `ClassFlow` subclasses orchestrated by `ClassFlowControll`. Each subclass implements `ReadParameter(...)` (parses its `[Section]` from `config.ini`) and `doFlow(time)` (runs its step). Order matters — they share state via the `NumberPost` struct (defined in `ClassFlowDefineTypes.h`).

Per-cycle order:
1. `ClassFlowTakeImage` — capture frame from camera.
2. `ClassFlowAlignment` — find reference markers, rotate/translate the frame.
3. `ClassFlowCNNGeneral` (×2: digit + analog) — load TFLite model, crop each ROI, run inference, store `result_klasse`/`result_float` per ROI.
4. `ClassFlowLLMFallback` — config-only step (its `doFlow` is a no-op); the actual LLM call happens at the end of the analog/digit CNN pass *after* TFLite is freed (memory pressure — the HTTP+TLS path needs all the heap it can get). Triggered when CNN confidence is below `[LLMFallback] ConfidenceThreshold` or the digit is a hard-fail.
5. `ClassFlowPostProcessing` — assemble per-ROI results into the meter value, apply `DecimalShift`, `CheckDigitIncreaseConsistency`, `AllowNegativeRates`/`MaxRateValue` gating, two-witness recovery, persist `PreValue` to `/sdcard/config/prevalue.ini`.
6. `ClassFlowMQTT` / `ClassFlowInfluxDB` / `ClassFlowInfluxDBv2` / `ClassFlowWebhook` — publishers (compile-time gated by `ENABLE_*` flags in `platformio.ini`).

`MainFlowControl.cpp` wires everything to the HTTP server endpoints (`/setPreValue`, `/value`, `/json`, `/editflow?task=...`, etc.) and exposes `flowctrl` as the global handle.

### Component layout (`code/components/jomjol_*`)

Each `jomjol_*` directory is one ESP-IDF component with its own `CMakeLists.txt`. Adding source files there requires updating that component's `CMakeLists.txt`. The vendored libraries (`esp32-camera`, `esp-nn`, `esp-tflite-micro`, `esp-protocols`, `stb`, `openmetrics`) are git submodules — `git submodule update --init --recursive` after clone.

Key components:
- `jomjol_flowcontroll` — the pipeline above.
- `jomjol_tfliteclass` — `CTfLiteClass`, the wrapper around tflite-micro that loads `.tflite` from SD and runs inference per ROI.
- `jomjol_image_proc` — `CImageBasis` (RGB image with `Resize`, `writeToMemoryAsJPG`, etc.), uses `stb_image`.
- `jomjol_logfile` — `LogFile` global (`/sdcard/log/message/log_YYYY-MM-DD.txt`); `WriteToFile(level, tag, message)` flattens newlines. `WriteToLLMLog` writes to `/sdcard/log/llm/llm_YYYY-MM-DD.txt` preserving newlines (used by the LLM fallback transcripts).
- `jomjol_fileserver_ota` — HTTP server, fileserver endpoints, OTA update.
- `jomjol_llm_fallback` — vision-API fallback for CNN digit recognition; supports OpenAI-compatible and Ollama providers. See `docs/specs/llm-digit-fallback.md` and the `[LLMFallback]` section in `config.ini`.

### Memory model — important

The device has ~4 MB PSRAM and ~80–90 KB internal heap. Heavy buffers (CNN models, JPEG decode, image objects) live in PSRAM via `heap_caps_malloc(..., MALLOC_CAP_SPIRAM)` (see `jomjol_helper`). HTTP + TLS connections need the *internal* heap.

Implications when editing the flow:
- Don't allocate large temporaries on task stacks. The `autodoFlow` task stack is 16 KB.
- Free the TFLite interpreter before any networking hop that needs lots of heap (the LLM fallback already does this — it queues failed ROIs and processes them only after `delete tflite`).
- Free request bodies as soon as `esp_http_client_perform` returns (see `LLMFallback.cpp` — body is `swap`'d to release immediately).
- Heap diagnostics: `LogFile.WriteHeapInfo("label")` logs a snapshot at DEBUG level. Already sprinkled at every memory-sensitive boundary; preserve those when refactoring.

## Config & parameter conventions

- The single source of truth is `sd-card/config/config.ini`. Each `[Section]` is read by the matching `ClassFlow*` subclass's `ReadParameter`. The repo file is the *template*; the on-device file is what runs.
- The web UI parses `config.ini` client-side via `sd-card/html/readconfigparam.js` and `readconfigcommon.js`. `ZerlegeZeile` tokenises lines on whitespace+`=` — there's a special-case branch for keys whose value can legitimately contain spaces / `=` (currently `password`, `Token`, `Prompt`, `AdditionalHeaders`). If you add another such key, extend that list.
- Every parameter in `config.ini` must have a corresponding markdown page in `param-docs/parameter-pages/<Section>/<Param>.md`. CI generates the in-app tooltips from those pages. When adding/renaming a parameter:
  1. Add it to `config.ini` (commented or default value).
  2. Wire up `ReadParameter` in the relevant `ClassFlow*` subclass.
  3. Add the form control in `sd-card/html/edit_config_template.html` and register it in `readconfigparam.js` via `ParamAddValue`.
  4. Create `param-docs/parameter-pages/<Section>/<Param>.md`.
  5. Run `param-docs/generate-template-param-doc-pages.py` to fill template gaps. List in `expert-params.txt` or `hidden-in-ui.txt` if applicable.

## State persistence on SD

- `/sdcard/config/config.ini` — user config (preserved across firmware updates).
- `/sdcard/config/prevalue.ini` — last good reading per number-sequence (`name<TAB>timestamp<TAB>value`); written by `ClassFlowPostProcessing::SavePreValue`. Web override path: `GET /setPreValue?value=X&numbers=NAME` or the `/prevalue_set.html` page.
- `/sdcard/log/message/log_YYYY-MM-DD.txt` — main log.
- `/sdcard/log/data/data_YYYY-MM-DD.csv` — readings log.
- `/sdcard/log/llm/llm_YYYY-MM-DD.txt` + per-call `<timestamp>_<NUMBER>_<ROI>.jpg` — LLM conversation transcripts and the exact JPEG sent. Useful for replaying failed cases.
- `/sdcard/firmware/` — staged OTA payload.
- `/sdcard/html/` — web UI (gzipped at build time).

## Conventions worth knowing

- C++ style is mixed (the codebase predates a style guide). German identifier remnants exist (`Anzahl`, `Nachkomma`, `ZerlegeZeile`, `aktparamgraph`). Match what's around you — don't refactor names drive-by.
- `using namespace std;` is in some headers (`ClassFlow.h`). Bare `string`, `vector`, `to_string`, `abs`, `pow` work in those translation units. Stay consistent with the file you're editing.
- Logs flow through `LogFile.WriteToFile(level, tag, msg)` — do not `printf` directly. Newlines in the `msg` are flattened to spaces; if you need multi-line, use `WriteToLLMLog` (or write a dedicated logger).
- All paths to SD start with `/sdcard/`. Use absolute paths.
- Don't break OTA: `partitions.csv`, `partitions.bin`, and the size of the `app` partition are load-bearing. Adding components or static buffers can push firmware over the partition limit, which fails silently at flash time (the build succeeds).
