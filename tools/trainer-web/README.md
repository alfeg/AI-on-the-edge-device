# trainer-web: train digit models in the browser

A single HTML page (`trainer.html`, ~410 KB gzipped) that trains the AI-on-the-edge digit
model in the browser and exports an int8 `.tflite` file the firmware loads. It can be
served from the device's SD card (`/html/trainer.html.gz`) or opened from disk. There are
no CDN links, so it works on a network without internet access.

## What the page does (served from the device)

A wizard: Start (overview, automatic run) and five steps, each reachable at any time.

1. **Device setup:** reads `config.ini` and checks that digit images are saved
   (`ROIImagesLocation`) and kept long enough (`ROIImagesRetention`). One click fixes it:
   the config is backed up to `/config/config_<ts>.ini.bak`, pushed right after a reading
   round (MD5-checked) and the device restarts.
2. **Collect:** first a scan lists the new `/log/digit/<day>/<hour>/` folders and shows how many images there are to download and how long it takes; then crops go into IndexedDB. The device's
   reading is in each file name; crops are grouped by wheel + reading (digit, between two
   digits, rejected) and only "images per reading" (default 100) are kept per group,
   spread over the days. Resumable; finished hours are remembered. A labelled dataset zip
   can be imported too.
3. **Labels:** sources are the device reading, steady runs (≥4 identical readings), an AI
   server (Ollama `/api/chat` or OpenAI-compatible `/v1/chat/completions`) and your
   review. Two agreeing sources = confirmed. Only yours and confirmed labels train by
   default. A coverage table and readiness verdict show what is missing. The review grid
   has keyboard labelling.
4. **Train:** in a Web Worker (keeps running in a background tab). The test split is the
   newest days. The new model is compared with the installed one on the same test images
   the device read, and only when there are at least 100 of them.
5. **Install:** uploads the model to `/config/`, switches `[Digits] Model` after a round,
   restarts the device, waits for the first reading; one-click undo.

An **automatic run** does 2–5 in a row and installs only when the new model is at least as
good on the same images.

## Build

```bash
cd tools/trainer-web
npm install
npm run build          # -> dist/trainer.html and dist/trainer.html.gz
DEVICE=http://<device-ip> npx vite preview   # dev: proxies the device API to localhost
```

Upload `dist/trainer.html.gz` to `/html/` with the device's file manager, then open
`http://<device>/trainer.html`. The firmware serves the `.gz` with
`Content-Encoding: gzip` and caches it for 12 h, so reload hard after updating it.

## Code layout

The page is Vue 3 (`<script setup>` single-file components, no store library):

```
src/
  main.js, App.vue   entry and shell (header, step rail, one section per step)
  views/             one screen per step: StartView … InstallView
  components/        Base* = generic parts (status line, log, progress bar, crop image);
                     labels/Labels*, train/Train* = parts of one view; StepPill, StepNav
  stores/            shared state + actions, no markup (see below)
  services/          outside the page: device HTTP API, IndexedDB (db.js), AI server,
                     the device image collector
  lib/               pure logic, also run by Node scripts: dataset, labels, readiness,
                     train set, model, TFLite exporter (lib/tflite/)
  workers/           train.worker.js: TensorFlow.js training off the main thread
  i18n/              t() / tHtml() (index.js), Russian texts (ru.js), hint texts (hints.js)
  plugins/           hintTooltip.js: the shared tooltip for [data-hint] elements
  utils/             formatting, md5
  assets/            main.css (all styles), fonts
```

- Stores: `app.js` holds the open step, the one running task (`runTask`), status lines
  and step pills; `project.js` the crops and labels; then one per step (`setup`,
  `collect`, `ai`, `review`, `train`, `install`, `auto`, `datasetExport`). Crops and
  labels are large, so `project.js` keeps them outside Vue's reactivity and bumps a
  `rev` counter when they change.
- Imports: `@/` (= `src/`) in components and stores; `lib/`, `services/`, `i18n/` and
  `utils/` import each other relatively, so Node scripts (`scripts/node-check.mjs`) can
  load them without Vite.

Text: `t("English text", vars)` everywhere, `tHtml(key, html)` for text with markup and
`N_("...")` for English kept in data; `node scripts/i18n-keys.mjs` lists what
`src/i18n/ru.js` is missing.

## Dataset zip

```
labels.csv     path,src,pos,label,split,ts
images/...     crop JPEGs (any size; resized to 20x32 with PIL-style bilinear)
```

`label` is a digit (`7`) or, for a rolling wheel between two digits, both digits (`7/8`,
trained as 0.5/0.5). `split` is `train` or `test`; the test crops are only used for
the results table. To build one from the meter-train pipeline:

```bash
python tools/trainer-web/scripts/make_dataset_zip.py device-logs/train/data8d/dataset_meta.csv dataset.zip
```

## Model and export

- **Network:** the "small" preset matches the deployed f24 model (conv 24/48/48, dense 128/64, about 3 M multiply-adds per digit).
  - Each conv block is Conv3x3 → BatchNorm → LeakyReLU(0.3) → MaxPool.
  - BatchNorm and the input scale (1/255) are folded into the conv weights at export.
- **Export** (`src/lib/tflite/export.js` + `writer.js`): writes the TFLite flatbuffer directly.
  - Ops: QUANTIZE, CONV_2D, LEAKY_RELU, MAX_POOL_2D, RESHAPE, FULLY_CONNECTED, SOFTMAX, DEQUANTIZE. All are in `CTfLiteClass::MakeStaticResolver`.
  - Quantization: int8 per-channel conv weights, per-tensor FC weights, int32 biases, activations calibrated on 300 training crops.
  - Input and output stay float32, like the stock `dig-cont` models (DoubleHyprid10, 10 outputs).
- **File name:** `dig-cont_<yyyymmddhhmm>_f<filters>_q.tflite` (UTC time, first conv layer's
  filters), in the slot order of the stock models (`dig-cont_0900_s3_q.tflite`);
  `tools/meter-train/export.py` names its models the same way.

## Checks

```bash
# exporter vs the official TFLite converter on the same Keras weights
tools/meter-train/.venv/Scripts/python tools/trainer-web/scripts/keras_ref.py --data device-logs/train/data8d/dataset.npz --out tools/trainer-web/check-out
node tools/trainer-web/scripts/export-from-json.mjs tools/trainer-web/check-out
tools/meter-replay/.venv/Scripts/python tools/trainer-web/scripts/compare_tflite.py tools/trainer-web/check-out

# the built page end to end in headless Edge/Chrome (WebGL)
node scripts/browser-check.mjs check-out/meters-dataset.zip check-out/browser_q.tflite 60
# device workflow, read-only on the device (never installs): run vite preview with DEVICE first
ZIP=check-out/meters-dataset.zip node scripts/ui-check.mjs http://localhost:4173/trainer.html 150 3 gemma4:12b
```

## Browser limits on `http://<device>` pages

These pages are not a secure context, so:
- No WebGPU: training uses WebGL.
- No folder picker: the project lives in browser storage, with zip files to move it.
- No `crypto.subtle`.
- WebAssembly runs single-threaded, because the firmware sends no COOP/COEP headers.
