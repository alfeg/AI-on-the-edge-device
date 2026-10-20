# Build

## Preparations
```
git clone https://github.com/jomjol/AI-on-the-edge-device.git
cd AI-on-the-edge-device
git checkout main
git submodule update --init
```

## Update Submodules
```
cd /components/submodule-name (e.g. tflite-micro-example)
git checkout VERSION (e.g. HASH of latest tflite-micro-example build)
cd ../../ (at the code level)
git submodule update --init
```
You may need to manually delete some directories in the 'components' folder beforehand, as they were not deleted during checkout (before update -- init)

## Build with Docker
Builds the firmware and web UI inside a container, the same way the GitHub Actions build does. Nothing besides Git and [Docker](https://docs.docker.com/get-docker/) (Docker Desktop, or Docker Engine 23+ with BuildKit) is needed on your machine — no PlatformIO, ESP-IDF or Python.

From the repository root (a `git clone`, not a zip download — the build needs `.git` for the submodules and the version string):
```
docker build --output build-output .
```

The result lands in `build-output/`:

| File / folder | Use |
|---|---|
| `update.zip` | OTA update package: firmware, web UI, demo files and CNN models. Same content as the `update` artifact of the GitHub Actions build. |
| `update-with-config.zip` | Same as `update.zip`, plus the complete default `config/` folder (`config.ini`, `prevalue.ini`, reference images). **Overwrites the device configuration** — use it to reset a device to defaults. |
| `firmware.bin` | Firmware only. Can be uploaded on its own via OTA. |
| `bootloader.bin`, `partitions.bin` | Needed together with `firmware.bin` for a first-time flash over USB. |
| `html/`, `demo/`, `config/` | Web UI (gzip-compressed), demo mode files and the default configuration with CNN models. |

The first build takes a while (roughly 15–30 minutes) because the ESP32 toolchain and ESP-IDF are downloaded into the image. That layer is cached by Docker, so later builds only recompile the sources.

### Update a running device
Open `http://<device-ip>/ota` and upload `build-output/update.zip` (or only `build-output/firmware.bin` if you just changed code). The `config/` folder of `update.zip` contains only CNN models, so your `config.ini`, `prevalue.ini` and reference images on the SD card are kept. Upload `update-with-config.zip` instead only if you want to start over with the default configuration.

### First-time flash over USB
Docker does not need access to the USB port. Flash the three binaries from `build-output/` with `esptool` (or Espressif's Flash Tool, same offsets):
```
esptool.py --chip esp32 --port /dev/ttyUSB0 write_flash 0x1000 bootloader.bin 0x8000 partitions.bin 0x10000 firmware.bin
```
Then prepare the SD card as described in the [installation guide](https://jomjol.github.io/AI-on-the-edge-device-docs/Installation/).

## Build and Flash within terminal
See further down to build it within an IDE.
### Compile
```
cd code
platformio run --environment esp32cam
```

### Upload
```
pio run --target upload --upload-port /dev/ttyUSB0
```

Alternatively you also can set the UART device in `platformio.ini`, eg. `upload_port = /dev/ttyUSB0`

### Monitor UART Log
```
pio device monitor -p /dev/ttyUSB0
```

## Build and Flash with Visual Code IDE

- Download and install VS Code
  - https://code.visualstudio.com/Download
- Install the VS Code platform io plugin
  - <img src="https://raw.githubusercontent.com/jomjol/ai-on-the-edge-device/master/images/platformio_plugin.jpg" width="200" align="middle">
  - Check for error messages, maybe you need to manually add some python libraries
    - e.g. in my Ubuntu a python3-env was missing: `sudo apt-get install python3-venv`
- git clone this project
  - in Linux: 

    ```
    git clone https://github.com/jomjol/AI-on-the-edge-device.git
    cd AI-on-the-edge-device
    git checkout main
    git submodule update --init
    ```

- in VS code, open the `AI-on-the-edge-device/code` 
	- from terminal: `cd AI-on-the-edge-device/code && code .`
- open a pio terminal (click on the terminal sign in the bottom menu bar)
- make sure you are in the `code` directory
- To build, type  `platformio run --environment esp32cam`
  - or use the graphical interface:
    <img src="https://raw.githubusercontent.com/jomjol/ai-on-the-edge-device/master/images/platformio_build.jpg" width="200" align="middle">
  - the build artifacts are stored in  `code/.pio/build/esp32cam/`
- Connect the device and type `pio device monitor`. There you will see your device and can copy the name to the next instruction
- Add `upload_port = you_device_port` to the `platformio.ini` file
- make sure an sd card with the contents of the `sd_card` folder is inserted and you have changed the wifi details
- `pio run --target erase` to erase the flash
- `pio run --target upload` this will upload the `bootloader.bin, partitions.bin,firmware.bin` from the `code/.pio/build/esp32cam/` folder. 
- `pio device monitor` to observe the logs via uart

# Update Parameters
If you create or rename a parameter, make sure to update its documentation in `../param-docs/parameter-pages`! Check the `../param-docs/README.md` for more information.
