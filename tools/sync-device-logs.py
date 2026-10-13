#!/usr/bin/env python3
"""
Mirror logs and captured images from AI-on-the-edge devices to local disk over HTTP.

What it pulls (per device), into <out>/<device>/:
  log/**            -> /fileserver/log/  (message, data, llm, digit, analog, source, ...)
  snapshots/<ts>/   -> config.ini, prevalue.ini, align.txt, /json, /statusflow
  sync-state.json   -> last attempt / last success / error counts

Design goals:
  * Survives device hangs, reboots and downtime: every request has a timeout,
    is retried with backoff, and a device that stops answering is abandoned for
    this pass (the next pass picks up where it left off). One device being down
    never blocks the other.
  * Incremental: files that can no longer change are skipped once mirrored.
    "Live" files (today's/yesterday's log, data and LLM transcript files) are
    re-fetched every pass. Hour folders of images older than a few hours are
    marked complete and not even re-listed.
  * Gentle on the ESP32: strictly sequential, small pause between requests.
  * Never leaves a truncated file: downloads go to *.part and are renamed only
    after the full body arrived (Content-Length verified when present).

The device deletes its own logs after a few days (LogfilesRetention,
DataFilesRetention, ROIImagesRetention, RawImagesRetention), so run this
regularly, e.g. `--loop 30` or via Windows Task Scheduler.

Stdlib only. Examples:
  python tools/sync-device-logs.py
  python tools/sync-device-logs.py --loop 30
  python tools/sync-device-logs.py --device watermeter=http://192.168.68.101 --skip-images
"""

import argparse
import base64
import datetime as dt
import html
import json
import os
import re
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_DEVICES = [
    "watermeter=http://192.168.68.101",
    "gasmeter=http://192.168.68.115",
]

DEFAULT_OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "device-logs")

# Folders under /fileserver/log/ that hold images in <YYYYMMDD>/<HH>/ trees.
IMAGE_FOLDERS = {"digit", "analog", "source"}

# Small files snapshotted every pass (they change in place on the device).
SNAPSHOT_FILES = ["/fileserver/config/config.ini",
                  "/fileserver/config/prevalue.ini",
                  "/fileserver/config/align.txt"]
SNAPSHOT_ENDPOINTS = {"json.json": "/json", "statusflow.txt": "/statusflow"}

ROW_RE = re.compile(
    r'<tr><td><a href="(?P<href>[^"]+)">(?P<name>[^<]*)</a></td>'
    r'<td>(?P<type>directory|file)</td><td>(?P<size>[^<]*)')

DATE_RE = re.compile(r'(\d{4})-?(\d{2})-?(\d{2})')


class DeviceUnavailable(Exception):
    """Raised when a device stops answering; aborts the pass for that device only."""


def log(msg):
    print(f"{dt.datetime.now():%Y-%m-%d %H:%M:%S} {msg}", flush=True)


class Device:
    def __init__(self, name, base, out_root, args):
        self.name = name
        self.base = base.rstrip("/")
        self.root = os.path.join(out_root, name)
        self.args = args
        self.consecutive_failures = 0
        self.stats = {"downloaded": 0, "skipped": 0, "bytes": 0, "errors": 0}
        self.auth = None
        if args.user:
            token = base64.b64encode(f"{args.user}:{args.password or ''}".encode()).decode()
            self.auth = "Basic " + token

    # ---------------- HTTP ----------------

    def _open(self, path, timeout):
        url = self.base + urllib.parse.quote(path, safe="/?=&")
        req = urllib.request.Request(url, headers={"User-Agent": "ai-edge-log-sync"})
        if self.auth:
            req.add_header("Authorization", self.auth)
        return urllib.request.urlopen(req, timeout=timeout)

    def request(self, path, dest=None):
        """GET path. Returns bytes, or streams to dest (atomic). Retries with backoff.

        Raises DeviceUnavailable after too many consecutive failures, and
        FileNotFoundError on HTTP 404 (file rotated away between listing and fetch).
        """
        attempts = self.args.retries + 1
        delay = 2.0
        for attempt in range(1, attempts + 1):
            try:
                time.sleep(self.args.pause)
                with self._open(path, self.args.timeout) as resp:
                    expected = resp.headers.get("Content-Length")
                    expected = int(expected) if expected and expected.isdigit() else None
                    if dest is None:
                        data = resp.read()
                        if expected is not None and len(data) != expected:
                            raise IOError(f"short read {len(data)}/{expected}")
                        self.consecutive_failures = 0
                        return data
                    part = dest + ".part"
                    os.makedirs(os.path.dirname(dest), exist_ok=True)
                    got = 0
                    with open(part, "wb") as f:
                        while True:
                            chunk = resp.read(16384)
                            if not chunk:
                                break
                            f.write(chunk)
                            got += len(chunk)
                    if expected is not None and got != expected:
                        os.remove(part)
                        raise IOError(f"short read {got}/{expected}")
                    os.replace(part, dest)
                    self.consecutive_failures = 0
                    return got
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    raise FileNotFoundError(path)
                err = f"HTTP {e.code}"
            except (urllib.error.URLError, socket.timeout, ConnectionError, IOError, OSError) as e:
                err = str(getattr(e, "reason", e))
            if dest and os.path.exists(dest + ".part"):
                try:
                    os.remove(dest + ".part")
                except OSError:
                    pass
            self.consecutive_failures += 1
            if self.consecutive_failures >= self.args.max_failures:
                raise DeviceUnavailable(f"{self.consecutive_failures} consecutive failures, last: {err}")
            if attempt < attempts:
                log(f"[{self.name}] {path}: {err} - retry {attempt}/{attempts - 1} in {delay:.0f}s")
                time.sleep(delay)
                delay = min(delay * 2, 30)
        self.stats["errors"] += 1
        raise IOError(f"{path}: giving up ({err})")

    # ---------------- listing ----------------

    def listdir(self, path):
        """Return [(name, href, is_dir, size_text)] for a /fileserver/... directory."""
        body = self.request(path + "?readonly=true").decode("utf-8", "replace")
        if "files_table" not in body:
            raise IOError(f"unexpected listing for {path}")
        out = []
        for m in ROW_RE.finditer(body):
            name = html.unescape(m.group("name"))
            out.append((name, html.unescape(m.group("href")), m.group("type") == "directory",
                        m.group("size").strip()))
        return out

    # ---------------- sync logic ----------------

    def local_path(self, href):
        rel = href[len("/fileserver/"):] if href.startswith("/fileserver/") else href.lstrip("/")
        return os.path.join(self.root, *rel.rstrip("/").split("/"))

    @staticmethod
    def size_matches(local_bytes, size_text):
        m = re.match(r"(\d+)\s*(B|KiB)", size_text)
        if not m:
            return False
        n = int(m.group(1))
        return local_bytes == n if m.group(2) == "B" else local_bytes // 1024 == n

    def is_live(self, name):
        """Files named after today or yesterday may still be growing."""
        m = DATE_RE.search(name)
        if not m:
            return True  # undated file (e.g. leer.txt is 0 B and cheap anyway)
        try:
            d = dt.date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        except ValueError:
            return True
        return (dt.date.today() - d).days <= 1

    def hour_folder_done(self, path_parts):
        """digit/20261012/07 -> True if that hour is safely in the past."""
        try:
            day, hour = path_parts[-2], path_parts[-1]
            t = dt.datetime.strptime(day + hour, "%Y%m%d%H")
        except (ValueError, IndexError):
            return False
        return dt.datetime.now() - t > dt.timedelta(hours=self.args.settle_hours + 1)

    def sync_file(self, name, href, size_text, always=False):
        dest = self.local_path(href)
        if not always and os.path.exists(dest) \
                and self.size_matches(os.path.getsize(dest), size_text) \
                and (not self.is_live(name) or size_text.endswith(" B")):
            # Old file with matching size, or a live file whose exact byte size is unchanged.
            self.stats["skipped"] += 1
            return
        try:
            n = self.request(href, dest)
        except FileNotFoundError:
            log(f"[{self.name}] gone before fetch: {href}")
            return
        except IOError as e:
            log(f"[{self.name}] {e}")
            return
        self.stats["downloaded"] += 1
        self.stats["bytes"] += n

    def sync_tree(self, path, depth=0):
        parts = [p for p in path.split("/") if p][2:]   # strip 'fileserver','log'
        local_dir = self.local_path(path)
        marker = os.path.join(local_dir, ".complete")
        if os.path.exists(marker):
            return
        is_image_tree = bool(parts) and parts[0] in IMAGE_FOLDERS
        if is_image_tree and self.args.skip_images:
            return
        try:
            entries = self.listdir(path)
        except FileNotFoundError:
            return
        except IOError as e:
            log(f"[{self.name}] list {path}: {e}")
            return
        for name, href, is_dir, size in entries:
            if is_dir:
                self.sync_tree(href, depth + 1)
            else:
                self.sync_file(name, href, size)
        # Hour folders of image trees never change once the hour is over.
        if is_image_tree and len(parts) == 3 and self.hour_folder_done(parts):
            os.makedirs(local_dir, exist_ok=True)
            with open(marker, "w") as f:
                f.write(dt.datetime.now().isoformat())

    def snapshot(self):
        stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
        snap_dir = os.path.join(self.root, "snapshots", stamp)
        for href in SNAPSHOT_FILES:
            try:
                self.request(href, os.path.join(snap_dir, href.rsplit("/", 1)[1]))
            except (FileNotFoundError, IOError) as e:
                log(f"[{self.name}] snapshot {href}: {e}")
        for fname, ep in SNAPSHOT_ENDPOINTS.items():
            try:
                data = self.request(ep)
                os.makedirs(snap_dir, exist_ok=True)
                with open(os.path.join(snap_dir, fname), "wb") as f:
                    f.write(data)
            except (FileNotFoundError, IOError) as e:
                log(f"[{self.name}] snapshot {ep}: {e}")
        # Drop the snapshot if config/prevalue/align didn't change since the previous
        # one (keeps the folder readable; json/statusflow alone aren't worth keeping).
        self._dedupe_snapshot(snap_dir)

    def _dedupe_snapshot(self, snap_dir):
        base = os.path.join(self.root, "snapshots")
        snaps = sorted(d for d in os.listdir(base) if os.path.isdir(os.path.join(base, d)))
        if len(snaps) < 2 or os.path.basename(snap_dir) != snaps[-1]:
            return
        prev = os.path.join(base, snaps[-2])

        def read(d, f):
            p = os.path.join(d, f)
            return open(p, "rb").read() if os.path.exists(p) else None
        if all(read(prev, f) == read(snap_dir, f) for f in ("config.ini", "align.txt", "prevalue.ini")):
            for f in os.listdir(snap_dir):
                os.remove(os.path.join(snap_dir, f))
            os.rmdir(snap_dir)

    def save_state(self, ok, error=None):
        path = os.path.join(self.root, "sync-state.json")
        state = {}
        if os.path.exists(path):
            try:
                state = json.load(open(path))
            except (OSError, ValueError):
                state = {}
        now = dt.datetime.now().isoformat(timespec="seconds")
        state["last_attempt"] = now
        state["base_url"] = self.base
        if ok:
            state["last_success"] = now
            state["failed_passes_in_row"] = 0
        else:
            state["failed_passes_in_row"] = state.get("failed_passes_in_row", 0) + 1
            state["last_error"] = error
        state["last_stats"] = self.stats
        os.makedirs(self.root, exist_ok=True)
        with open(path, "w") as f:
            json.dump(state, f, indent=2)

    def run(self):
        start = time.time()
        try:
            # Cheap reachability probe first, so a hung device costs seconds, not minutes.
            self.request("/statusflow")
            self.snapshot()
            self.sync_tree("/fileserver/log/")
        except DeviceUnavailable as e:
            log(f"[{self.name}] UNAVAILABLE ({e}) - will retry next pass")
            self.save_state(False, str(e))
            return False
        except IOError as e:
            log(f"[{self.name}] UNAVAILABLE ({e}) - will retry next pass")
            self.save_state(False, str(e))
            return False
        s = self.stats
        log(f"[{self.name}] done in {time.time() - start:.0f}s: {s['downloaded']} downloaded "
            f"({s['bytes'] / 1024:.0f} KiB), {s['skipped']} skipped, {s['errors']} errors")
        self.save_state(True)
        return True


def parse_devices(specs):
    out = []
    for s in specs:
        if "=" not in s:
            sys.exit(f"--device must be name=url, got {s!r}")
        name, url = s.split("=", 1)
        if not url.startswith("http"):
            url = "http://" + url
        out.append((name.strip(), url.strip()))
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--device", action="append", metavar="NAME=URL",
                    help="device to sync (repeatable). Default: watermeter + gasmeter")
    ap.add_argument("--out", default=DEFAULT_OUT, help=f"output folder (default: {DEFAULT_OUT})")
    ap.add_argument("--loop", type=float, metavar="MINUTES",
                    help="keep running, one pass every MINUTES (Ctrl+C to stop)")
    ap.add_argument("--skip-images", action="store_true", help="only text logs + snapshots")
    ap.add_argument("--timeout", type=float, default=20, help="per-request socket timeout, s (default 20)")
    ap.add_argument("--retries", type=int, default=2, help="retries per request (default 2)")
    ap.add_argument("--max-failures", type=int, default=4,
                    help="consecutive failures before a device is abandoned for this pass (default 4)")
    ap.add_argument("--pause", type=float, default=0.1, help="pause between requests, s (default 0.1)")
    ap.add_argument("--settle-hours", type=int, default=2,
                    help="image hour-folders older than this are marked complete (default 2)")
    ap.add_argument("--user", help="HTTP basic auth user (if http_username set in wlan.ini)")
    ap.add_argument("--password", help="HTTP basic auth password")
    args = ap.parse_args()

    devices = parse_devices(args.device or DEFAULT_DEVICES)
    os.makedirs(args.out, exist_ok=True)
    log(f"output: {args.out}")

    while True:
        for name, url in devices:
            log(f"[{name}] syncing {url}")
            try:
                Device(name, url, args.out, args).run()
            except KeyboardInterrupt:
                raise
            except Exception as e:  # never let one device kill the loop
                log(f"[{name}] unexpected error: {e!r}")
        if not args.loop:
            break
        log(f"next pass in {args.loop:g} min")
        time.sleep(args.loop * 60)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log("stopped")
