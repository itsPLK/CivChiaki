/* Frame-batched video decryption.
 *
 * Upstream decrypts every AV packet on arrival: one native XOR call per video
 * packet on the console. Video payloads are only read once a frame is flushed
 * (or by alloc_frame, which reads the first unit's 2-byte size extension), so
 * video units are stored encrypted and the whole frame buffer is decrypted with
 * one XOR against a keystream image laid out like the frame buffer. Units that
 * arrive after their frame was flushed are never decrypted. Audio is unchanged.
 */
#include <chiaki/gkcrypt.h>
#include <chiaki/takion.h>
#include <chiaki/frameprocessor.h>
#include <chiaki/videoreceiver.h>
#include <stdlib.h>
#include <string.h>

extern int cc_xor_bytes(uint8_t *, const uint8_t *, int);
/* Private to frameprocessor.c; tools/build.py fails if its layout changes. */
struct chiaki_frame_unit_t { size_t data_size; };

enum { SLOTS = 512 };
int cc_defer_video_decrypt = 1;
double cc_video_frames_decrypted, cc_video_units_deferred;
static ChiakiGKCrypt *crypt_current;
static int packet_deferred, packet_prefix;
static uint8_t unit_deferred[SLOTS], unit_prefix[SLOTS];
static uint64_t unit_key_pos[SLOTS];
static uint8_t *image, *scratch;
static size_t image_size, scratch_size;

void cc_set_defer_video_decrypt(int defer) { cc_defer_video_decrypt = !!defer; }
double cc_video_decrypt_frames(void) { return cc_video_frames_decrypted; }

/* Returns 1 when the packet's payload stays encrypted for frame decryption. */
int cc_video_decrypt_begin(ChiakiGKCrypt *crypt, ChiakiVideoReceiver *receiver, ChiakiTakionAVPacket *packet)
{
	packet_deferred = 0;
	if(!cc_defer_video_decrypt || !crypt || !packet->is_video || packet->unit_index >= SLOTS || packet->data_size < 2)
		return 0;
	/* A packet of a new frame may allocate it, which reads the first unit's
	 * 2-byte size extension: decrypt just that prefix now. */
	packet_prefix = 0;
	if(receiver->frame_index_cur < 0 || (ChiakiSeqNum16)packet->frame_index != (ChiakiSeqNum16)receiver->frame_index_cur)
	{
		if(chiaki_gkcrypt_decrypt(crypt, packet->key_pos + CHIAKI_GKCRYPT_BLOCK_SIZE, packet->data, 2) != CHIAKI_ERR_SUCCESS)
			return 0;
		packet_prefix = 2;
	}
	crypt_current = crypt;
	packet_deferred = 1;
	return 1;
}

void cc_video_decrypt_end(void) { packet_deferred = 0; }

/* alloc_frame: forget per-unit state of the previous frame. */
void cc_video_decrypt_reset(void) { memset(unit_deferred, 0, sizeof(unit_deferred)); }

/* put_unit stored this packet's (possibly encrypted) payload in slot index.
 * A packet that was decrypted on arrival clears any stale deferral. */
void cc_video_decrypt_unit(size_t index, ChiakiTakionAVPacket *packet)
{
	if(index >= SLOTS)
		return;
	unit_deferred[index] = (uint8_t)packet_deferred;
	if(packet_deferred)
	{
		unit_prefix[index] = (uint8_t)packet_prefix;
		unit_key_pos[index] = packet->key_pos + CHIAKI_GKCRYPT_BLOCK_SIZE;
		cc_video_units_deferred++;
	}
}

static int reserve(uint8_t **buffer, size_t *size, size_t needed)
{
	if(*size >= needed)
		return 1;
	uint8_t *grown = realloc(*buffer, needed);
	if(!grown)
		return 0;
	*buffer = grown;
	*size = needed;
	return 1;
}

/* Decrypt every still-encrypted unit in place; called before FEC/assembly. */
ChiakiErrorCode cc_video_decrypt_frame(ChiakiFrameProcessor *fp)
{
	size_t slots = fp->unit_slots_size < SLOTS ? fp->unit_slots_size : SLOTS, stride = fp->buf_stride_per_unit, end = 0;
	int any = 0;
	for(size_t i = 0; i < slots; i++)
		if(unit_deferred[i] && fp->unit_slots[i].data_size)
		{
			any = 1;
			end = (i + 1) * stride;
		}
	if(!any)
		return CHIAKI_ERR_SUCCESS;
	if(!crypt_current || end > fp->frame_buf_size || !reserve(&image, &image_size, end))
		return CHIAKI_ERR_MEMORY;
	memset(image, 0, end);
	for(size_t i = 0; i < slots; i++)
	{
		size_t size = fp->unit_slots[i].data_size;
		if(!unit_deferred[i] || !size)
			continue;
		unit_deferred[i] = 0;
		size_t prefix = unit_prefix[i];
		if(size <= prefix)
			continue;
		size_t length = size - prefix;
		uint64_t key_pos = unit_key_pos[i] + prefix, padding = key_pos % CHIAKI_GKCRYPT_BLOCK_SIZE;
		size_t full = ((padding + length + CHIAKI_GKCRYPT_BLOCK_SIZE - 1) / CHIAKI_GKCRYPT_BLOCK_SIZE) * CHIAKI_GKCRYPT_BLOCK_SIZE;
		if(!reserve(&scratch, &scratch_size, full))
			return CHIAKI_ERR_MEMORY;
		ChiakiErrorCode err = chiaki_gkcrypt_get_key_stream(crypt_current, key_pos - padding, scratch, full);
		if(err != CHIAKI_ERR_SUCCESS)
			return err;
		memcpy(image + i * stride + prefix, scratch + padding, length);
	}
	int native = cc_xor_bytes(fp->frame_buf, image, (int)end);
	if(native < 0)
		return CHIAKI_ERR_UNKNOWN;
	if(native > 0)
		for(size_t i = 0; i < end; i++)
			fp->frame_buf[i] ^= image[i];
	cc_video_frames_decrypted++;
	return CHIAKI_ERR_SUCCESS;
}

