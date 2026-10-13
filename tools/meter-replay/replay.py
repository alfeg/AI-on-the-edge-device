#!/usr/bin/env python3
"""
Replay emulator: run candidate publishing policies over the recorded per-cycle
readings and score what Home Assistant would have received.

Input : <dev>/log/data/data_*.csv (raw CNN reading per cycle + what the device published)
Truth : monotone (isotonic, PAV) fit of the raw readings after a rolling-median
        prefilter -- a robust estimate of the true cumulative meter value that
        needs no labels. Good enough to score blips; refined later by crop labels.

Metrics per policy:
  published     cycles with a value sent to HA (coverage)
  decreases     published steps < 0             (each is a negative HA bar)
  overjumps     published steps > physical max  (rate * elapsed + slack)
  mae / p99     |published - truth|
  max_err       worst |published - truth|

Usage: python tools/meter-replay/replay.py device-logs/gasmeter [--max-rate 0.02]
"""
import argparse
import csv
import datetime as dt
import glob
import math
import os
import statistics


def load(dev_dir):
    rows = []
    for f in sorted(glob.glob(os.path.join(dev_dir, "log", "data", "data_*.csv"))):
        if "1970-01-01" in f:
            continue
        with open(f, newline="", encoding="utf-8", errors="replace") as fh:
            for rec in csv.reader(fh):
                if len(rec) < 8:
                    continue
                try:
                    t = dt.datetime.strptime(rec[0][:19], "%Y-%m-%dT%H:%M:%S")
                except ValueError:
                    continue
                rows.append({"t": t, "raw": num(rec[2]), "dev": num(rec[3]), "digits": rec[8:]})
    rows.sort(key=lambda r: r["t"])
    return rows


def num(s):
    try:
        v = float(s)
        return v if math.isfinite(v) else None
    except (TypeError, ValueError):
        return None


def pav(y):
    """Pool-adjacent-violators: least-squares non-decreasing fit."""
    blocks = []  # [sum, count]
    for v in y:
        blocks.append([v, 1])
        while len(blocks) > 1 and blocks[-2][0] / blocks[-2][1] > blocks[-1][0] / blocks[-1][1]:
            s, c = blocks.pop()
            blocks[-1][0] += s
            blocks[-1][1] += c
    out = []
    for s, c in blocks:
        out += [s / c] * c
    return out


def truth(rows, win=7):
    """Robust monotone envelope: rolling median, then backward running-min (kills high
    spikes/plateaus that are later contradicted), then forward running-max (kills low
    dips, even multi-hour ones, as long as a correct earlier value exists)."""
    idx = [i for i, r in enumerate(rows) if r["raw"] is not None]
    raw = [rows[i]["raw"] for i in idx]
    med = [statistics.median(raw[max(0, k - win):k + win + 1]) for k in range(len(raw))]
    # gross-outlier guard: snap anything far from the long (±6 h) median onto it
    lw = 36
    long_med = [statistics.median(med[max(0, k - lw):k + lw + 1]) for k in range(len(med))]
    med = [m if abs(m - L) <= 2.0 else L for m, L in zip(med, long_med)]
    bmin = med[:]
    for k in range(len(bmin) - 2, -1, -1):
        bmin[k] = min(bmin[k], bmin[k + 1])
    fit = bmin[:]
    for k in range(1, len(fit)):
        fit[k] = max(fit[k], fit[k - 1])
    tr = [None] * len(rows)
    for k, i in enumerate(idx):
        tr[i] = fit[k]
    # carry forward over N-cycles
    last = None
    for i in range(len(tr)):
        if tr[i] is None:
            tr[i] = last
        last = tr[i]
    return tr


# ---------------- policies ----------------

def policy_device(rows, cfg):
    return [r["dev"] for r in rows]


def policy_raw(rows, cfg):
    return [r["raw"] for r in rows]


def policy_gate(rows, cfg):
    """Never decrease; never exceed rate*elapsed; hold when in doubt.
    Re-anchor when K consecutive rejected readings agree with each other (stuck escape),
    but only upward or after a long hold (a poisoned high value is handled by the
    downward escape after cfg.escape_down cycles)."""
    out, last, last_t, pend = [], None, None, []
    for r in rows:
        v = r["raw"]
        pubv = None
        if v is not None:
            if last is None:
                pubv = v
            else:
                mins = max(1.0, (r["t"] - last_t).total_seconds() / 60)
                lim = cfg.max_rate * mins + cfg.slack
                if 0 <= v - last <= lim:
                    pubv = v
                else:
                    pend.append(v)
                    k = cfg.escape
                    recent = pend[-k:]
                    if len(recent) == k and max(recent) - min(recent) <= cfg.slack * 2:
                        cand = statistics.median(recent)
                        if cand > last or len(pend) >= cfg.escape_down:
                            pubv = cand
        if pubv is not None:
            last, last_t, pend = pubv, r["t"], []
        out.append(pubv)
    return out


def policy_gate_db(rows, cfg):
    """Gate with a dead-band and no published decreases at all.
    - reading within [last - deadband, last): treated as 'unchanged', republish last
    - reading above the physical limit: held; K agreeing held readings re-anchor upward
    - reading below the dead-band: held; if K agreeing readings persist for escape_down
      cycles the internal anchor moves down, but nothing is published until the reading
      climbs back above the last published value (HA never sees a decrease)."""
    out, last_pub, anchor, anchor_t, pend = [], None, None, None, []
    for r in rows:
        v, pubv = r["raw"], None
        if v is not None:
            if anchor is None:
                anchor, anchor_t, pubv = v, r["t"], v
            else:
                mins = max(1.0, (r["t"] - anchor_t).total_seconds() / 60)
                lim = cfg.max_rate * mins + cfg.slack
                d = v - anchor
                if -cfg.deadband <= d < 0:
                    pubv = anchor if last_pub is not None else None
                    pend = []
                elif 0 <= d <= lim:
                    anchor, anchor_t, pend, pubv = v, r["t"], [], v
                else:
                    pend.append(v)
                    recent = pend[-cfg.escape:]
                    if len(recent) == cfg.escape and max(recent) - min(recent) <= cfg.slack * 2:
                        cand = statistics.median(recent)
                        if cand > anchor or len(pend) >= cfg.escape_down:
                            anchor, anchor_t, pend = cand, r["t"], []
                            pubv = cand
        if pubv is not None and last_pub is not None and pubv < last_pub:
            # never publish a decrease; within the dead-band republish the last value ("unchanged")
            pubv = last_pub if last_pub - pubv <= cfg.deadband else None
        if pubv is not None:
            last_pub = pubv
        out.append(pubv)
    return out


def policy_firmware(rows, cfg):
    """Approximation of ClassFlowPostProcessing::doFlow with the deployed settings
    (AllowNegativeRates=false, MaxRateType=AbsoluteChange, ChangeRateThreshold dead-band,
    two-witness, StuckEscapeCycles re-anchor). Cycles with an unreadable digit are
    skipped (the firmware would substitute N digits from PreValue)."""
    out, pre, suspect, clamp = [], None, None, []
    band = cfg.fw_crt / (10 ** cfg.fw_nachkomma)
    for r in rows:
        v, pubv = r["raw"], None
        if v is not None:
            if pre is None:
                pubv = v
            else:
                if abs(v - pre) <= band:
                    v = pre
                violating = (v < pre) or (abs(v - pre) > cfg.fw_maxrate)
                if not violating:
                    pubv = v
                else:
                    if suspect is not None and abs(v - suspect) <= cfg.fw_maxrate * 1.5:
                        pubv = v                       # two-witness confirmed
                    else:
                        clamp.append(v)
                        k = cfg.fw_stuck
                        recent = clamp[-k:] if k > 0 else []
                        tol = max(0.5, cfg.fw_maxrate * k * 1.5)
                        if k > 0 and len(recent) == k and max(recent) - min(recent) <= tol:
                            pubv = sorted(recent)[k // 2]   # stuck re-anchor
                        else:
                            suspect = v
        if pubv is not None:
            pre, suspect, clamp = pubv, None, []
        out.append(pubv)
    return out


POLICIES = {"device": policy_device, "raw": policy_raw, "gate": policy_gate, "gate_db": policy_gate_db,
            "firmware": policy_firmware}


def score(name, pub, rows, tr, cfg):
    n = len(rows)
    vals = [(i, v) for i, v in enumerate(pub) if v is not None]
    dec = over = 0
    errs = []
    prev = None
    for i, v in vals:
        if tr[i] is not None:
            errs.append(abs(v - tr[i]))
        if prev is not None:
            pi, pv = prev
            d = v - pv
            mins = max(1.0, (rows[i]["t"] - rows[pi]["t"]).total_seconds() / 60)
            if d < -1e-9:
                dec += 1
            elif d > cfg.max_rate * mins + cfg.slack:
                over += 1
        prev = (i, v)
    errs.sort()
    p = lambda q: errs[min(len(errs) - 1, int(len(errs) * q))] if errs else float("nan")
    print(f"  {name:8s} published {len(vals):5d}/{n} ({len(vals)/n:5.1%})  decreases {dec:4d}  "
          f"overjumps {over:4d}  mae {statistics.mean(errs) if errs else float('nan'):8.3f}  "
          f"p99 {p(0.99):8.3f}  max {errs[-1] if errs else float('nan'):10.2f}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("device_dir")
    ap.add_argument("--max-rate", type=float, default=0.02, help="max physical m³/min (default 0.02 = 1.2 m³/h)")
    ap.add_argument("--slack", type=float, default=0.02, help="tolerance m³ (default 0.02)")
    ap.add_argument("--escape", type=int, default=3, help="agreeing rejected readings to re-anchor")
    ap.add_argument("--escape-down", type=int, default=12, help="rejected cycles before allowing downward re-anchor")
    ap.add_argument("--deadband", type=float, default=0.1, help="readings this far below last count as unchanged")
    ap.add_argument("--fw-maxrate", type=float, default=0.7, help="firmware MaxRateValue (deployed 0.7)")
    ap.add_argument("--fw-crt", type=float, default=3, help="firmware ChangeRateThreshold (deployed 3)")
    ap.add_argument("--fw-nachkomma", type=int, default=2)
    ap.add_argument("--fw-stuck", type=int, default=6, help="firmware StuckEscapeCycles (default 6)")
    ap.add_argument("--since", help="YYYY-MM-DD: ignore data before this day")
    cfg = ap.parse_args()

    rows = load(cfg.device_dir)
    if cfg.since:
        rows = [r for r in rows if r["t"] >= dt.datetime.strptime(cfg.since, "%Y-%m-%d")]
    tr = truth(rows)
    print(f"{cfg.device_dir}: {len(rows)} cycles {rows[0]['t']:%Y-%m-%d} .. {rows[-1]['t']:%Y-%m-%d}  "
          f"(max_rate {cfg.max_rate}/min, slack {cfg.slack})")
    for name, fn in POLICIES.items():
        score(name, fn(rows, cfg), rows, tr, cfg)


if __name__ == "__main__":
    main()
