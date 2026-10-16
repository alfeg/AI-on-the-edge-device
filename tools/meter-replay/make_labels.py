#!/usr/bin/env python3
"""
Merge label evidence into final ground-truth labels per digit crop.

Evidence per crop:
  consensus  temporal-stability label (slow wheels only, crops.py)
  teacher    vision-model answer (labels/vlm/<teacher>.jsonl): "d", "a/b" (mid-roll) or "N"
  cont       dig-cont model position (labels/pred_dig-cont_0900_s3_q.tflite.csv), round() -> centred digit
  cnn        the device's own class (file-name prefix), 10 = N

Rules (first match wins):
  0. human label in labels/manual_*.csv (path,label)              -> that label     [high / transition]
     label "x" = unusable crop (occluded, misaligned)             ->                [excluded]
  1. consensus present and (teacher agrees or cont agrees)        -> consensus      [high]
  2. teacher single digit == cont digit                           -> that digit     [high]
  3. teacher "a/b" and cont position within 0.3 of the a/b boundary -> "a/b"       [transition]
  4. consensus present, both others disagree                      -> review
  5. teacher single digit == cnn                                  -> that digit     [medium]
  6. otherwise                                                    -> review

Output: labels/final.csv (path,pos,label,quality,consensus,teacher,cont,cnn)
        labels/review.csv (the 'review' rows, for a human / second teacher)
"""
import argparse
import csv
import json
import os
from collections import Counter


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("device_dir")
    ap.add_argument("--teacher", default="gemma4_12b@localhost_11434")
    ap.add_argument("--cont", default="dig-cont_0900_s3_q.tflite")
    a = ap.parse_args()
    L = os.path.join(a.device_dir, "labels")

    crops = list(csv.DictReader(open(os.path.join(L, "crops.csv"), newline="")))
    teacher = {}
    tp = os.path.join(L, "vlm", a.teacher + ".jsonl")
    if os.path.exists(tp):
        for line in open(tp):
            j = json.loads(line)
            teacher[j["path"]] = j["answer"]
    cont = {}
    cp = os.path.join(L, f"pred_{a.cont}.csv")
    if os.path.exists(cp):
        for r in csv.DictReader(open(cp, newline="")):
            if r["value"] != "":
                cont[r["path"]] = float(r["value"])
    manual = {}
    for fn in sorted(os.listdir(L)):
        if fn.startswith("manual_") and fn.endswith(".csv"):
            for r in csv.DictReader(open(os.path.join(L, fn), newline="")):
                manual[r["path"]] = r["label"].strip()

    out, review = [], []
    q = Counter()
    for r in crops:
        p = r["path"]
        cons = r["consensus"]
        t = teacher.get(p, "")
        cv = cont.get(p)
        cd = str(int(round(cv)) % 10) if cv is not None else ""
        cnn = "" if r["cnn"] == "10" else r["cnn"]
        tset = t.split("/") if t and t != "N" else []
        label, qual = "", "review"
        if cons and (cons in tset or cons == cd):
            label, qual = cons, "high"
        elif len(tset) == 1 and tset[0] == cd:
            label, qual = cd, "high"
        elif len(tset) == 2 and cv is not None:
            lo = int(tset[0])
            boundary = (lo + 0.5) % 10
            dist = min(abs(cv - boundary), 10 - abs(cv - boundary))
            if dist <= 0.3:
                label, qual = t, "transition"
        if not label and not cons and len(tset) == 1 and tset[0] == cnn:
            label, qual = cnn, "medium"
        if not t and not cons:
            qual = "unlabelled"  # teacher not run on this crop (e.g. slow wheel without consensus)
        if p in manual:
            m = manual[p]
            label, qual = ("", "excluded") if m == "x" else (m, "transition" if "/" in m else "high")
        q[(r["pos"], qual)] += 1
        row = {"path": p, "pos": r["pos"], "label": label, "quality": qual, "consensus": cons,
               "teacher": t, "cont": "" if cv is None else f"{cv:.2f}", "cnn": r["cnn"]}
        out.append(row)
        if qual == "review":
            review.append(row)

    fields = ["path", "pos", "label", "quality", "consensus", "teacher", "cont", "cnn"]
    for name, rows in (("final.csv", out), ("review.csv", review)):
        with open(os.path.join(L, name), "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=fields)
            w.writeheader()
            w.writerows(rows)

    print(f"{a.device_dir}: {len(out)} crops, teacher answers {len(teacher)}, cont preds {len(cont)}")
    for pos in sorted({r['pos'] for r in out}, key=int):
        parts = {k[1]: v for k, v in q.items() if k[0] == pos}
        print(f"  dig{pos}: " + "  ".join(f"{k} {v}" for k, v in sorted(parts.items())))
    # how often was the device CNN wrong where we have a confident label?
    for pos in sorted({r['pos'] for r in out}, key=int):
        conf = [r for r in out if r["pos"] == pos and r["quality"] == "high"]
        if conf:
            wrong = sum(r["cnn"] != r["label"] for r in conf)
            print(f"  dig{pos}: device CNN wrong on {wrong}/{len(conf)} high-confidence crops ({wrong/len(conf):.1%})")


if __name__ == "__main__":
    main()
