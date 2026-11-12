/* Video packets are processed on their own cooperative task.
 *
 * Upstream handles video inline in the Takion receive task, so a frame that
 * waits for FEC on the worker stops all socket reads, and the kernel buffer can
 * overflow. Here Takion copies each video
 * packet into a bounded queue (one native-speed copy) and keeps receiving;
 * this task decrypts, assembles and waits for FEC. Audio stays inline.
 */
#include <chiaki/gkcrypt.h>
#include <chiaki/takion.h>
#include <chiaki/thread.h>
#include <chiaki/videoreceiver.h>
#include "runtime.h"
#include <stdlib.h>
#include <string.h>

extern int cc_video_decrypt_begin(ChiakiGKCrypt *, ChiakiVideoReceiver *, ChiakiTakionAVPacket *);
extern void cc_video_decrypt_end(void);

enum { CAPACITY = 2048, BATCH = 32, WAKE_AT = 16 };
typedef struct { ChiakiTakionAVPacket packet; ChiakiGKCrypt *crypt; uint8_t data[]; } Entry;

/* Opt-in (off by default); enable with the client's videoTask option. */
int cc_video_queue_enabled = 0;
double cc_video_queue_stats[4]; /* queued, dropped, high-water mark, processed */
static Entry *ring[CAPACITY];
static size_t head, count;
static ChiakiThread thread;
static ChiakiMutex mutex;
static ChiakiCond cond;
static ChiakiVideoReceiver *receiver;
static int running, stopping, active;

void cc_set_video_queue(int enabled) { cc_video_queue_enabled = !!enabled; }
const double *cc_video_queue_metrics(void) { return cc_video_queue_stats; }
int cc_video_queue_idle(void) { return !count && !active; }

static void process(Entry *e)
{
	if(cc_video_decrypt_begin(e->crypt, receiver, &e->packet))
	{
		chiaki_video_receiver_av_packet(receiver, &e->packet);
		cc_video_decrypt_end();
		return;
	}
	chiaki_gkcrypt_decrypt(e->crypt, e->packet.key_pos + CHIAKI_GKCRYPT_BLOCK_SIZE, e->packet.data, e->packet.data_size);
	chiaki_video_receiver_av_packet(receiver, &e->packet);
}

static void *task(void *user)
{
	(void)user;
	unsigned processed = 0;
	chiaki_mutex_lock(&mutex);
	while(!stopping)
	{
		if(!count)
		{
			chiaki_cond_wait(&cond, &mutex);
			continue;
		}
		Entry *e = ring[head];
		head = (head + 1) % CAPACITY;
		count--;
		active = 1;
		chiaki_mutex_unlock(&mutex);
		process(e);
		free(e);
		cc_video_queue_stats[3]++;
		/* Let the pump honor its deadline and Takion drain the socket. */
		if(++processed % BATCH == 0)
			cc_yield_ms(0);
		chiaki_mutex_lock(&mutex);
		active = 0;
	}
	chiaki_mutex_unlock(&mutex);
	return NULL;
}

static int start(ChiakiVideoReceiver *r)
{
	if(chiaki_mutex_init(&mutex, false))
		return 0;
	if(chiaki_cond_init(&cond))
	{
		chiaki_mutex_fini(&mutex);
		return 0;
	}
	head = count = 0;
	stopping = active = 0;
	receiver = r;
	if(chiaki_thread_create(&thread, task, NULL))
	{
		chiaki_cond_fini(&cond);
		chiaki_mutex_fini(&mutex);
		receiver = NULL;
		return 0;
	}
	running = 1;
	return 1;
}

/* Returns 1 when the packet was taken (queued or dropped because full). */
int cc_video_queue_push(ChiakiGKCrypt *crypt, ChiakiVideoReceiver *r, ChiakiTakionAVPacket *packet)
{
	if(!cc_video_queue_enabled || !packet->is_video || !cc_runtime_current_task())
		return 0;
	if(!running && !start(r))
		return 0;
	if(r != receiver)
		return 0;
	if(count >= CAPACITY)
	{
		cc_video_queue_stats[1]++;
		return 1;
	}
	Entry *e = malloc(sizeof(Entry) + packet->data_size);
	if(!e)
		return 0;
	e->packet = *packet;
	e->crypt = crypt;
	memcpy(e->data, packet->data, packet->data_size);
	e->packet.data = e->data;
	chiaki_mutex_lock(&mutex);
	ring[(head + count) % CAPACITY] = e;
	count++;
	cc_video_queue_stats[0]++;
	if(count > cc_video_queue_stats[2])
		cc_video_queue_stats[2] = count;
	chiaki_cond_signal(&cond);
	chiaki_mutex_unlock(&mutex);
	if(count >= WAKE_AT)
		cc_yield_ms(0);
	return 1;
}

/* After Takion is closed (no more pushes) and before the receiver is freed. */
void cc_video_queue_stop(void)
{
	if(!running)
		return;
	chiaki_mutex_lock(&mutex);
	stopping = 1;
	chiaki_cond_signal(&cond);
	chiaki_mutex_unlock(&mutex);
	chiaki_thread_join(&thread, NULL);
	while(count)
	{
		free(ring[head]);
		head = (head + 1) % CAPACITY;
		count--;
	}
	chiaki_cond_fini(&cond);
	chiaki_mutex_fini(&mutex);
	running = stopping = active = 0;
	receiver = NULL;
}
