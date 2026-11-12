# Architecture

## Core

`tools/build.py` compiles Chiaki-NG (`third_party/chiaki`) into a single-file
wasm2js module. Session, registration, Takion, audio/video packet handling,
feedback, crypto and discovery all run inside it. Qt, FFmpeg, libnx, PSN/curl and
internet hole-punching are excluded; the unsupported PSN entry points fail.
Upstream files are not edited. The few build-time adaptations (no Jerasure init,
no curl cert recovery, crypto routing) are applied to copies in the build
directory.

- `app/native/platform.c`: Chiaki threads, mutexes, conditions and time on
  Emscripten fibers. Socket waits suspend the current fiber so the page keeps
  drawing. `cc_tick` gives the scheduler a bounded budget per call.
- `app/native/io.c`, `stop.c`: POSIX sockets over the native socket API; stop
  pipes replaced by cancellation flags.
- `app/native/video-decrypt.c`: one native XOR per video frame
  (`batchVideoDecrypt: false` for per-packet).
- Video packets skip GMAC verification by default (`verifyVideoMac: true`
  restores it). All other packet types are verified.

## JavaScript side (`app/src`)

- `client.js`: drives the core. Guards media callbacks, queues C events, and
  closes in order: protocol workers, GPU, media, controllers, worker, native I/O.
  If native work doesn't finish, close fails and keeps its resources for retry.
- `native-crypto.js`: AES (ECB via the SDK's XTS routine with a zero tweak) and
  GMAC through the SDK's native crypto, with checked addresses and sizes. Portable
  fallbacks remain. Verified against independent vectors in `tests/`.
- `fec.js`, `worker.js`, `worker-transfer.js`: FEC recovery. A Cauchy
  Reed-Solomon kernel (GF(256), matching Chiaki/Jerasure) runs in an off-thread
  worker; the backend is `app/vendor/worker-native.js`. Frame shards are uploaded
  once, and only the used result is copied back.
- `h264.js`: keeps SPS/PPS and sends complete access units to the hardware
  decoder.
- `store.js`, `native.js`: pairing and settings in two alternating records under
  `save:/civhomebrew/data/chiaki/`, each verified by readback. The save adapter
  allows only those files and has no delete.
- `ui.js`: UI; it must be the last script in `payload.json` because its
  completion value is the app lifetime promise.

## Media (`app/vendor`)

Adapters from Moonlight-CivSwitch for the native UDP socket, H.264 decoder, GPU
texture presentation, Opus/AudioOut queues and controller input, plus
CivHomebrew's keyboard. `worker-NOTICE.md` lists local changes.

## Tests

`npm test` (JS units), `npm run test:runtime` (compiled core, Takion ACK
handling, video recovery), `npm run test:package`.
