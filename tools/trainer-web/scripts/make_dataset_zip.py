#!/usr/bin/env python3
"""
Pack a prepared dataset (dataset_meta.csv: path, src, pos, label, split, ts, weight, kind;
rows with weight 0, no label or kind "hard" are left out) into the trainer-web dataset zip:
  labels.csv   path,src,pos,label,split,ts
  images/NNNNNN.jpg   original crop files

  python tools/trainer-web/scripts/make_dataset_zip.py dataset_meta.csv out.zip
"""
import csv
import os
import sys
import zipfile


def main():
    meta, out = sys.argv[1], sys.argv[2]
    rows = [r for r in csv.DictReader(open(meta, newline=""))
            if float(r["weight"]) > 0 and r["label"] and r["kind"] != "hard"]
    with zipfile.ZipFile(out, "w", zipfile.ZIP_STORED) as z:  # JPEGs don't compress further
        lines = ["path,src,pos,label,split,ts"]
        for i, r in enumerate(rows):
            name = f"images/{i:06d}.jpg"
            z.write(r["path"], name)
            lines.append(f"{name},{r['src']},{r['pos']},{r['label']},{r['split']},{r['ts']}")
        z.writestr("labels.csv", "\n".join(lines) + "\n")
    print(f"{out}: {len(rows)} crops, {os.path.getsize(out) / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
