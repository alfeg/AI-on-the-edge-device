#!/usr/bin/env python3
"""
Build the training / test arrays for the digit-wheel model.

Sources
  ours    device-logs/<meter>/labels/final.csv (+ the ROI crops it points to)
  public  jomjol digit images (device-logs/train/public/jomjol-*), label in the
          file-name prefix ("3_xxx.jpg", "3.0_xxx.jpg"; fractional "3.4_..." is
          supported too). NaN / ambiguous names ("3 - 4_x", "3-1.jpg") are skipped.

Labels -> 10-class soft targets
  "d"   (quality high)        one-hot d                         weight 1.0
  "d"   (quality medium)      one-hot d                         weight --medium-weight
  "a/b" (transition)          0.5 on a, 0.5 on b                weight 1.0
  p     (public, fractional)  (1-frac) on floor(p), frac on floor(p)+1
  review rows                 -> "hard" set (label unknown, never trained)

Split (ours): time-based per meter. Test = last ~20% of the time span: the later of
"last round(20% of days) whole days" and "last 20% of rows by time" (the second
one matters for meters with only a few days of data). Public: 20% by file hash.

Slow wheels show the same digit for weeks, so every (meter, wheel, label) group of
the TRAIN split is capped at --cap samples (taken evenly over time). Test is not
downsampled.

Output: device-logs/train/data/dataset.npz  (X uint8 Nx32x20x3, Y float32 Nx10,
W float32, meta columns) and dataset_meta.csv.

Run: tools/meter-train/.venv/Scripts/python tools/meter-train/prepare.py
"""
import argparse
import csv
import hashlib
import os
import re
from collections import Counter, defaultdict
from datetime import datetime

import numpy as np
from PIL import Image

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
LOGS = os.path.join(ROOT, "device-logs")
H, W = 32, 20
TS_RE = re.compile(r"_(\d{8}-\d{6})\.jpg$", re.I)
PUB_RE = re.compile(r"^(\d)(?:\.(\d+))?_")


def load_img(path):
    im = Image.open(path).convert("RGB").resize((W, H), Image.BILINEAR)  # as tflite_eval / firmware
    return np.asarray(im, dtype=np.uint8)


def soft_from_label(label):
    y = np.zeros(10, np.float32)
    if "/" in label:
        a, b = (int(t) % 10 for t in label.split("/"))
        y[a] += 0.5
        y[b] += 0.5
    else:
        y[int(label) % 10] = 1.0
    return y


def soft_from_pos(p):
    y = np.zeros(10, np.float32)
    f = int(np.floor(p))
    frac = p - f
    y[f % 10] += 1.0 - frac
    y[(f + 1) % 10] += frac
    return y


def time_cutoff(stamps, frac):
    days = sorted({t.date() for t in stamps})
    n_test_days = max(1, round(frac * len(days)))
    day_cut = datetime.combine(days[-n_test_days], datetime.min.time())
    q_cut = sorted(stamps)[int((1 - frac) * len(stamps))]
    return min(day_cut, q_cut)


def ours(meter, frac, medium_weight):
    dev = os.path.join(LOGS, meter)
    rows = list(csv.DictReader(open(os.path.join(dev, "labels", "final.csv"), newline="")))
    for r in rows:
        m = TS_RE.search(r["path"])
        r["t"] = datetime.strptime(m.group(1), "%Y%m%d-%H%M%S") if m else None
    rows = [r for r in rows if r["t"] is not None and r["t"].year > 2000]
    cut = time_cutoff([r["t"] for r in rows], frac)
    out = []
    for r in rows:
        q, lab = r["quality"], r["label"].strip()
        split = "test" if r["t"] >= cut else "train"
        if q == "review":
            kind, y, w = "hard", np.zeros(10, np.float32), 0.0
        elif q in ("high", "transition") and lab:
            kind, y, w = ("trans" if "/" in lab else "digit"), soft_from_label(lab), 1.0
        elif q == "medium" and lab and medium_weight > 0:
            kind, y, w = ("trans" if "/" in lab else "digit"), soft_from_label(lab), medium_weight
        else:
            continue
        out.append(dict(src=meter, pos=int(r["pos"]), label=lab, quality=q, kind=kind, split=split,
                        ts=r["t"].strftime("%Y%m%d-%H%M%S"), path=os.path.join(dev, r["path"]),
                        cnn=r.get("cnn", ""), teacher=r.get("teacher", ""), y=y, w=w))
    return out, cut


def public(frac):
    seen, out = set(), []
    pub = os.path.join(LOGS, "train", "public")
    for sub in ("jomjol-digits/01_data_raw_all_original", "jomjol-autotrain/ziffer_raw"):
        d = os.path.join(pub, sub)
        if not os.path.isdir(d):
            continue
        for f in sorted(os.listdir(d)):
            m = PUB_RE.match(f)
            if not m:
                continue
            p = os.path.join(d, f)
            h = hashlib.md5(open(p, "rb").read()).hexdigest()
            if h in seen:
                continue
            seen.add(h)
            pos = float(m.group(1) + ("." + m.group(2) if m.group(2) else ""))
            split = "test" if int(h[:8], 16) / 0xFFFFFFFF < frac else "train"
            frac_part = pos - np.floor(pos)
            lab = str(int(pos)) if frac_part == 0 else f"{pos:.1f}"
            out.append(dict(src="public", pos=0, label=lab, quality="public",
                            kind="digit" if frac_part == 0 else "frac", split=split, ts="", path=p,
                            cnn="", teacher="", y=soft_from_pos(pos), w=1.0))
    return out


def cap_train(rows, cap):
    """Cap each (meter, wheel, label) group of the train split, evenly spaced over time."""
    groups = defaultdict(list)
    keep = []
    for r in rows:
        if r["split"] == "train" and r["src"] != "public" and r["kind"] != "hard":
            groups[(r["src"], r["pos"], r["label"])].append(r)
        else:
            keep.append(r)
    for g in groups.values():
        g.sort(key=lambda r: r["ts"])
        if len(g) > cap:
            idx = np.linspace(0, len(g) - 1, cap).round().astype(int)
            g = [g[i] for i in sorted(set(idx))]
        keep.extend(g)
    return keep


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--meters", nargs="+", default=["gasmeter", "watermeter"])
    ap.add_argument("--test-frac", type=float, default=0.2)
    ap.add_argument("--cap", type=int, default=300, help="max train samples per (meter, wheel, label)")
    ap.add_argument("--medium-weight", type=float, default=0.5)
    ap.add_argument("--no-public", action="store_true")
    ap.add_argument("--out", default=os.path.join(LOGS, "train", "data"))
    a = ap.parse_args()

    rows = []
    for m in a.meters:
        r, cut = ours(m, a.test_frac, a.medium_weight)
        print(f"{m}: {len(r)} usable rows, test from {cut:%Y-%m-%d %H:%M}")
        rows += r
    n_before = sum(r["split"] == "train" and r["kind"] != "hard" for r in rows)
    rows = cap_train(rows, a.cap)
    n_after = sum(r["split"] == "train" and r["kind"] != "hard" for r in rows)
    print(f"ours train: {n_before} -> {n_after} after cap {a.cap}")
    if not a.no_public:
        pub = public(a.test_frac)
        print(f"public: {len(pub)} unique labelled images")
        rows += pub

    X = np.stack([load_img(r["path"]) for r in rows])
    Y = np.stack([r["y"] for r in rows]).astype(np.float32)
    Wt = np.array([r["w"] for r in rows], np.float32)
    cols = ["src", "pos", "label", "quality", "kind", "split", "ts", "path", "cnn", "teacher"]
    meta = {c: np.array([str(r[c]) for r in rows]) for c in cols}
    os.makedirs(a.out, exist_ok=True)
    np.savez_compressed(os.path.join(a.out, "dataset.npz"), X=X, Y=Y, W=Wt, **meta)
    with open(os.path.join(a.out, "dataset_meta.csv"), "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(cols + ["weight"])
        for r in rows:
            w.writerow([r[c] for c in cols] + [r["w"]])

    c = Counter((r["src"], r["split"], r["kind"]) for r in rows)
    print("\nsizes (src, split, kind):")
    for k in sorted(c):
        print(f"  {k[0]:10s} {k[1]:5s} {k[2]:6s} {c[k]:6d}")
    tr = Counter(int(np.argmax(r["y"])) for r in rows if r["split"] == "train" and r["w"] > 0)
    print("train class balance:", " ".join(f"{k}:{tr[k]}" for k in range(10)))
    print(f"saved {X.shape} -> {a.out}")


if __name__ == "__main__":
    main()
