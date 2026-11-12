/* Recovery under overload. Kept separate from the
 * decryption code so tests/video-recovery.cjs can compile it natively. */
#include <chiaki/frameprocessor.h>
#include <chiaki/bitstream.h>
#include <chiaki/common.h>
#include <stddef.h>
#include <stdint.h>
/* Private to frameprocessor.c; tools/build.py fails if its layout changes. */
struct chiaki_frame_unit_t { size_t data_size; };
/* While the receiver waits for an IDR it discards
 * P-frames anyway, so running FEC on
 * a lossy frame whose first slice is P only delays recovery. Unit 0 is
 * decrypted by then; if it is missing or unparsable, FEC runs as upstream. */
ChiakiBitstream *cc_fec_skip_bitstream;
double cc_recovery_stats[2];
double cc_congestion_signal_count;
double cc_congestion_signals(void) { return cc_congestion_signal_count; } /* FEC jobs skipped, corrupt-frame reports coalesced */
const double *cc_recovery_metrics(void) { return cc_recovery_stats; }

int cc_frame_skip_fec(ChiakiFrameProcessor *fp)
{
	if(!cc_fec_skip_bitstream || !fp->unit_slots_size)
		return 0;
	size_t size = fp->unit_slots[0].data_size;
	if(size <= 2)
		return 0;
	ChiakiBitstreamSlice slice;
	if(!chiaki_bitstream_slice(cc_fec_skip_bitstream, fp->frame_buf + 2, (unsigned)(size - 2), &slice)
		|| slice.slice_type != CHIAKI_BITSTREAM_SLICE_P)
		return 0;
	cc_recovery_stats[0]++;
	return 1;
}

/* Corrupt-frame ranges are cumulative (same start while no frame completes),
 * so a report for the same start within 100 ms is covered by the next one. */
int cc_corrupt_report_due(ChiakiSeqNum16 start, uint64_t now_ms)
{
	static int sent;
	static ChiakiSeqNum16 last_start;
	static uint64_t last_ms;
	if(sent && start == last_start && now_ms - last_ms < 100)
	{
		cc_recovery_stats[1]++;
		return 0;
	}
	sent = 1;
	last_start = start;
	last_ms = now_ms;
	return 1;
}
