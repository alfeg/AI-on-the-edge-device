#!/usr/bin/env python3
"""
Ask vision models (Ollama) to read digit crops. Resumable: every answer is
appended to <dev>/labels/vlm/<model>.jsonl keyed by crop path, so reruns only
query what's missing. Works against any Ollama host (local PC, nobara, ...).

Usage:
  # pilot sample (writes labels/pilot.csv once, reused by every model)
  python tools/meter-replay/vlm_label.py device-logs/gasmeter --make-pilot 300
  python tools/meter-replay/vlm_label.py device-logs/gasmeter --set pilot --model qwen3-vl:4b
  python tools/meter-replay/vlm_label.py device-logs/gasmeter --set pilot --model gemma4:e4b --host http://192.168.68.111:11434
  # score a model on the pilot set
  python tools/meter-replay/vlm_label.py device-logs/gasmeter --set pilot --model qwen3-vl:4b --score
  # relabel all fast-wheel crops
  python tools/meter-replay/vlm_label.py device-logs/gasmeter --set pos:6,7 --model qwen3-vl:8b
"""
import argparse
import base64
import csv
import io
import json
import os
import random
import re
import sys
import time
import urllib.request

from PIL import Image

PROMPT = (
    "This is a crop of ONE digit wheel of a mechanical rolling meter counter. "
    "Parts of the neighbouring digits above and below may be visible because the wheel rotates. "
    "Reply with the single digit (0-9) whose body is closest to the vertical centre of the image. "
    "If the wheel is exactly halfway between two digits, reply with both, lower first, like 3/4 "
    "(9/0 for the 9-to-0 transition). If you cannot read it, reply N. "
    "Reply with nothing else."
)


def load_crops(dev_dir):
    with open(os.path.join(dev_dir, "labels", "crops.csv"), newline="") as f:
        return list(csv.DictReader(f))


def make_pilot(dev_dir, n, seed=1):
    rows = load_crops(dev_dir)
    rnd = random.Random(seed)
    slow_dis = [r for r in rows if r["consensus"] != "" and r["cnn"] != r["consensus"]]
    slow_ok = [r for r in rows if r["consensus"] != "" and r["cnn"] == r["consensus"] and r["pos"] in ("4", "5")]
    fast = [r for r in rows if r["pos"] in ("6", "7")]
    k = n // 3
    pick = (rnd.sample(slow_dis, min(k, len(slow_dis))) + rnd.sample(slow_ok, min(k, len(slow_ok)))
            + rnd.sample(fast, min(n - 2 * k, len(fast))))
    out = os.path.join(dev_dir, "labels", "pilot.csv")
    with open(out, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=rows[0].keys())
        w.writeheader()
        w.writerows(pick)
    print(f"{out}: {len(pick)} crops ({len(slow_dis)} slow-disagree available)")


def select(dev_dir, spec):
    if spec == "pilot":
        with open(os.path.join(dev_dir, "labels", "pilot.csv"), newline="") as f:
            return list(csv.DictReader(f))
    rows = load_crops(dev_dir)
    if spec.startswith("pos:"):
        ps = set(spec[4:].split(","))
        return [r for r in rows if r["pos"] in ps]
    if spec == "all":
        return rows
    sys.exit(f"unknown --set {spec}")


def encode(path, min_h):
    im = Image.open(path).convert("RGB")
    if im.height < min_h:  # small crops read poorly; upscale like the firmware does
        s = -(-min_h // im.height)
        im = im.resize((im.width * s, im.height * s), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=92)
    return base64.b64encode(buf.getvalue()).decode()


def parse(text):
    t = (text or "").strip()
    m = re.search(r'\b(\d)\s*/\s*(\d)\b', t)
    if m:
        return f"{m.group(1)}/{m.group(2)}"
    m = re.search(r'\d', t)
    if m:
        return m.group(0)
    return "N"


def ask(host, model, b64, timeout, num_ctx):
    body = {"model": model, "stream": False, "think": False,
            "messages": [{"role": "user", "content": PROMPT, "images": [b64]}],
            "options": {"temperature": 0, "num_predict": 1500}}
    if num_ctx:
        body["options"]["num_ctx"] = num_ctx
    req = urllib.request.Request(host.rstrip("/") + "/api/chat", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        resp = json.loads(r.read())
    return resp.get("message", {}).get("content", ""), time.time() - t0


def run(a):
    rows = select(a.device_dir, a.set)
    vdir = os.path.join(a.device_dir, "labels", "vlm")
    os.makedirs(vdir, exist_ok=True)
    host_tag = re.sub(r'[^\w]+', '_', a.host.split("//")[-1])
    out = os.path.join(vdir, re.sub(r'[^\w.-]+', '_', a.model) + f"@{host_tag}.jsonl")
    done = set()
    if os.path.exists(out):
        with open(out) as f:
            done = {json.loads(l)["path"] for l in f if l.strip()}
    todo = [r for r in rows if r["path"] not in done]
    print(f"{a.model}@{a.host}: {len(rows)} selected, {len(done)} cached, {len(todo)} to query -> {out}")
    num_ctx = 12288 if "glm-ocr" in a.model else None
    errors = 0
    with open(out, "a") as f:
        for i, r in enumerate(todo, 1):
            try:
                text, dt = ask(a.host, a.model, encode(os.path.join(a.device_dir, r["path"]), a.min_h),
                               a.timeout, num_ctx)
            except Exception as e:
                errors += 1
                print(f"  error on {r['path']}: {e}")
                if errors >= 5:
                    sys.exit("too many errors, stopping (rerun to resume)")
                time.sleep(3)
                continue
            errors = 0
            f.write(json.dumps({"path": r["path"], "answer": parse(text), "raw": text[:80],
                                "sec": round(dt, 3)}) + "\n")
            f.flush()
            if i % 50 == 0:
                print(f"  {i}/{len(todo)}  last {dt:.2f}s")
    return out


def score(a):
    rows = {r["path"]: r for r in select(a.device_dir, a.set)}
    vdir = os.path.join(a.device_dir, "labels", "vlm")
    for fn in sorted(os.listdir(vdir)):
        if a.model and not fn.startswith(re.sub(r'[^\w.-]+', '_', a.model) + "@"):
            continue
        ans = {}
        with open(os.path.join(vdir, fn)) as f:
            for l in f:
                j = json.loads(l)
                if j["path"] in rows:
                    ans[j["path"]] = j
        if not ans:
            continue
        lab = [(rows[p], j) for p, j in ans.items() if rows[p]["consensus"] != ""]
        hard = [(r, j) for r, j in lab if r["cnn"] != r["consensus"]]

        def ok(r, j):
            return r["consensus"] in j["answer"].split("/")
        acc = sum(ok(r, j) for r, j in lab) / len(lab) if lab else float("nan")
        hacc = sum(ok(r, j) for r, j in hard) / len(hard) if hard else float("nan")
        cnn_hard = 0.0  # by construction the CNN is wrong on every 'hard' crop
        sec = sorted(j["sec"] for j in ans.values())
        nN = sum(j["answer"] == "N" for j in ans.values())
        print(f"{fn[:-6]:45s} n={len(ans):4d}  acc(slow,labelled)={acc:6.1%}  "
              f"acc(CNN-wrong crops)={hacc:6.1%} [CNN {cnn_hard:.0%}]  N={nN:3d}  "
              f"median {sec[len(sec)//2]:.2f}s  p90 {sec[int(len(sec)*0.9)]:.2f}s")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("device_dir")
    ap.add_argument("--make-pilot", type=int)
    ap.add_argument("--set", default="pilot")
    ap.add_argument("--model")
    ap.add_argument("--host", default="http://localhost:11434")
    ap.add_argument("--timeout", type=float, default=120)
    ap.add_argument("--min-h", type=int, default=128, help="upscale crops to at least this height")
    ap.add_argument("--score", action="store_true")
    a = ap.parse_args()
    if a.make_pilot:
        make_pilot(a.device_dir, a.make_pilot)
    elif a.score:
        score(a)
    elif a.model:
        run(a)
    else:
        ap.error("need --make-pilot, --model, or --score")


if __name__ == "__main__":
    main()
