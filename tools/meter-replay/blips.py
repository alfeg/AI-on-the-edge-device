#!/usr/bin/env python3
"""
Blip forensics: reconstruct the value stream Home Assistant received from a
device's data_*.csv files and classify every suspicious step.

HA gets `<topic>/value` only when ReturnValue is non-empty, so the published
stream = rows with a non-empty Value column. A "blip" is a published step that
goes backwards (impossible for a cumulative meter) or jumps up by more than
--max-step, usually followed by a reversal.

Usage:
  python tools/meter-replay/blips.py device-logs/gasmeter
  python tools/meter-replay/blips.py device-logs/watermeter --max-step 0.2
"""
import argparse
import csv
import glob
import os
import re
from collections import Counter, defaultdict

COLS = ["ts", "name", "raw", "value", "pre", "rate", "chg", "err"]


def load(device_dir):
    rows = []
    for f in sorted(glob.glob(os.path.join(device_dir, "log", "data", "data_*.csv"))):
        if "1970-01-01" in f:
            continue
        with open(f, newline="", encoding="utf-8", errors="replace") as fh:
            for rec in csv.reader(fh):
                if len(rec) < 8:
                    continue
                r = dict(zip(COLS, rec[:8]))
                r["digits"] = rec[8:]
                r["file"] = os.path.basename(f)
                rows.append(r)
    rows.sort(key=lambda r: r["ts"])
    return rows


def fnum(s):
    try:
        return float(s)
    except (TypeError, ValueError):
        return None


def cause(err):
    e = err or ""
    for key, label in [("LLM arbiter accepted", "arbiter"),
                       ("Stuck recovery", "stuck-reanchor"),
                       ("witnessed", "two-witness"),
                       ("Neg. Rate", "neg-rate-held"),
                       ("Rate too high", "rate-high-held"),
                       ("no error", "clean")]:
        if key in e:
            return label
    return "other:" + e[:40]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("device_dir")
    ap.add_argument("--max-step", type=float, default=0.3,
                    help="max plausible increase between two published values (m³)")
    ap.add_argument("--show", type=int, default=25, help="print first N blips")
    a = ap.parse_args()

    rows = load(a.device_dir)
    pub = [r for r in rows if fnum(r["value"]) is not None]
    print(f"{a.device_dir}: {len(rows)} cycles, {len(pub)} published values, "
          f"{rows[0]['ts'][:16] if rows else '-'} .. {rows[-1]['ts'][:16] if rows else '-'}")
    print("cycle outcomes:", dict(Counter(cause(r["err"]) for r in rows).most_common()))

    blips, prev = [], None
    for r in pub:
        v = fnum(r["value"])
        if prev is not None:
            d = v - fnum(prev["value"])
            if d < -1e-9 or d > a.max_step:
                blips.append((prev, r, d))
        prev = r

    neg = [b for b in blips if b[2] < 0]
    pos = [b for b in blips if b[2] > 0]
    print(f"\nblips: {len(blips)} ({len(neg)} backwards, {len(pos)} too-large forward); "
          f"sum of backwards steps {sum(b[2] for b in neg):.3f}")
    print("blip cause (cycle that published the bad step):",
          dict(Counter(cause(b[1]['err']) for b in blips).most_common()))

    # Which digit position changed in the blip step?
    pos_counter = Counter()
    for p, r, d in blips:
        for i, (x, y) in enumerate(zip(p["digits"], r["digits"])):
            if x != y:
                pos_counter[f"dig{i + 1}"] += 1
    print("digit positions that changed in blip steps:", dict(pos_counter.most_common()))

    per_day = defaultdict(int)
    for _, r, _ in blips:
        per_day[r["ts"][:10]] += 1
    print("blips per day:", dict(sorted(per_day.items())))

    print(f"\nfirst {a.show} blips:")
    for p, r, d in blips[:a.show]:
        print(f"  {r['ts'][:16]}  {p['value']:>10} -> {r['value']:>10}  d={d:+.3f}  "
              f"raw={r['raw']:<10} digits {','.join(p['digits'])} -> {','.join(r['digits'])}  "
              f"[{cause(r['err'])}] {r['err'][:70]}")


if __name__ == "__main__":
    main()
