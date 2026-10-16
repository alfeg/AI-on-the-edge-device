#!/usr/bin/env python3
"""
Export a trained .keras model to an int8 .tflite that the firmware can run unchanged:
  - batch fixed to 1, input 1x32x20x3 float32 (raw RGB 0..255), output 1x10 float32
  - full-integer int8 internals (QUANTIZE in, DEQUANTIZE out) like the *_q models,
    calibrated with a representative set drawn from the TRAIN split
  - op list checked against the firmware resolver (CTfLiteClass::MakeStaticResolver,
    MicroMutableOpResolver<10>) and size limit
  - loads + invokes with ai_edge_litert; reports float-vs-int8 agreement on test crops

Run: tools/meter-train/.venv/Scripts/python tools/meter-train/export.py
       [--model device-logs/train/models/dig-meter.keras] [--out ...dig-cont_<yyyymmddhhmm>_f<filters>_n<images>_q.tflite] [--n-train N]
"""
import argparse
import datetime
import os
import sys

os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")
import numpy as np  # noqa: E402
import tensorflow as tf  # noqa: E402
import keras  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
TRAIN_DIR = os.path.join(ROOT, "device-logs", "train")
ALLOWED = {"FULLY_CONNECTED", "RESHAPE", "SOFTMAX", "CONV_2D", "MAX_POOL_2D", "QUANTIZE",
           "MUL", "ADD", "LEAKY_RELU", "DEQUANTIZE"}
MAX_OP_TYPES = 10
MAX_BYTES = 1_300_000


def op_list(path):
    from ai_edge_litert.interpreter import Interpreter
    it = Interpreter(model_path=path)
    it.allocate_tensors()
    ops = [o["op_name"] for o in it._get_ops_details() if o["op_name"] != "DELEGATE"]
    return it, ops


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=os.path.join(TRAIN_DIR, "models", "dig-meter.keras"))
    ap.add_argument("--data", default=os.path.join(TRAIN_DIR, "data", "dataset.npz"))
    ap.add_argument("--out", default=None)
    ap.add_argument("--n-rep", type=int, default=1000)
    ap.add_argument("--n-train", type=int, default=None,
                    help="images the model was trained on, for the file name (default: the train split)")
    a = ap.parse_args()
    model = keras.models.load_model(a.model)
    d = np.load(a.data)
    tr = np.where((d["split"] == "train") & (d["W"] > 0))[0]
    # repo convention <type>_<version>_<size>_q (like dig-cont_0900_s3_q): version = UTC
    # yyyymmddhhmm, size = first conv layer's filters, n = images trained on (same names as
    # the browser trainer). train.py --sources trains on a subset: pass --n-train then.
    filters = next(l for l in model.layers if isinstance(l, keras.layers.Conv2D)).filters
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d%H%M")
    n_train = a.n_train or len(tr)
    out = a.out or os.path.join(TRAIN_DIR, "models", f"dig-cont_{stamp}_f{filters}_n{n_train}_q.tflite")
    rng = np.random.default_rng(0)
    rep = d["X"][rng.choice(tr, min(a.n_rep, len(tr)), replace=False)].astype(np.float32)

    def rep_ds():
        for x in rep:
            yield [x[None]]

    # Keras 3: a plain tf.function / from_concrete_functions leaves READ_VARIABLE ops in the
    # graph; Keras' own SavedModel export freezes cleanly. Batch fixed to 1 like the firmware.
    import tempfile
    sm_dir = tempfile.mkdtemp(prefix="dig-meter-sm-")
    model.export(sm_dir, format="tf_saved_model", verbose=False,
                 input_signature=[tf.TensorSpec([1, 32, 20, 3], tf.float32, name="image")])
    conv = tf.lite.TFLiteConverter.from_saved_model(sm_dir)
    conv.optimizations = [tf.lite.Optimize.DEFAULT]
    conv.representative_dataset = rep_ds
    conv.target_spec.supported_ops = [tf.lite.OpsSet.TFLITE_BUILTINS_INT8]
    conv.inference_input_type = tf.float32
    conv.inference_output_type = tf.float32
    blob = conv.convert()
    os.makedirs(os.path.dirname(out), exist_ok=True)
    open(out, "wb").write(blob)

    it, ops = op_list(out)
    inp, outp = it.get_input_details()[0], it.get_output_details()[0]
    types = sorted(set(ops))
    print(f"exported {out}  ({len(blob)} bytes)")
    print(f"input {inp['shape'].tolist()} {inp['dtype'].__name__}  output {outp['shape'].tolist()} "
          f"{outp['dtype'].__name__}")
    print(f"op types ({len(types)}): {', '.join(types)}")
    print(f"op sequence: {' '.join(ops)}")
    bad = [t for t in types if t not in ALLOWED]
    ok = (not bad and len(types) <= MAX_OP_TYPES and len(blob) < MAX_BYTES
          and inp["shape"].tolist() == [1, 32, 20, 3] and inp["dtype"] == np.float32
          and outp["shape"].tolist() == [1, 10] and outp["dtype"] == np.float32)

    # invoke + float-vs-int8 agreement on test crops
    te = np.where(d["split"] == "test")[0]
    xs = d["X"][te[:: max(1, len(te) // 2000)]].astype(np.float32)
    pf = model.predict(xs, verbose=0)
    pq = []
    for x in xs:
        it.set_tensor(inp["index"], x[None])
        it.invoke()
        pq.append(it.get_tensor(outp["index"])[0])
    pq = np.array(pq)
    agree = np.mean(pf.argmax(1) == pq.argmax(1))
    print(f"invoke OK; float vs int8 argmax agreement {agree:.2%} on {len(xs)} test crops, "
          f"mean |dp| {np.abs(pf - pq).mean():.4f}, softmax sum {pq.sum(1).mean():.3f}")
    if bad:
        print(f"FAIL: ops not in firmware resolver: {bad}")
    if not ok:
        print("FAIL: model does not meet firmware constraints")
        sys.exit(1)
    print("OK: firmware constraints met")


if __name__ == "__main__":
    main()
