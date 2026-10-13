#!/usr/bin/env python3
"""
Repair Home Assistant long-term statistics for a meter sensor from the
recorded device readings.

  plan   : fetch HA hourly statistics (WebSocket recorder/statistics_during_period),
           compute the true hourly consumption from <dev>/log/data/*.csv with the
           robust monotone truth of replay.py, and write a correction plan CSV
           (hour, ha_change, true_change, adjustment).
  apply  : send each non-zero adjustment with recorder/adjust_sum_statistics
           (the same call as the UI "adjust sum" button). Reversible: re-apply the
           plan with --undo.

The token is read from ~/.ha-token (HA long-lived access token).

Run: tools/meter-replay/.venv/Scripts/python tools/meter-replay/ha_stats.py plan \
       device-logs/watermeter sensor.watermeter_value [--since 2026-10-01]
     ... apply <plan.csv> [--undo]
"""
import argparse
import asyncio
import csv
import datetime as dt
import json
import os
import sys

import websockets

sys.path.insert(0, os.path.dirname(__file__))
import replay  # noqa: E402

HA = os.environ.get("HA_URL", "ws://192.168.68.111:8123/api/websocket")
UTC = dt.timezone.utc


def token():
    with open(os.path.expanduser("~/.ha-token")) as f:
        return f.read().strip()


class HAClient:
    async def __aenter__(self):
        self.ws = await websockets.connect(HA, max_size=64 * 1024 * 1024)
        await self.ws.recv()
        await self.ws.send(json.dumps({"type": "auth", "access_token": token()}))
        r = json.loads(await self.ws.recv())
        if r.get("type") != "auth_ok":
            raise SystemExit(f"HA auth failed: {r}")
        self.n = 0
        return self

    async def __aexit__(self, *a):
        await self.ws.close()

    async def call(self, **msg):
        self.n += 1
        msg["id"] = self.n
        await self.ws.send(json.dumps(msg))
        while True:
            r = json.loads(await self.ws.recv())
            if r.get("id") == self.n:
                if not r.get("success"):
                    raise SystemExit(f"HA error: {r.get('error')}")
                return r.get("result")


def local_tz():
    return dt.datetime.now().astimezone().tzinfo


async def fetch_hours(stat_id, start, end):
    async with HAClient() as ha:
        meta = await ha.call(type="recorder/get_statistics_metadata", statistic_ids=[stat_id])
        res = await ha.call(type="recorder/statistics_during_period",
                            start_time=start.isoformat(), end_time=end.isoformat(),
                            statistic_ids=[stat_id], period="hour",
                            types=["state", "sum", "change"])
    rows = res.get(stat_id, [])
    out = []
    for r in rows:
        t = r["start"]
        t = dt.datetime.fromtimestamp(t / 1000, UTC) if isinstance(t, (int, float)) else dt.datetime.fromisoformat(t)
        out.append({"start": t, "state": r.get("state"), "sum": r.get("sum"), "change": r.get("change")})
    return meta, out


def true_hourly_from_ha(ha_rows, max_rate_h, slack, max_flat_h=0):
    """Truth from HA's own hourly `state` series (works for the whole retained history,
    not just the days still on the device).

    1. Longest physically possible chain: the largest subset of hourly states that
       never decreases and never rises faster than max_rate_h * hours + slack
       (O(n^2) DP; survives misreads that persist for weeks, unlike a median).
    2. Off-chain states that are a whole multiple of 1000 away from the chain
       (a misread leading digit) are shifted back, keeping the real hourly profile.
    3. Everything else is linearly interpolated between chain points; cummax keeps it monotone."""
    import numpy as np
    pts = [(r["start"], r["state"]) for r in ha_rows if r["state"] is not None]
    t = np.array([p[0].timestamp() / 3600.0 for p in pts])
    v = np.array([p[1] for p in pts], dtype=float)
    n = len(v)
    best = np.ones(n, dtype=int)
    prev = np.full(n, -1)
    for i in range(1, n):
        dv = v[i] - v[:i]
        ok = (dv >= 0) & (dv <= max_rate_h * (t[i] - t[:i]) + slack)
        if ok.any():
            cand = np.where(ok, best[:i], 0)
            j = int(cand.argmax())
            best[i] = cand[j] + 1
            prev[i] = j
    chain = []
    i = int(best.argmax())
    while i >= 0:
        chain.append(i)
        i = prev[i]
    chain = np.array(chain[::-1])
    if max_flat_h > 0:
        # a frozen reading (stuck camera / device offline) is not "no consumption":
        # drop the interior of long flat runs so their usage is spread by interpolation
        keep, k, dropped = [], 0, 0
        while k < len(chain):
            e = k
            while e + 1 < len(chain) and v[chain[e + 1]] == v[chain[k]]:
                e += 1
            if t[chain[e]] - t[chain[k]] > max_flat_h:
                keep.append(chain[k])
                dropped += e - k
            else:
                keep.extend(chain[k:e + 1])
            k = e + 1
        chain = np.array(keep)
        print(f"truth: {dropped} states in flat runs > {max_flat_h} h treated as unknown")
    interp = np.interp(t, t[chain], v[chain])
    out = interp.copy()
    on = np.zeros(n, dtype=bool)
    on[chain] = True
    out[on] = v[on]
    shifted = 0
    for k in np.where(~on)[0]:
        d = interp[k] - v[k]
        m = round(d / 1000.0)
        if m != 0 and abs(d - m * 1000.0) <= max(1.0, max_rate_h * 6):
            out[k] = v[k] + m * 1000.0
            shifted += 1
    out = np.maximum.accumulate(out)
    print(f"truth: chain {len(chain)}/{n} hourly states, {shifted} digit-shifted, {n - len(chain) - shifted} interpolated")
    return {p[0]: float(x) for p, x in zip(pts, out)}


def true_hourly(dev_dir, since):
    rows = [r for r in replay.load(dev_dir) if r["t"].year >= 2020]
    if since:
        rows = [r for r in rows if r["t"] >= since]
    tr = replay.truth(rows)
    tz = local_tz()
    # value at the end of each hour = last truth value inside that hour (device log time is local)
    last = {}
    for r, v in zip(rows, tr):
        if v is None:
            continue
        h = r["t"].replace(minute=0, second=0, microsecond=0, tzinfo=tz).astimezone(UTC)
        last[h] = v
    return last


def plan(a):
    since = dt.datetime.strptime(a.since, "%Y-%m-%d") if a.since else None
    if a.device_dir == "ha":
        start = (since or dt.datetime(2020, 1, 1)).replace(tzinfo=local_tz()).astimezone(UTC)
        end = dt.datetime.now(UTC).replace(minute=0, second=0, microsecond=0)
        meta, ha_rows = asyncio.run(fetch_hours(a.statistic_id, start, end))
        truth = true_hourly_from_ha(ha_rows, a.max_rate_h, a.slack, a.max_flat_h)
    else:
        truth = true_hourly(a.device_dir, since)
        hours = sorted(truth)
        start, end = hours[0], hours[-1] + dt.timedelta(hours=1)
        meta, ha_rows = asyncio.run(fetch_hours(a.statistic_id, start, end))
    hours = sorted(truth)
    print(f"{a.statistic_id}: metadata {meta}")
    print(f"truth hours {len(hours)}  {hours[0]:%Y-%m-%d %H}Z .. {hours[-1]:%Y-%m-%d %H}Z   HA hours {len(ha_rows)}")

    # true per-hour change; hours with no reading carry the previous value forward
    true_val, prev = {}, None
    h = start
    while h < end:
        prev = truth.get(h, prev)
        true_val[h] = prev
        h += dt.timedelta(hours=1)

    plan_rows, tot_ha, tot_true = [], 0.0, 0.0
    prev_true = None
    for r in ha_rows:
        h = r["start"]
        tv = true_val.get(h)
        ha_change = r["change"] if r["change"] is not None else 0.0
        if tv is None or prev_true is None:
            prev_true = tv
            continue
        true_change = max(0.0, tv - prev_true)
        prev_true = tv
        adj = round(true_change - ha_change, 4)
        tot_ha += ha_change
        tot_true += true_change
        plan_rows.append({"hour_utc": h.isoformat(), "ha_state": r["state"], "ha_change": round(ha_change, 4),
                          "true_value": round(tv, 4), "true_change": round(true_change, 4),
                          "adjustment": adj if abs(adj) >= a.min_adj else 0.0})

    bad = [p for p in plan_rows if p["adjustment"] != 0.0]
    with open(a.out, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(plan_rows[0].keys()))
        w.writeheader()
        w.writerows(plan_rows)
    neg = sum(1 for p in plan_rows if p["ha_change"] < -1e-9)
    print(f"compared hours {len(plan_rows)}  HA negative hours {neg}  hours to adjust (|adj|>={a.min_adj}) {len(bad)}")
    print(f"total consumption  HA {tot_ha:.3f}  true {tot_true:.3f}  diff {tot_ha - tot_true:+.3f}")
    worst = sorted(bad, key=lambda p: -abs(p["adjustment"]))[:15]
    for p in worst:
        print(f"  {p['hour_utc'][:16]}  HA {p['ha_change']:+9.3f}  true {p['true_change']:+8.3f}  adj {p['adjustment']:+9.3f}")
    print(f"plan written: {a.out}")


async def apply_plan(a):
    rows = list(csv.DictReader(open(a.plan, newline="")))
    todo = [r for r in rows if float(r["adjustment"]) != 0.0]
    sign = -1.0 if a.undo else 1.0
    async with HAClient() as ha:
        meta = await ha.call(type="recorder/get_statistics_metadata", statistic_ids=[a.statistic_id])
        unit = meta[0].get("statistics_unit_of_measurement") if meta else None
        for r in todo:
            await ha.call(type="recorder/adjust_sum_statistics", statistic_id=a.statistic_id,
                          start_time=r["hour_utc"], adjustment=sign * float(r["adjustment"]),
                          adjustment_unit_of_measurement=unit)
    print(f"{'undid' if a.undo else 'applied'} {len(todo)} adjustments to {a.statistic_id} (unit {unit})")


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("plan")
    p.add_argument("device_dir", help="device-logs/<dev>, or 'ha' to derive truth from HA's own hourly states")
    p.add_argument("statistic_id")
    p.add_argument("--since")
    p.add_argument("--min-adj", type=float, default=0.02, help="ignore hourly differences smaller than this")
    p.add_argument("--out", default="ha_plan.csv")
    p.add_argument("--max-rate-h", type=float, default=3.0, help="max physical flow, units per hour (ha truth)")
    p.add_argument("--slack", type=float, default=0.1, help="tolerance added to the rate bound (ha truth)")
    p.add_argument("--max-flat-h", type=float, default=0,
                   help="flat runs longer than this (hours) count as a frozen reading, not zero use (0 = off)")
    q = sub.add_parser("apply")
    q.add_argument("plan")
    q.add_argument("statistic_id")
    q.add_argument("--undo", action="store_true")
    a = ap.parse_args()
    if a.cmd == "plan":
        plan(a)
    else:
        asyncio.run(apply_plan(a))


if __name__ == "__main__":
    main()
