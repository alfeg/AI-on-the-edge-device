#!/usr/bin/env python3
"""
Score digit models on the held-out TEST split only (never trained on), per meter
and per wheel, using the exact firmware-style preprocessing/decoding of
tools/meter-replay/tflite_eval.py (Model.predict).

Compared sources
  device       the class the device logged (crop file-name prefix, class11; 10 = N = wrong)
  <model>      any .tflite (default: dig-cont_0900, dig-cont_0712, dig-class100-0182 + --new)

Metrics
  digit crops  correct if round(position) % 10 == label
  transition   ("a/b" labels) correct if the position lies within 0.5 of the a|b
               boundary (circular), i.e. it rounds to a or b
  hard set     (quality=review, label unknown) agreement with the VLM teacher label
               where one exists
  public test  jomjol images held out by hash in prepare.py (single "wheel")

Caveat: our labels were partly derived with dig-cont_0900, so it is favoured on our
data. The fair comparison is test split + public test.

Run: tools/meter-train/.venv/Scripts/python tools/meter-train/eval_holdout.py
       --new device-logs/train/models/dig-cont_<yyyymmddhhmm>_f24_q.tflite
"""
import argparse
import csv
import os
import sys
from collections import defaultdict

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "tools", "meter-replay"))
from tflite_eval import Model  # noqa: E402
from PIL import Image  # noqa: E402

CFG = os.path.join(ROOT, "sd-card", "config")
DEFAULT_MODELS = [os.path.join(CFG, f) for f in
                  ("dig-cont_0900_s3_q.tflite", "dig-cont_0712_s3_q.tflite", "dig-class100-0182-s2_q.tflite")]


def circ(a, b):
    d = abs(a - b) % 10
    return min(d, 10 - d)


def correct(row, v):
    if v is None:
        return False
    lab = row["label"]
    if "/" in lab:
        a, _ = (int(t) for t in lab.split("/"))
        return circ(v, a + 0.5) <= 0.5 + 1e-6
    return int(round(v)) % 10 == int(float(lab)) % 10


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--new", nargs="*", default=[], help="new model(s) to compare")
    ap.add_argument("--models", nargs="*", default=DEFAULT_MODELS)
    ap.add_argument("--meta", default=os.path.join(ROOT, "device-logs", "train", "data", "dataset_meta.csv"))
    a = ap.parse_args()

    rows = [r for r in csv.DictReader(open(a.meta, newline="")) if r["split"] == "test"]
    models = [Model(p) for p in a.models + a.new]
    names = ["device"] + [m.name.replace(".tflite", "") for m in models]

    # predictions: name -> list of position (float) or None
    preds = {"device": [None if r["cnn"] in ("", "10") else float(r["cnn"]) for r in rows]}
    imgs = []
    for r in rows:
        with Image.open(r["path"]) as im:
            imgs.append(im.convert("RGB"))
    for m, n in zip(models, names[1:]):
        preds[n] = [m.predict(im)[0] for im in imgs]

    # (group, wheel, kind) -> name -> [ok, n]
    acc = defaultdict(lambda: defaultdict(lambda: [0, 0]))
    for i, r in enumerate(rows):
        if r["kind"] == "hard":
            if not r["teacher"].isdigit():
                continue
            key = (r["src"], "hard", "teacher")
            for n in names:
                v = preds[n][i]
                acc[key][n][0] += v is not None and int(round(v)) % 10 == int(r["teacher"])
                acc[key][n][1] += 1
            continue
        if r["src"] == "public":
            if r["kind"] == "frac":
                continue
            keys = [("public", "all", r["kind"])]
        else:
            keys = [(r["src"], f"dig{r['pos']}", r["kind"]), (r["src"], "ALL", r["kind"])]
        for key in keys:
            for n in names:
                if r["src"] == "public" and n == "device":
                    continue
                acc[key][n][0] += correct(r, preds[n][i])
                acc[key][n][1] += 1

    w = max(len(n) for n in names) + 1
    hdr = f"{'meter':10s} {'wheel':6s} {'kind':7s} {'n':>5s} " + " ".join(f"{n[:w]:>{w}s}" for n in names)
    print(hdr)
    print("-" * len(hdr))
    order = {"gasmeter": 0, "watermeter": 1, "public": 2}
    for key in sorted(acc, key=lambda k: (order.get(k[0], 9), k[1] == "ALL", k[1], k[2])):
        cells, n_tot = [], 0
        for n in names:
            ok, tot = acc[key][n]
            n_tot = max(n_tot, tot)
            cells.append(f"{ok / tot:>{w}.1%}" if tot else f"{'-':>{w}s}")
        print(f"{key[0]:10s} {key[1]:6s} {key[2]:7s} {n_tot:5d} " + " ".join(cells))


if __name__ == "__main__":
    main()
