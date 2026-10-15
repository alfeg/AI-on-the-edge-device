#!/usr/bin/env python3
"""
Exporter cross-check, step 3: run Keras float, the official converter's int8 model and the
JS-exported int8 model on the same test crops; report agreement and accuracy.

  tools/meter-replay/.venv/Scripts/python tools/trainer-web/scripts/compare_tflite.py \
      tools/trainer-web/check-out [extra.tflite ...]
"""
import json
import os
import sys

import numpy as np
from ai_edge_litert.interpreter import Interpreter


def run(path, X):
    it = Interpreter(model_path=path)
    it.allocate_tensors()
    i, o = it.get_input_details()[0], it.get_output_details()[0]
    out = np.zeros((len(X), 10), np.float32)
    for n, x in enumerate(X):
        it.set_tensor(i["index"], x[None])
        it.invoke()
        out[n] = it.get_tensor(o["index"])[0]
    return out


def decode(p):
    """DoubleHyprid10 position (firmware ClassFlowCNNGeneral)."""
    num = int(np.argmax(p))
    plus, minus = (num + 1) % 10, (num - 1) % 10
    v, vp, vm = p[num], p[plus], p[minus]
    r = num + vp / (vp + v) if vp > vm else num - vm / (v + vm)
    return r % 10


def main():
    d = sys.argv[1]
    if os.path.exists(os.path.join(d, "test.npz")):
        t = np.load(os.path.join(d, "test.npz"))
        X, Y, ref = t["X"], t["Y"], t["keras"]
    else:  # written by node-check.mjs: float predictions of the tfjs model
        j = json.load(open(os.path.join(d, "test.json")))
        X = np.array(j["X"], np.float32).reshape(-1, 32, 20, 3)
        Y, ref = np.array(j["Y"], np.float32), np.array(j["probs"], np.float32)
    paths = [p for p in [os.path.join(d, "tfconv_q.tflite"), os.path.join(d, "js_q.tflite")] + sys.argv[2:]
             if os.path.exists(p)]
    preds = {"float-ref": ref}
    for p in paths:
        preds[os.path.basename(p)] = run(p, X)
    ylab = np.argmax(Y, 1)
    soft = Y.max(1) < 0.9  # transition crops (0.5/0.5 targets)
    print(f"test crops: {len(X)} ({soft.sum()} transitions)")
    for name, p in preds.items():
        am = np.argmax(p, 1)
        ok = np.where(soft, Y[np.arange(len(Y)), am] > 0.4, am == ylab)
        agree = (am == np.argmax(ref, 1)).mean()
        dv = np.array([min(abs(decode(a) - decode(b)), 10 - abs(decode(a) - decode(b))) for a, b in zip(p, ref)])
        print(f"{name:18s} acc {ok.mean():6.2%}  argmax==keras {agree:6.2%}  "
              f"mean|dp| {np.abs(p - ref).mean():.4f}  |dpos| p99 {np.percentile(dv, 99):.3f} max {dv.max():.3f}")
    if "tfconv_q.tflite" in preds and "js_q.tflite" in preds:
        a, b = preds["tfconv_q.tflite"], preds["js_q.tflite"]
        print(f"js vs tfconv: argmax agree {(np.argmax(a, 1) == np.argmax(b, 1)).mean():.2%}, "
              f"mean|dp| {np.abs(a - b).mean():.4f}")


if __name__ == "__main__":
    main()
