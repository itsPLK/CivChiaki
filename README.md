<p align="center">
 <img src="./app/assets/chiaki.png" width="128" />
</p>
<h1 align="center">CivChiaki</h1>

<p align="center">PlayStation Remote Play client for <a href="https://github.com/XITRIX/CivHomebrew">CivHomebrew</a>, built on <a href="https://github.com/streetpea/chiaki-ng">Chiaki-NG</a>.</p>

Video decoding, audio, GPU presentation, sockets and controller input call the
game's native SDK directly through the primitives the loader provides, using
adapters taken from Moonlight-CivSwitch. The Chiaki-NG core is the git submodule
in `third_party/chiaki`.

## Status

- PS5 registration, saved pairing and controller input work on Switch 2.
- Smooth video and audio at 1080p60.

## Requirements

- CivHomebrew on a Switch 2. Switch 1 is untested.
- To build: Git, Python 3.9+, Node.js 22+, CMake and a C/C++ toolchain.

## Build and install

```sh
git clone --recurse-submodules <repository-url>
# or, in an existing checkout:
git submodule update --init

npm run bootstrap   # fetch pinned Emscripten, Mbed TLS, nanopb into this checkout
npm run build
npm test
npm run test:runtime
npm run package     # produces dist/chiaki.civapp
```

Upload `dist/chiaki.civapp` to CivHomebrew's FTP **Install civapp** folder, then
launch **Chiaki**.

## Pair and play

1. Enable Remote Play in the PlayStation's settings. Both devices must be on the
   same local network.
2. In Chiaki choose **Find consoles on network**, or **Add console** to enter an
   IPv4 address.
3. Choose PS5 or the PS4 protocol version. Enter your PSN account ID (8 bytes,
   Base64, 12 characters; not your display name) and the 8-digit PIN from the
   console's **Link Device / Add Device** screen. PSN sign-in is not implemented.
4. Select the console and **Connect**. If asked, enter the 4-digit login PIN.

Defaults: 720p, 30 FPS, 8 Mbps. Settings offer 360p/540p/720p/1080p, 30/60 FPS
and 1–50 Mbps.

Controls:

- D-pad / A / B: navigate, select, back.
- Switch B/A/Y/X map by position to Cross/Circle/Square/Triangle.
- Minus/Plus map to Share/Options. Hold both to open stream controls (PS,
  touchpad click, disconnect).
- **Wake console** needs Remote wake enabled on the PlayStation.

Pairing and settings are saved under `save:/civhomebrew/data/chiaki/`. Account
IDs and registration PINs are not saved.

## Limitations

- H.264 only. No H.265, HDR, PSN/internet play, microphone, motion, adaptive
  triggers, remote keyboard or touchscreen gestures.
- LAN IPv4 only. If discovery is blocked (e.g. AP isolation), add the console by
  address.
- Video packets are not MAC-verified by default (other packet types are); see
  [architecture](docs/architecture.md).

## UI preview

`python3 -m http.server 8000`, then open `http://localhost:8000/app/`. The
stream itself needs the console.

## Credits

- [Gezine](https://github.com/Gezine/CivSwitch) for CivSwitch
- [XITRIX](https://github.com/XITRIX) for [CivHomebrew](https://github.com/XITRIX/CivHomebrew)
  and [Moonlight-CivSwitch](https://github.com/XITRIX/Moonlight-CivSwitch)
- [Chiaki-NG](https://github.com/streetpea/chiaki-ng) and the Chiaki contributors

## Docs and licenses

- [Architecture notes](docs/architecture.md)
- Chiaki-NG's AGPL license and OpenSSL exception apply; see [COPYING](COPYING).
  Moonlight and CivHomebrew adapters live in `app/vendor`; dependency notices are
  in `app/notices.js`. Reference revisions: `third_party/reference-revisions.json`.
- When distributing binaries, provide the corresponding source and build
  instructions.
