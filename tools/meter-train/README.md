# meter-train: digit-wheel model training

Trains a drop-in replacement for `sd-card/config/dig-cont_*_q.tflite` (DoubleHyprid10:
input 1x32x20x3 float32 raw RGB 0..255, output 1x10 float32 softmax) from our labelled
device crops plus the public jomjol digit images. Firmware code is not touched.

## Setup (once)

```bash
cd tools/meter-train
uv venv --python 3.12 .venv
uv pip install --python .venv/Scripts/python.exe tensorflow-cpu pillow numpy ai-edge-litert
# public data (into the git-ignored device-logs/train/public)
cd ../../device-logs/train/public
git clone --depth 1 --filter=blob:none --sparse https://github.com/jomjol/neural-network-digital-counter-readout.git jomjol-digits
(cd jomjol-digits && git sparse-checkout set 01_data_raw_all_original)
git clone --depth 1 --filter=blob:none --no-checkout https://github.com/jomjol/neural-network-autotrain-digital-counter.git jomjol-autotrain
(cd jomjol-autotrain && git sparse-checkout set ziffer_raw && git checkout)
```

## Pipeline (run from the repo root)

```bash
PY=tools/meter-train/.venv/Scripts/python
$PY tools/meter-train/prepare.py         # -> device-logs/train/data/dataset.npz + dataset_meta.csv
$PY tools/meter-train/train.py           # -> device-logs/train/models/dig-meter.keras  (~5 min CPU)
$PY tools/meter-train/export.py          # -> device-logs/train/models/dig-cont_<yyyymmddhhmm>_f24_q.tflite
$PY tools/meter-train/eval_holdout.py --new device-logs/train/models/dig-cont_<yyyymmddhhmm>_f24_q.tflite
```

Full-history checks with the replay tools (these include training crops, so they are
optimistic for the new model):

```bash
tools/meter-replay/.venv/Scripts/python tools/meter-replay/tflite_eval.py device-logs/gasmeter <model> --round
tools/meter-replay/.venv/Scripts/python tools/meter-replay/recog_replay.py device-logs/gasmeter sd-card/config/dig-cont_0900_s3_q.tflite <model>
tools/meter-replay/.venv/Scripts/python tools/meter-replay/recog_replay.py device-logs/watermeter sd-card/config/dig-cont_0900_s3_q.tflite <model> --max-rate 0.03
```

## Model size (speed on the device)

CNN time on the ESP32 scales with multiply-accumulates; `train.py` prints `MACs/inference`.
The dig-cont architecture (64,128,64 filters, dense 256,64) is 16M MACs per digit, ~2 s per
ROI on an ESP32-CAM. A smaller shared model is as accurate on our data:

```bash
$PY tools/meter-train/train.py --filters 24,48,48 --dense 128,64 --out device-logs/train/models/small/f24.keras
```

Sweep 2026-10-14 (holdout, all wheels): f24 (3.0M MACs) gas 99.7% / water 99.9% / public 99.6%,
equal or better than the 16M model; round time on the watermeter 24 s -> 10-11 s.
16,32,32 (1.4M) loses the watermeter red wheel (dig6 96.8%); 8,16,16 is too small.
Per-meter models (`--sources gasmeter,public`) were no better than the shared one at the
same size, so one model serves both meters.

## Data rules (prepare.py)

- Ours: `device-logs/<meter>/labels/final.csv`. `high` / `transition` rows train with weight 1,
  `medium` with 0.5 (`--medium-weight`), `review` rows become the "hard" eval set (never trained).
  Label `d` -> one-hot; `a/b` -> 0.5/0.5.
- Public: file-name prefix `3_` / `3.0_` / `3.4_` -> soft target over floor/ceil.
  NaN and ambiguous names are skipped; duplicates removed by MD5; 20% held out by hash.
- Split: per meter, the last ~20% of the time span is TEST (later of "last 20% of days"
  and "last 20% of rows"); never trained on.
- Slow wheels: each train (meter, wheel, label) group is capped at `--cap` (300), evenly over time.
- Crops resized to 20x32 with PIL bilinear, as `tflite_eval.py` does.

## Export constraints (export.py checks and fails otherwise)

Ops limited to the firmware resolver (`CTfLiteClass::MakeStaticResolver`, max 10 types):
FULLY_CONNECTED, RESHAPE, SOFTMAX, CONV_2D, MAX_POOL_2D, QUANTIZE, MUL, ADD, LEAKY_RELU,
DEQUANTIZE. Size < 1.3 MB. Int8 internals with float32 I/O, calibrated on train crops.
Keras 3 needs the `model.export()` SavedModel path; `from_concrete_functions` leaves
READ_VARIABLE ops behind.

## Caveats

- Our labels were partly derived with dig-cont_0900, so it is favoured on our data; the
  jomjol images were most likely in the training sets of the stock models, so they are
  favoured on the public test. Neither is a fully independent benchmark.
- The "hard" set's teacher agreement is near 0% for every model by construction (rows went
  to review because the teacher disagreed); use it only for relative comparison.
- Verified with ai_edge_litert only; confirm on the device (tflite-micro) before relying on it.
