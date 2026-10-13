#!/usr/bin/env python3
"""
Build an index of every digit crop and derive "consensus" labels for the slow
wheels from temporal stability.

Crop files: device-logs/<dev>/log/digit/YYYYMMDD/HH/<cnnclass>_<number>_dig<N>_<YYYYMMDD-HHMMSS>.jpg
            (cnnclass 10 = N / not recognised)

Consensus rule (slow wheels only): a cumulative meter's integer part changes rarely,
so for each position the true digit is the mode of the CNN classes over a
sliding window of cycles, constrained so the assembled integer part never
decreases. Fast wheels (decimals) get no consensus label here — they are
relabelled by the vision-model teacher (vlm_label.py).

Output: <dev>/labels/crops.csv  (one row per crop)
  device,ts,pos,cnn,consensus,path
"""
import argparse
import csv
import os
import re
from collections import Counter, defaultdict

FN_RE = re.compile(r'^(\d+)_(\w+?)_dig(\d+)_(\d{8}-\d{6})\.jpg$')


def index_crops(dev_dir):
    rows = []
    root = os.path.join(dev_dir, "log", "digit")
    for dp, _, files in os.walk(root):
        if "19700101" in dp:
            continue  # pre-NTP timestamps are unusable for temporal labelling
        for f in files:
            m = FN_RE.match(f)
            if not m:
                continue
            rows.append({"ts": m.group(4), "pos": int(m.group(3)), "cnn": int(m.group(1)),
                         "number": m.group(2), "path": os.path.relpath(os.path.join(dp, f), dev_dir)})
    rows.sort(key=lambda r: (r["ts"], r["pos"]))
    return rows


def consensus(rows, slow_positions, window):
    by_pos = defaultdict(list)
    for r in rows:
        by_pos[r["pos"]].append(r)
    for pos in slow_positions:
        seq = by_pos.get(pos, [])
        for i, r in enumerate(seq):
            lo, hi = max(0, i - window), min(len(seq), i + window + 1)
            votes = Counter(x["cnn"] for x in seq[lo:hi] if x["cnn"] < 10)
            if not votes:
                continue
            digit, n = votes.most_common(1)[0]
            # require a clear majority so rollovers stay unlabelled (left to the VLM)
            if n >= 0.7 * sum(votes.values()):
                r["consensus"] = digit


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("device_dir")
    ap.add_argument("--slow", default="1,2,3,4",
                    help="positions treated as slow wheels (comma list). Default 1-4")
    ap.add_argument("--window", type=int, default=12, help="half window in cycles (default 12 = ±1 h)")
    a = ap.parse_args()

    rows = index_crops(a.device_dir)
    consensus(rows, [int(x) for x in a.slow.split(",") if x], a.window)

    out_dir = os.path.join(a.device_dir, "labels")
    os.makedirs(out_dir, exist_ok=True)
    out = os.path.join(out_dir, "crops.csv")
    with open(out, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["device", "ts", "pos", "cnn", "consensus", "path"])
        w.writeheader()
        dev = os.path.basename(os.path.normpath(a.device_dir))
        for r in rows:
            w.writerow({"device": dev, "ts": r["ts"], "pos": r["pos"], "cnn": r["cnn"],
                        "consensus": r.get("consensus", ""), "path": r["path"]})

    # summary
    print(f"{out}: {len(rows)} crops")
    for pos in sorted({r['pos'] for r in rows}):
        rs = [r for r in rows if r["pos"] == pos]
        lab = [r for r in rs if "consensus" in r]
        dis = [r for r in lab if r["cnn"] != r["consensus"]]
        print(f"  dig{pos}: {len(rs)} crops, consensus-labelled {len(lab)}, CNN disagrees {len(dis)}"
              + (f" ({100*len(dis)/len(lab):.1f}%)" if lab else ""))


if __name__ == "__main__":
    main()
