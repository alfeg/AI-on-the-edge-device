#!/usr/bin/env python3
"""
Cut ROI crops out of the raw images the device keeps in /log/source, the way the
firmware does it (ClassFlowAlignment: InitialRotate -> find ref0/ref1 -> Translate +
Rotate -> cut ROI). Lets us build crops for a wheel the device is not (yet) reading,
e.g. a new last decimal wheel, from weeks of already-synced raw images.

Check mode compares our crop of an existing ROI with the crop the device saved in
/log/digit for the same cycle (mean abs pixel difference), to prove the alignment
matches the firmware before trusting crops of the new ROI.

Run with the venv:
  tools/meter-replay/.venv/Scripts/python tools/meter-replay/extract_rois.py
      device-logs/watermeter device-logs/watermeter/snapshots/<snap> dig8:518,105,46,81
      [--check dig7:459,105,46,81] [--limit N]
Output: <dev>/log/extracted/<roi>/<YYYYMMDD>/<HH>/main_<roi>_<ts>.jpg + <dev>/labels/extracted_<roi>.csv
"""
import argparse
import csv
import glob
import math
import os
import re

import cv2
import numpy as np


def read_config(path):
    cfg = {"refs": []}
    for line in open(path, encoding="utf-8", errors="replace"):
        s = line.strip()
        if s.startswith("InitialRotate"):
            cfg["rot"] = float(s.split("=")[1])
        elif s.startswith("SearchFieldX"):
            cfg["sx"] = int(s.split("=")[1])
        elif s.startswith("SearchFieldY"):
            cfg["sy"] = int(s.split("=")[1])
        elif s.startswith("/config/ref"):
            name, x, y = s.split()[:3]
            cfg["refs"].append((os.path.basename(name), int(x), int(y)))
    return cfg


def fw_rotate(img, angle, cx=None, cy=None):
    """CRotateImage::Rotate: target(x,y) <- source(int(m.x), int(m.y)), white outside."""
    h, w = img.shape[:2]
    cx = w / 2 if cx is None else cx
    cy = h / 2 if cy is None else cy
    a = angle / 180 * math.pi
    c, s = math.cos(a), math.sin(a)
    m02 = (1 - c) * cx - s * cy
    m12 = s * cx + (1 - c) * cy
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
    xsrc = (c * xs + s * ys).astype(np.int32) + int(m02)
    ysrc = (-s * xs + c * ys).astype(np.int32) + int(m12)
    ok = (xsrc >= 0) & (xsrc < w) & (ysrc >= 0) & (ysrc < h)
    out = np.full_like(img, 255)
    out[ok] = img[ysrc[ok], xsrc[ok]]
    return out


def fw_translate(img, dx, dy):
    h, w = img.shape[:2]
    out = np.full_like(img, 255)
    xs0, xd0 = max(0, -dx), max(0, dx)
    ys0, yd0 = max(0, -dy), max(0, dy)
    ww, hh = w - abs(dx), h - abs(dy)
    out[yd0:yd0 + hh, xd0:xd0 + ww] = img[ys0:ys0 + hh, xs0:xs0 + ww]
    return out


def find(img, tpl, tx, ty, sx, sy):
    """Best top-left of tpl within +-search field of (tx, ty), SAD on RGB."""
    th, tw = tpl.shape[:2]
    h, w = img.shape[:2]
    x0, y0 = max(0, tx - sx), max(0, ty - sy)
    x1, y1 = min(w, tx + sx + tw), min(h, ty + sy + th)
    win = img[y0:y1, x0:x1]
    r = cv2.matchTemplate(win.astype(np.float32), tpl.astype(np.float32), cv2.TM_SQDIFF)
    _, _, loc, _ = cv2.minMaxLoc(r)
    return x0 + loc[0], y0 + loc[1]


def align(raw, cfg, tpls):
    img = fw_rotate(raw, cfg["rot"])
    (n0, t0x, t0y), (n1, t1x, t1y) = cfg["refs"][:2]
    f0x, f0y = find(img, tpls[n0], t0x, t0y, cfg["sx"], cfg["sy"])
    f1x, f1y = find(img, tpls[n1], t1x, t1y, cfg["sx"], cfg["sy"])
    dx, dy = t0x - f0x, t0y - f0y
    w_org = math.atan2(f1y - f0y, f1x - f0x)
    w_ist = math.atan2((t1y + dy) - (t0y + dy), (t1x + dx) - (t0x + dx))
    d = (w_ist - w_org) * 180 / math.pi
    img = fw_translate(img, dx, dy)
    return fw_rotate(img, d, t0x, t0y)


def parse_roi(s):
    name, xywh = s.split(":")
    return name, tuple(int(v) for v in xywh.split(","))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("device_dir")
    ap.add_argument("snapshot", help="dir with config.ini + ref*.jpg")
    ap.add_argument("roi", nargs="+", help="name:x,y,w,h")
    ap.add_argument("--check", help="name:x,y,w,h of an ROI the device already logs")
    ap.add_argument("--limit", type=int, default=0)
    a = ap.parse_args()

    cfg = read_config(os.path.join(a.snapshot, "config.ini"))
    tpls = {n: cv2.cvtColor(cv2.imread(os.path.join(a.snapshot, n)), cv2.COLOR_BGR2RGB) for n, _, _ in cfg["refs"]}
    rois = [parse_roi(r) for r in a.roi]
    check = parse_roi(a.check) if a.check else None

    raws = sorted(glob.glob(os.path.join(a.device_dir, "log", "source", "2*", "*", "raw_*.jpg")))
    if a.limit:
        raws = raws[:: max(1, len(raws) // a.limit)]
    rows, diffs = {n: [] for n, _ in rois}, []
    for i, p in enumerate(raws):
        ts = re.search(r"raw_(\d{8}-\d{6})", p).group(1)
        raw = cv2.imread(p)
        if raw is None:
            continue
        img = align(cv2.cvtColor(raw, cv2.COLOR_BGR2RGB), cfg, tpls)
        for name, (x, y, w, h) in rois:
            rel = os.path.join("log", "extracted", name, ts[:8], ts[9:11], f"main_{name}_{ts}.jpg")
            out = os.path.join(a.device_dir, rel)
            os.makedirs(os.path.dirname(out), exist_ok=True)
            cv2.imwrite(out, cv2.cvtColor(img[y:y + h, x:x + w], cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 95])
            rows[name].append(dict(ts=ts, path=rel))
        if check:
            cname, (x, y, w, h) = check
            dev = glob.glob(os.path.join(a.device_dir, "log", "digit", ts[:8], ts[9:11], f"*_main_{cname}_{ts}.jpg"))
            if dev:
                d = cv2.cvtColor(cv2.imread(dev[0]), cv2.COLOR_BGR2RGB).astype(np.float32)
                ours = img[y:y + h, x:x + w].astype(np.float32)
                if d.shape == ours.shape:
                    diffs.append(float(np.abs(d - ours).mean()))
        if i % 500 == 0:
            print(f"{i}/{len(raws)}", flush=True)

    for name, rs in rows.items():
        out = os.path.join(a.device_dir, "labels", f"extracted_{name}.csv")
        with open(out, "w", newline="") as f:
            wr = csv.DictWriter(f, ["ts", "path"])
            wr.writeheader()
            wr.writerows(rs)
        print(f"{name}: {len(rs)} crops -> {out}")
    if diffs:
        d = np.array(diffs)
        print(f"check {check[0]}: n={len(d)} mean|diff| median={np.median(d):.1f} p90={np.percentile(d, 90):.1f} "
              f"max={d.max():.1f} (0..255; JPEG noise alone is ~2-4)")


if __name__ == "__main__":
    main()
