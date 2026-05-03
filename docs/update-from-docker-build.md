# Updating an Existing Device with a Docker Build

This guide explains how to flash a firmware you built locally with Docker onto an
AI-on-the-edge device that is already running and connected to your network.

## Prerequisites

- Docker Desktop (or Docker Engine on Linux) installed and running
- The device is powered on, connected to Wi-Fi, and reachable by IP address
- You know the device IP (visible in your router or on the OLED display)

---

## Steps 1–3 — Build, extract, and package (automated)

A convenience script handles the Docker build, artifact extraction, and ZIP
creation in one step.

**Windows (PowerShell)** — from the repository root:

```powershell
.\tools\build-update-package.ps1
```

**Linux / macOS** — from the repository root:

```bash
chmod +x tools/build-update-package.sh
./tools/build-update-package.sh
```

Both scripts produce:

```
build-output/
  artifacts/
    firmware.bin        ← ESP32 program flash image
    bootloader.bin      ← Bootloader (only needed for first-time USB flash)
    partitions.bin      ← Partition table (only needed for first-time USB flash)
    html/               ← Gzip-compressed web UI files
    demo/               ← Demo mode files
    config/             ← TFLite CNN models + config.ini (default/example)
  ai-edge-update.zip    ← Ready-to-upload OTA package
```

> **`config.ini` is NOT included in the zip.**
> The packaging script intentionally excludes `config/config.ini` and `config/prevalue.ini`
> so your device's running configuration (ROI coordinates, meter setup, thresholds, etc.)
> is preserved after the update. Only the TFLite model `.tflite` files are updated.

The first run takes 15–30 minutes (PlatformIO downloads the ESP32 toolchain).
Subsequent builds are much faster thanks to Docker layer caching.

### Script options

| Option | PowerShell | Shell | Description |
|--------|-----------|-------|-------------|
| Docker tag | `-Tag my-tag` | `-t my-tag` | Custom image tag (default: `ai-edge-build`) |
| Output dir | `-OutDir C:\out` | `-o /tmp/out` | Where to write artifacts and zip |
| Firmware only | `-FirmwareOnly` | `-f` | Zip contains only `firmware.bin` — fastest when only code changed |

> **Tip — firmware-only update:**
> If you only modified C++ code (no web UI or model changes), use the
> `-FirmwareOnly` / `-f` flag. The resulting zip is a few hundred KB instead
> of several MB, and the upload is much faster.

---

## Step 4 — Upload the zip via the built-in OTA page

1. Open a browser and navigate to `http://<device-ip>/ota`.
2. Click **Choose file** and select one of:
   - `ai-edge-update.zip` — updates firmware + web UI + models in one step
   - `artifacts/firmware.bin` — updates firmware only
3. Click **Upload And Install**.
4. Wait for the progress bar to complete. The device reboots automatically.

> **Do not reload the page or navigate away while the upload is in progress.**

---

## Step 5 — Verify the update

After the device reboots (usually 15–30 seconds):

1. Re-open `http://<device-ip>/` — the main page loads.
2. Go to **System → Info** and confirm the firmware version / commit hash
   matches your build.
3. Check **System → Log** for any startup errors.

---

## Notes on the `[LLMFallback]` configuration

This fork adds a new `[LLMFallback]` section to `config.ini`. The default
`sd-card/config/config.ini` ships with the section commented out.

After flashing, if you want to enable the LLM digit fallback:

1. Open `http://<device-ip>/editconfig` (or edit `/config/config.ini` directly
   via the file manager at `http://<device-ip>/fileserver`).
2. Uncomment and fill in the `[LLMFallback]` block, for example:

   ```ini
   [LLMFallback]
   Provider = Ollama
   TimeoutMs = 5000
   ConfidenceThreshold = 0.0

   Ollama.Endpoint = http://192.168.1.50:11434
   Ollama.Model = llava:7b
   ```

3. Save and reboot the device (`http://<device-ip>/reboot`).

See [docs/specs/llm-digit-fallback.md](specs/llm-digit-fallback.md) for the
full parameter reference.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| OTA page returns error after upload | File too large (> 8 MB limit) | Split: upload `firmware.bin` first, then a separate zip with only `html/` |
| Device does not reboot after upload | Browser was reloaded mid-upload | Power-cycle the device and re-flash |
| Web UI looks broken after update | Old browser cache serving stale files | Hard-refresh (`Ctrl+Shift+R`) or clear browser cache |
| `[LLMFallback]` has no effect | Section not present in `config.ini` on the device | Add it via the file manager and reboot |
| LLM returns no result / timeout | Ollama/OpenAI unreachable from device network | Check `TimeoutMs`, firewall rules, and that the endpoint is on the same LAN segment |
