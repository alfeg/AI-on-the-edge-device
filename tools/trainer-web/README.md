# trainer-web: train digit models in the browser

A single HTML page (`trainer.html`, ~250 KB gzipped) that trains the AI-on-the-edge digit
model in the browser and exports an int8 `.tflite` file the firmware loads. It can be
served from the device's SD card (`/html/trainer.html.gz`) or opened from disk. There are
no CDN links, so it works on a network without internet access.

Status: **proof of concept** (milestone 1 of the plan). It covers: load a labelled dataset
zip → train → check on the held-back crops → export. Still to do: collecting crops from
the device, readiness checks (image logging and retention), first labels from
Ollama/OpenAI, the review page, deploying to the device, an in-browser int8 self-check.

## Build

```bash
cd tools/trainer-web
npm install
npm run build          # -> dist/trainer.html and dist/trainer.html.gz
```

Upload `dist/trainer.html.gz` to `/html/` with the device's file manager, then open
`http://<device>/trainer.html`. The firmware serves the `.gz` with
`Content-Encoding: gzip` and caches it for 12 h, so reload hard after updating it.

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
- **Export** (`src/tflite/export.js` + `writer.js`): writes the TFLite flatbuffer directly.
  - Ops: QUANTIZE, CONV_2D, LEAKY_RELU, MAX_POOL_2D, RESHAPE, FULLY_CONNECTED, SOFTMAX, DEQUANTIZE. All are in `CTfLiteClass::MakeStaticResolver`.
  - Quantization: int8 per-channel conv weights, per-tensor FC weights, int32 biases, activations calibrated on 300 training crops.
  - Input and output stay float32, like the stock `dig-cont` models (DoubleHyprid10, 10 outputs).

## Checks

```bash
# exporter vs the official TFLite converter on the same Keras weights
tools/meter-train/.venv/Scripts/python tools/trainer-web/scripts/keras_ref.py --data device-logs/train/data8d/dataset.npz --out tools/trainer-web/check-out
node tools/trainer-web/scripts/export-from-json.mjs tools/trainer-web/check-out
tools/meter-replay/.venv/Scripts/python tools/trainer-web/scripts/compare_tflite.py tools/trainer-web/check-out

# the built page end to end in headless Edge/Chrome (WebGL)
node scripts/browser-check.mjs check-out/meters-dataset.zip check-out/browser_q.tflite 60
```

## Browser limits on `http://<device>` pages

These pages are not a secure context, so:
- No WebGPU: training uses WebGL.
- No folder picker: the project lives in browser storage, with zip files to move it.
- No `crypto.subtle`.
- WebAssembly runs single-threaded, because the firmware sends no COOP/COEP headers.
