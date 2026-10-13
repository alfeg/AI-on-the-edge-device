#!/usr/bin/env python3
"""
Run on-device .tflite digit models against the recorded digit crops, the way the
firmware does (ClassFlowCNNGeneral::doNeuralNetwork), and score them.

Preprocessing mirrors the firmware: the logged crop is image_org (ROI at native
size); the firmware resizes it to the model input (stbir) and feeds raw RGB as
float 0..255 (CTfLiteClass::LoadInputImageBasis).

Decoding by output size (as in getNetworkParameter):
  11  -> Digit          : argmax, 10 = N
  10  -> DoubleHyprid10 : num +/- neighbour interpolation -> float 0..10 ("dig-cont")
  100 -> Digit100       : argmax / 10                   -> float 0..9.9 ("class100")

Scores (per position) against labels in <dev>/labels/crops.csv:
  slow wheels -> consensus label; fast wheels -> labels/final.csv if present
  digit := floor(x) for float models (value semantics), class for Digit
Also prints, per position, how evenly the predicted digits spread (a continuously
turning wheel should hit every digit about equally often).

Run with the venv:  tools/meter-replay/.venv/Scripts/python tools/meter-replay/tflite_eval.py
    device-logs/gasmeter path/to/model.tflite [model2 ...] [--limit 3000]
"""
import argparse
import csv
import math
import os
import random
from collections import Counter, defaultdict

import numpy as np
from PIL import Image
from ai_edge_litert.interpreter import Interpreter


class Model:
    def __init__(self, path):
        self.name = os.path.basename(path)
        self.it = Interpreter(model_path=path)
        self.it.allocate_tensors()
        self.inp = self.it.get_input_details()[0]
        self.out = self.it.get_output_details()[0]
        _, self.h, self.w, self.c = self.inp["shape"]
        self.n_out = int(self.out["shape"][-1])
        self.kind = {11: "Digit", 10: "DoubleHyprid10", 100: "Digit100"}.get(self.n_out, f"?{self.n_out}")

    def predict(self, img):
        im = img.convert("RGB").resize((self.w, self.h), Image.BILINEAR)
        x = np.asarray(im, dtype=np.float32)[None, ...]
        if self.inp["dtype"] != np.float32:  # fully quantized input
            s, z = self.inp["quantization"]
            x = np.clip(np.round(x / s + z), np.iinfo(self.inp["dtype"]).min,
                        np.iinfo(self.inp["dtype"]).max).astype(self.inp["dtype"])
        self.it.set_tensor(self.inp["index"], x)
        self.it.invoke()
        y = self.it.get_tensor(self.out["index"])[0].astype(np.float32)
        if self.out["dtype"] != np.float32:
            s, z = self.out["quantization"]
            y = (y - z) * s
        return self.decode(y)

    def decode(self, y):
        if self.n_out == 11:
            k = int(np.argmax(y))
            return (None if k == 10 else float(k)), float(y[k])
        if self.n_out == 100:
            k = int(np.argmax(y))
            return k / 10.0, float(y[k])
        if self.n_out == 10:  # firmware DoubleHyprid10 interpolation
            num = int(np.argmax(y))
            plus, minus = (num + 1) % 10, (num - 1 + 10) % 10
            v, vp, vm = y[num], y[plus], y[minus]
            r = num + vp / (vp + v) if vp > vm else num - vm / (v + vm)
            r = r % 10
            return float(r), float(v + max(vp, vm))
        return None, 0.0


def load_rows(dev_dir):
    rows = list(csv.DictReader(open(os.path.join(dev_dir, "labels", "crops.csv"), newline="")))
    final = os.path.join(dev_dir, "labels", "final.csv")
    if os.path.exists(final):
        lab = {r["path"]: r["label"] for r in csv.DictReader(open(final, newline="")) if r["quality"] == "high"}
        for r in rows:
            if r["path"] in lab and lab[r["path"]] != "":
                r["label"] = lab[r["path"]]
    for r in rows:
        r.setdefault("label", r["consensus"])
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("device_dir")
    ap.add_argument("models", nargs="+")
    ap.add_argument("--round", action="store_true", help="digit = round(x) (centred digit) instead of floor(x)")
    ap.add_argument("--limit", type=int, default=0, help="random sample size per position (0 = all)")
    a = ap.parse_args()

    rows = load_rows(a.device_dir)
    by_pos = defaultdict(list)
    for r in rows:
        by_pos[r["pos"]].append(r)
    rnd = random.Random(7)
    if a.limit:
        for p in by_pos:
            if len(by_pos[p]) > a.limit:
                by_pos[p] = rnd.sample(by_pos[p], a.limit)

    for mp in a.models:
        m = Model(mp)
        print(f"\n== {m.name}  [{m.kind}, input {m.w}x{m.h}x{m.c}]")
        for pos in sorted(by_pos, key=int):
            preds, ok, n_lab, nN = [], 0, 0, 0
            for r in by_pos[pos]:
                img = Image.open(os.path.join(a.device_dir, r["path"]))
                v, conf = m.predict(img)
                if v is None:
                    nN += 1
                    continue
                d = (int(round(v)) if a.round else int(math.floor(v + 1e-6))) % 10
                preds.append(d)
                if r["label"] != "":
                    n_lab += 1
                    ok += (str(d) == r["label"])
            cnt = Counter(preds)
            # evenness: normalised entropy of predicted digits (1.0 = perfectly even)
            tot = sum(cnt.values())
            ent = -sum(c / tot * math.log(c / tot) for c in cnt.values()) / math.log(10) if tot else 0
            acc = f"{ok / n_lab:6.1%} of {n_lab:5d}" if n_lab else "   n/a        "
            dist = " ".join(f"{k}:{cnt.get(k, 0)}" for k in range(10))
            print(f"  dig{pos}: acc {acc}  N {nN:4d}  evenness {ent:.2f}  [{dist}]")


if __name__ == "__main__":
    main()
