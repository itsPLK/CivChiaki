#!/usr/bin/env python3
"""Compile the LAN Chiaki core into JavaScript runnable in Gameface V8."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / 'build/runtime'
DIST = ROOT / 'dist/runtime'
SDK = ROOT / 'toolchains/emsdk'
for d in [BUILD, DIST, BUILD / 'chiaki']:
    d.mkdir(parents=True, exist_ok=True)
lock = json.loads((ROOT / 'third_party/sources.lock.json').read_text())
for name, item in lock.items():
    p = (ROOT / 'toolchains' if name == 'emsdk' else ROOT / 'third_party') / name
    actual = subprocess.check_output(['git', '-C', str(p), 'rev-parse', 'HEAD'], text=True).strip()
    if actual != item['commit']:
        sys.exit(f'{name}: dependency revision mismatch; run bootstrap.py')
if not (SDK / '.emscripten').exists():
    sys.exit('Run npm run bootstrap first')
env = os.environ.copy()
env.update(EM_CONFIG=str(SDK / '.emscripten'), EM_CACHE=str(BUILD / 'emscripten-cache'), EMSDK=str(SDK))
env['PATH'] = str(SDK / 'upstream/emscripten') + os.pathsep + env.get('PATH', '')
def run(*args, **kwargs):
    subprocess.run([str(a) for a in args], env=env, check=True, **kwargs)
version = subprocess.check_output([str(SDK / 'upstream/emscripten/emcc'), '--version'], env=env, text=True)
if '3.1.74' not in version.splitlines()[0]:
    sys.exit('Expected Emscripten 3.1.74')
run('node', ROOT / 'tools/build_crypto_subset.cjs')
python = ROOT / '.venv/bin/python'
proto = ROOT / 'third_party/chiaki/lib/protobuf'
run(python, '-m', 'grpc_tools.protoc', '-I' + str(proto), '-o' + str(BUILD / 'takion.pb'), proto / 'takion.proto')
run(python, ROOT / 'third_party/nanopb/generator/nanopb_generator.py', '-D', BUILD, BUILD / 'takion.pb')
(BUILD / 'chiaki/config.h').write_text('#define CHIAKI_LIB_ENABLE_OPUS 0\n#define CHIAKI_LIB_ENABLE_PI_DECODER 0\n#define CHIAKI_LIB_ENABLE_FFMPEG_DECODER 0\n')
# Keep upstream untouched. LAN initialization needs neither curl certificate
# recovery nor Jerasure's field initializer (our worker owns GF(256) tables).
common = (ROOT / 'third_party/chiaki/lib/src/common.c').read_text()
common = common.replace('#include "aia.h"', '').replace('#include <galois.h>', '#include <stdlib.h>\n#include <errno.h>')
start = common.index('\tint galois_r =')
end = common.index('\n#if _WIN32', start)
common = common[:start] + common[end:]
start = common.index('\tChiakiErrorCode aia_err =')
end = common.index('\n\treturn CHIAKI_ERR_SUCCESS;', start)
common = common[:start] + common[end:]
(BUILD / 'common.c').write_text(common)
frame = (ROOT / 'third_party/chiaki/lib/src/frameprocessor.c').read_text().replace('#include <jerasure.h>', '')
# These two hot copies move every compressed video byte twice. Preserve overlap
# semantics while using V8's native typed-array bulk move instead of wasm2js loops.
if frame.count('memcpy(') != 1 or frame.count('memmove(') != 1:
    sys.exit('Unexpected frame copy sites; review bulk move adaptation')
frame = '#include <stddef.h>\nextern void cc_heap_move(void *,const void *,size_t);\n' + frame
frame = frame.replace('memcpy(', 'cc_heap_move(').replace('memmove(', 'cc_heap_move(')
# Frame-batched video decryption (app/native/video-decrypt.c): units are
# stored encrypted and the frame is decrypted with one XOR before FEC/assembly.
reset_marker = '\tmemset(frame_processor->unit_slots, 0, frame_processor->unit_slots_size * sizeof(ChiakiFrameUnit));'
copy_marker = '\t\t\t\tpacket->data_size);\n\t}'
flush_marker = '\tif(frame_processor->units_source_expected == 0 || frame_processor->flushed)\n\t\treturn CHIAKI_FRAME_PROCESSOR_FLUSH_RESULT_FAILED;'
if frame.count('struct chiaki_frame_unit_t\n{\n\tsize_t data_size;\n};') != 1:
    sys.exit('Frame unit layout changed; update app/native/video-decrypt.c')
for marker in (reset_marker, copy_marker, flush_marker):
    if frame.count(marker) != 1:
        sys.exit('Unexpected frame processor shape; review batched video decryption')
frame = frame.replace(reset_marker, reset_marker + '\n\tcc_video_decrypt_reset();')
frame = frame.replace(copy_marker, '\t\t\t\tpacket->data_size);\n\t\tcc_video_decrypt_unit(packet->unit_index, packet);\n\t}')
frame = frame.replace(flush_marker, flush_marker + '\n\tif(cc_video_decrypt_frame(frame_processor) != CHIAKI_ERR_SUCCESS)\n\t\treturn CHIAKI_FRAME_PROCESSOR_FLUSH_RESULT_FAILED;')
frame = frame.replace('#include <chiaki/frameprocessor.h>', '#include <chiaki/frameprocessor.h>\nextern void cc_video_decrypt_reset(void);\nextern void cc_video_decrypt_unit(size_t, ChiakiTakionAVPacket *);\nextern ChiakiErrorCode cc_video_decrypt_frame(ChiakiFrameProcessor *);', 1)
if 'cc_video_decrypt_reset(void);' not in frame:
    sys.exit('Frame processor include not found; review batched video decryption')
fec_call = '\t\tChiakiErrorCode err = chiaki_frame_processor_fec(frame_processor);'
if frame.count(fec_call) != 1:
    sys.exit('Unexpected frame processor FEC call; review IDR-wait FEC skip')
frame = frame.replace(fec_call, '\t\tChiakiErrorCode err = cc_frame_skip_fec(frame_processor) ? CHIAKI_ERR_FEC_FAILED : chiaki_frame_processor_fec(frame_processor);')
frame = frame.replace('extern void cc_video_decrypt_reset(void);', 'extern void cc_video_decrypt_reset(void);\nextern int cc_frame_skip_fec(ChiakiFrameProcessor *);', 1)
(BUILD / 'frameprocessor.c').write_text(frame)
# While waiting for an IDR, let the frame processor skip FEC for P-frames.
video = (ROOT / 'third_party/chiaki/lib/src/videoreceiver.c').read_text()
flush_call = '\tChiakiFrameProcessorFlushResult flush_result = chiaki_frame_processor_flush(&video_receiver->frame_processor, &frame, &frame_size);'
if video.count(flush_call) != 1:
    sys.exit('Unexpected video receiver flush; review IDR-wait FEC skip')
video = video.replace(flush_call, '\tcc_fec_skip_bitstream = chiaki_video_receiver_get_waiting_for_idr(video_receiver) ? &video_receiver->bitstream : NULL;\n' + flush_call + '\n\tcc_fec_skip_bitstream = NULL;')
video = video.replace('#include <chiaki/videoreceiver.h>', '#include <chiaki/videoreceiver.h>\nextern ChiakiBitstream *cc_fec_skip_bitstream;', 1)
if 'extern ChiakiBitstream *cc_fec_skip_bitstream;' not in video:
    sys.exit('Video receiver include not found')
(BUILD / 'videoreceiver.c').write_text(video)
senkusha = (ROOT / 'third_party/chiaki/lib/src/senkusha.c').read_text()
old_tag = 'ntohl(*((uint32_t *)(packet->data + 4)))'
if senkusha.count(old_tag) != 1:
    sys.exit('Unexpected Senkusha tag reader; review the alignment adaptation')
# wasm2js typed-array i32 loads round an incorrectly aligned C cast down.
senkusha = senkusha.replace(old_tag, 'ntohl(*((chiaki_unaligned_uint32_t *)(packet->data + 4)))')
(BUILD / 'senkusha.c').write_text(senkusha)
gkcrypt = (ROOT / 'third_party/chiaki/lib/src/gkcrypt.c').read_text()
gkcrypt = gkcrypt.replace('#include <chiaki/gkcrypt.h>', '#include <chiaki/gkcrypt.h>\n#include "runtime.h"\nextern int cc_xor_bytes(uint8_t *,const uint8_t *,int);\nextern int cc_key_stream(const uint8_t *,const uint8_t *,uint32_t,uint32_t,uint8_t *,int);\nextern int cc_aes_ecb(const uint8_t *,uint8_t *,int);\nextern int cc_gmac(const uint8_t *,const uint8_t *,const uint8_t *,int,uint8_t *);')
aes_loop = 'for(int i = 0; i < buf_size; i = i + 16)\n\t{'
if gkcrypt.count(aes_loop) != 1:
    sys.exit('Unexpected GKCrypt AES loop; review cooperative checkpoints')
# Try the native provider before constructing a duplicate Mbed TLS key schedule.
# Counter formatting remains in upstream C and is shared by both paths.
counter_start = gkcrypt.index('\tuint64_t counter_offset = (key_pos / CHIAKI_GKCRYPT_BLOCK_SIZE);')
counter_end = gkcrypt.index('#ifdef CHIAKI_LIB_ENABLE_MBEDTLS', counter_start)
counter_fill = gkcrypt[counter_start:counter_end]
gkcrypt = gkcrypt[:counter_start] + gkcrypt[counter_end:]
aes_context_marker = '#ifdef CHIAKI_LIB_ENABLE_MBEDTLS\n\t// build mbedtls aes context'
if gkcrypt.count(aes_context_marker) != 1:
    sys.exit('Unexpected AES context setup; review native provider ordering')
gkcrypt = gkcrypt.replace(aes_context_marker, counter_fill + '#ifdef CHIAKI_LIB_ENABLE_MBEDTLS\n\tint accelerated = cc_aes_ecb(gkcrypt->key_base, buf, buf_size);\n\tif(accelerated <= 0) return accelerated ? CHIAKI_ERR_UNKNOWN : CHIAKI_ERR_SUCCESS;\n#endif\n' + aes_context_marker)
gkcrypt = gkcrypt.replace(aes_loop, aes_loop + '\n\t\tif((i & 0x3ff) == 0) cc_runtime_checkpoint();')
key_stream_marker = '\tuint64_t counter_offset = (key_pos / CHIAKI_GKCRYPT_BLOCK_SIZE);'
if gkcrypt.count(key_stream_marker) != 1:
    sys.exit('Unexpected key stream counter; review accelerated counter generation')
gkcrypt = gkcrypt.replace(key_stream_marker, '\tuint64_t block_position = key_pos / CHIAKI_GKCRYPT_BLOCK_SIZE;\n\tint native_stream = cc_key_stream(gkcrypt->key_base, gkcrypt->iv, (uint32_t)block_position, (uint32_t)(block_position >> 32), buf, buf_size);\n\tif(native_stream <= 0) return native_stream ? CHIAKI_ERR_UNKNOWN : CHIAKI_ERR_SUCCESS;\n' + key_stream_marker)

gmac_marker = '\t// build mbedtls gcm context AES_128_GCM'
if gkcrypt.count(gmac_marker) != 1:
    sys.exit('Unexpected GMAC implementation; review JS bulk crypto adaptation')
gkcrypt = gkcrypt.replace(gmac_marker, '\tint accelerated = cc_gmac(gmac_key, iv, buf, buf_size, gmac_out);\n\tif(accelerated <= 0) return accelerated ? CHIAKI_ERR_UNKNOWN : CHIAKI_ERR_SUCCESS;\n' + gmac_marker)
xor_marker = '\txor_bytes(buf, key_stream + padding_pre, buf_size);'
if gkcrypt.count(xor_marker) != 1:
    sys.exit('Unexpected Takion XOR step')
gkcrypt = gkcrypt.replace(xor_marker, '\tint native_xor = cc_xor_bytes(buf, key_stream + padding_pre, buf_size);\n\tif(native_xor < 0) { free(key_stream); return CHIAKI_ERR_UNKNOWN; }\n\tif(native_xor > 0) xor_bytes(buf, key_stream + padding_pre, buf_size);')
(BUILD / 'gkcrypt.c').write_text(gkcrypt)
stream = (ROOT / 'third_party/chiaki/lib/src/streamconnection.c').read_text()
if stream.count('CHIAKI_GKCRYPT_KEY_BUF_BLOCKS_DEFAULT') != 2:
    sys.exit('Unexpected stream key buffers; review on-demand crypto adaptation')
# Native Chiaki precomputes two 256 KiB key windows on background CPU threads.
# In one cooperative isolate those producers consume receive time, including
# keys for packets already lost. Use upstream's supported on-demand path.
stream = stream.replace('CHIAKI_GKCRYPT_KEY_BUF_BLOCKS_DEFAULT', '0')
av_decrypt = '\tchiaki_gkcrypt_decrypt(stream_connection->gkcrypt_remote, packet->key_pos + CHIAKI_GKCRYPT_BLOCK_SIZE, packet->data, packet->data_size);\n\n\tif(packet->is_video)'
if stream.count(av_decrypt) != 1:
    sys.exit('Unexpected AV decrypt shape; review batched video decryption')
stream = stream.replace(av_decrypt, '\tif(packet->is_video && cc_video_queue_push(stream_connection->gkcrypt_remote, stream_connection->video_receiver, packet))\n\t\treturn;\n\tif(packet->is_video && cc_video_decrypt_begin(stream_connection->gkcrypt_remote, stream_connection->video_receiver, packet))\n\t{\n\t\tchiaki_video_receiver_av_packet(stream_connection->video_receiver, packet);\n\t\tcc_video_decrypt_end();\n\t\treturn;\n\t}\n' + av_decrypt)
stream = '#include <chiaki/videoreceiver.h>\n#include <chiaki/takion.h>\nextern int cc_video_decrypt_begin(ChiakiGKCrypt *, ChiakiVideoReceiver *, ChiakiTakionAVPacket *);\nextern void cc_video_decrypt_end(void);\nextern int cc_video_queue_push(ChiakiGKCrypt *, ChiakiVideoReceiver *, ChiakiTakionAVPacket *);\nextern void cc_video_queue_stop(void);\n' + stream
# Video packets run on their own task (app/native/video-queue.c); stop it after
# Takion closes and before the receiver is freed, outside state_mutex.
teardown = 'err_video_receiver:\n\tchiaki_mutex_lock(&stream_connection->state_mutex);\n\tchiaki_video_receiver_free(stream_connection->video_receiver);'
if stream.count(teardown) != 1:
    sys.exit('Unexpected video receiver teardown; review the video task')
stream = stream.replace(teardown, 'err_video_receiver:\n\tcc_video_queue_stop();\n\tchiaki_mutex_lock(&stream_connection->state_mutex);\n\tchiaki_video_receiver_free(stream_connection->video_receiver);')
corrupt_send = '\tCHIAKI_LOGW(stream_connection->log, "StreamConnection reporting corrupt frame(s) from %u to %u", (unsigned int)start, (unsigned int)end);'
if stream.count(corrupt_send) != 1:
    sys.exit('Unexpected corrupt-frame report; review report coalescing')
stream = stream.replace(corrupt_send, '\tif(!cc_corrupt_report_due(start, chiaki_time_now_monotonic_ms()))\n\t\treturn CHIAKI_ERR_SUCCESS;\n' + corrupt_send)
stream = '#include <stdint.h>\nextern int cc_corrupt_report_due(uint16_t, uint64_t);\n' + stream
(BUILD / 'streamconnection.c').write_text(stream)
# Allow AV bursts to survive a page-frame scheduling gap. The reliable-control
# advertised window remains upstream's value; this changes only socket storage.
takion = (ROOT / 'third_party/chiaki/lib/src/takion.c').read_text()
receive_buffer = 'const int rcvbuf_val = takion->a_rwnd;'
if takion.count(receive_buffer) != 2:
    sys.exit('Unexpected Takion receive-buffer setup')
# 1 MiB is the console's maximum (2 MiB and larger are refused and leave 1 MiB).
takion = takion.replace(receive_buffer, 'const int rcvbuf_val = 1024 * 1024;')
ack_header = 'if(buf_size != 0xc)'
if takion.count(ack_header) != 1:
    sys.exit('Unexpected Takion ACK header check')
takion = takion.replace(ack_header, 'if(buf_size < 0xc)').replace('ack with size %zx != %#x', 'ack with size %zx < %#x')
ack_size = 'if(buf_size != gap_ack_blocks_count * 4 + 0xc)'
if takion.count(ack_size) != 1:
    sys.exit('Unexpected Takion variable ACK size check')
takion = takion.replace(ack_size, 'if(buf_size != ((size_t)gap_ack_blocks_count + dup_tsns_count) * 4 + 0xc)')
# The receive allocation is already bounded to 1500 bytes. Ownership passes to
# the packet handler/queues, which use received_size and eventually free it.
# Shrinking every allocation saves little memory and adds allocator work per UDP packet.
shrink = """		uint8_t *resized_buf = realloc(buf, received_size);
		if(!resized_buf)
		{
			free(buf);
			continue;
		}
		takion_handle_packet(takion, resized_buf, received_size);"""
if takion.count(shrink) != 1:
    sys.exit('Unexpected Takion packet ownership; review receive allocation')
takion = takion.replace(shrink, '\t\ttakion_handle_packet(takion, buf, received_size);')
# Video GMAC verification costs three native SDK calls per packet (~40% of the
# receive path on the console). Video MACs are skipped by default (LAN-only
# streaming; forged video can at worst corrupt pictures). Audio, control and
# congestion packets are still verified. AV parsing commits the key position
# itself, so key-state tracking does not depend on the skipped check.
mac_check = '\tif(takion_handle_packet_mac(takion, base_type, buf, buf_size) != CHIAKI_ERR_SUCCESS)\n\t{\n\t\tfree(buf);\n\t\treturn;\n\t}'
if takion.count(mac_check) != 1:
    sys.exit('Unexpected Takion MAC check; review the video MAC option')
takion = takion.replace(mac_check, '\tif(base_type == TAKION_PACKET_TYPE_VIDEO && !cc_verify_video_mac)\n\t\tcc_video_mac_skipped++;\n\telse ' + mac_check[1:])
takion = 'extern int cc_verify_video_mac;\nextern double cc_video_mac_skipped;\n' + takion
(BUILD / 'takion.c').write_text(takion)
# Delay-based congestion signal: the 1 MiB receive storage absorbs overload
# without loss, so the console never lowers its bitrate and a standing queue
# (up to ~0.5 s at 15 Mbps) becomes input latency. When receive batches have
# been full for >= 250 ms, report loss at the configured maximum so the
# console backs off. Real loss above that is still clamped as upstream.
congestion = (ROOT / 'third_party/chiaki/lib/src/congestioncontrol.c').read_text()
report = '\t\tpacket.received = (uint16_t)received;'
if congestion.count(report) != 1:
    sys.exit('Unexpected congestion report; review delay-based signal')
congestion = congestion.replace(report, '\t\tif(total > 0 && cc_receive_backlog_ms() >= 250)\n\t\t{\n\t\t\tuint64_t signal = (uint64_t)(total * control->packet_loss_max);\n\t\t\tif(lost < signal)\n\t\t\t{\n\t\t\t\tlost = signal;\n\t\t\t\treceived = total - lost;\n\t\t\t\tcc_congestion_signal_count++;\n\t\t\t}\n\t\t}\n' + report)
congestion = 'extern int cc_receive_backlog_ms(void);\nextern double cc_congestion_signal_count;\n' + congestion
(BUILD / 'congestioncontrol.c').write_text(congestion)

exports = ['malloc', 'free', 'cc_init', 'cc_mode', 'cc_tick', 'cc_stop', 'cc_register', 'cc_connect', 'cc_login_pin', 'cc_controller', 'cc_discover', 'cc_discover_at', 'cc_wakeup', 'cc_runtime_tasks', 'chiaki_fec_decode', 'chiaki_fec_encode']
exports += ['chiaki_ecdh_init', 'chiaki_ecdh_fini', 'chiaki_ecdh_get_local_pub_key', 'chiaki_ecdh_derive_secret', 'chiaki_rpcrypt_init_auth', 'chiaki_rpcrypt_generate_iv', 'chiaki_gkcrypt_init', 'chiaki_gkcrypt_fini', 'chiaki_gkcrypt_gen_key_stream', 'chiaki_log_init']
exports += ['cc_runtime_metrics', 'cc_set_verify_video_mac', 'cc_video_mac_skipped_count', 'cc_set_defer_video_decrypt', 'cc_video_decrypt_frames', 'cc_set_video_queue', 'cc_video_queue_metrics', 'cc_video_queue_idle', 'cc_recovery_metrics', 'cc_congestion_signals']
exports += ['chiaki_gkcrypt_gmac', 'chiaki_gkcrypt_decrypt']
(BUILD / 'exports.json').write_text(json.dumps(['_' + x for x in exports]))
run(SDK / 'upstream/emscripten/emcmake', 'cmake', '-S', ROOT / 'tools', '-B', BUILD, '-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_POLICY_VERSION_MINIMUM=3.5',
    # Jitless V8: LTO inlining saves interpreted calls, and bulk memory turns
    # every memcpy/memset into a native typed-array copyWithin/fill. Measured
    # on the console. Override for A/B.
    '-DCIVCHIAKI_OPT=' + os.environ.get('CIVCHIAKI_OPT', '-O3 -flto -mbulk-memory'),
    '-DCIVCHIAKI_LINK_EXTRA=' + os.environ.get('CIVCHIAKI_LINK_EXTRA', '-mbulk-memory'))
run('cmake', '--build', BUILD, '--parallel', '8')
shutil.copy2(BUILD / 'chiaki-core.js', DIST / 'chiaki-core.js')
data = (DIST / 'chiaki-core.js').read_bytes()
(DIST / 'manifest.json').write_text(json.dumps({'format': 'wasm2js', 'emscripten': '3.1.74', 'codec': 'H264', 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(), 'sources': lock}, indent=2) + '\n')
print(f'Built {DIST / "chiaki-core.js"}: {len(data):,} bytes')
