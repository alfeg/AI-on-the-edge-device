#!/usr/bin/env python3
"""
Recognition replay: re-read every recorded cycle's digit crops with alternative
.tflite models, assemble the meter value exactly like the firmware
(ClassFlowCNNGeneral::getReadout + PointerEvalHybridNew, digits-only sequence),
then run the publishing policies from replay.py and score them.

Sources:
  device         the CNN class the device itself logged (crop file-name prefix)
  <model.tflite> re-run on the logged crops (predictions cached in labels/pred_<model>.csv)

Truth: per cycle, median of all sources' assembled values, then rolling median +
isotonic fit (replay.truth). Independent of any single model.

Run: tools/meter-replay/.venv/Scripts/python tools/meter-replay/recog_replay.py
       device-logs/gasmeter sd-card/config/dig-cont_0900_s3_q.tflite ... [--decimal-shift -2]
"""
import argparse
import csv
import math
import os
import statistics
import sys
from collections import defaultdict
from datetime import datetime

sys.path.insert(0, os.path.dirname(__file__))
import replay  # noqa: E402

DIGIT_BAND = 3
TRANS_PRED = 0.7     # Digit_Transition_Area_Predecessor
TRANS_FWD = 9.7      # Digit_Transition_Area_Forward


def pointer_eval_hybrid(number, num_pred, eval_pred):
    """Port of ClassFlowCNNGeneral::PointerEvalHybridNew (no analog predecessor)."""
    after = int(math.floor(number * 10)) % 10
    before = (int(math.floor(number)) + 10) % 10
    if eval_pred < 0:
        return int(math.trunc(round(number * 100))) // 100
    if TRANS_PRED <= num_pred <= 10.0 - TRANS_PRED:
        if after <= DIGIT_BAND or after >= 10 - DIGIT_BAND:
            return (int(round(number)) + 10) % 10
        return (int(math.trunc(number)) + 10) % 10
    if eval_pred <= 1:
        return (before + 1) % 10 if after > 5 else before % 10
    if TRANS_FWD >= num_pred or after >= 4:
        return before % 10
    return (before - 1 + 10) % 10


def assemble(floats, kind):
    """floats: per-ROI result (None = reject). Returns digit string like ClassFlowCNNGeneral::getReadout."""
    if kind == "Digit":
        return "".join("N" if f is None else str(int(f)) for f in floats)
    # DoubleHyprid10 / Digit100
    res, prev = "", -1
    last = floats[-1]
    if last is not None and 0 <= last < 10:
        prev = pointer_eval_hybrid(last, prev, prev)
        res = str(prev) if 0 <= prev < 10 else "N"
    else:
        res = "N"
    for i in range(len(floats) - 2, -1, -1):
        f = floats[i]
        if f is not None and 0 <= f < 10:
            nxt = floats[i + 1] if floats[i + 1] is not None else -1
            prev = pointer_eval_hybrid(f, nxt, prev)
            res = str(prev) + res
        else:
            prev = -1
            res = "N" + res
    return res


def to_value(digits, shift):
    if "N" in digits:
        return None
    if shift < 0:
        s = digits[:shift] + "." + digits[shift:]
    else:
        s = digits + "0" * shift
    return float(s)


def cycles_from_crops(dev_dir):
    rows = list(csv.DictReader(open(os.path.join(dev_dir, "labels", "crops.csv"), newline="")))
    cyc = defaultdict(dict)
    for r in rows:
        cyc[r["ts"]][int(r["pos"])] = r
    npos = max(len(v) for v in cyc.values())
    out = [(ts, cyc[ts]) for ts in sorted(cyc) if len(cyc[ts]) == npos]
    return out, npos


def predictions(dev_dir, model_path, rows_by_cycle):
    from tflite_eval import Model
    from PIL import Image
    name = os.path.basename(model_path)
    cache = os.path.join(dev_dir, "labels", f"pred_{name}.csv")
    pred = {}
    if os.path.exists(cache):
        for r in csv.DictReader(open(cache, newline="")):
            pred[r["path"]] = (None if r["value"] == "" else float(r["value"]), float(r["conf"]))
    m = Model(model_path)
    todo = [r for _, c in rows_by_cycle for r in c.values() if r["path"] not in pred]
    if todo:
        new = open(cache, "a", newline="")
        w = csv.writer(new)
        if os.path.getsize(cache) == 0:
            w.writerow(["path", "value", "conf"])
        for i, r in enumerate(todo, 1):
            v, conf = m.predict(Image.open(os.path.join(dev_dir, r["path"])))
            pred[r["path"]] = (v, conf)
            w.writerow([r["path"], "" if v is None else f"{v:.4f}", f"{conf:.4f}"])
            if i % 5000 == 0:
                print(f"    {name}: {i}/{len(todo)}", flush=True)
        new.close()
    return m.kind, pred


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("device_dir")
    ap.add_argument("models", nargs="*")
    ap.add_argument("--decimal-shift", type=int, default=-2)
    ap.add_argument("--good-threshold", type=float, default=0.5, help="CNNGoodThreshold for DoubleHyprid10")
    ap.add_argument("--max-rate", type=float, default=0.02)
    ap.add_argument("--slack", type=float, default=0.02)
    ap.add_argument("--escape", type=int, default=3)
    ap.add_argument("--escape-down", type=int, default=12)
    ap.add_argument("--deadband", type=float, default=0.1)
    ap.add_argument("--fw-maxrate", type=float, default=0.7)
    ap.add_argument("--fw-crt", type=float, default=3)
    ap.add_argument("--fw-nachkomma", type=int, default=2)
    ap.add_argument("--fw-stuck", type=int, default=6)
    cfg = ap.parse_args()

    cycles, npos = cycles_from_crops(cfg.device_dir)
    times = [datetime.strptime(ts, "%Y%m%d-%H%M%S") for ts, _ in cycles]
    sources = {}

    # device's own logged classes
    vals = []
    for ts, c in cycles:
        fl = [None if int(c[p]["cnn"]) >= 10 else float(c[p]["cnn"]) for p in range(1, npos + 1)]
        vals.append(to_value(assemble(fl, "Digit"), cfg.decimal_shift))
    sources["device-cnn"] = vals

    for mp in cfg.models:
        kind, pred = predictions(cfg.device_dir, mp, cycles)
        vals = []
        for ts, c in cycles:
            fl = []
            for p in range(1, npos + 1):
                v, conf = pred[c[p]["path"]]
                if kind == "DoubleHyprid10" and conf < cfg.good_threshold:
                    v = None
                fl.append(v)
            vals.append(to_value(assemble(fl, kind), cfg.decimal_shift))
        sources[os.path.basename(mp)] = vals

    # truth: median across sources per cycle -> rolling median + isotonic
    med = []
    for i in range(len(cycles)):
        xs = [s[i] for s in sources.values() if s[i] is not None]
        med.append(statistics.median(xs) if xs else None)
    trows = [{"t": t, "raw": v} for t, v in zip(times, med)]
    tr = replay.truth(trows)

    print(f"{cfg.device_dir}: {len(cycles)} complete cycles, {npos} digit wheels, "
          f"{times[0]:%Y-%m-%d} .. {times[-1]:%Y-%m-%d}")
    for name, vals in sources.items():
        rows = [{"t": t, "raw": v, "dev": v} for t, v in zip(times, vals)]
        print(f"\n[{name}]  readable cycles {sum(v is not None for v in vals)}/{len(vals)}")
        for pname in ("raw", "firmware", "gate_db"):
            replay.score(pname, replay.POLICIES[pname](rows, cfg), rows, tr, cfg)


if __name__ == "__main__":
    main()
