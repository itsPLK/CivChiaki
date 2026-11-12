/* Chiaki threads are stackful cooperative fibers; no browser pthread worker ABI. */
#include "runtime.h"
#include <chiaki/thread.h>
#include <chiaki/time.h>
#include <chiaki/random.h>
#include <emscripten/fiber.h>
#include <emscripten/emscripten.h>
#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>

enum { LIMIT=32, STACK=131072 };
enum { READY, SLEEP, COND, MUTEX, JOIN, DONE };
typedef struct Task {
    emscripten_fiber_t fiber;
    void *stack, *async_stack, *argument, *result, *wait;
    ChiakiThreadFunc entry;
    double deadline;
    uint32_t generation;
    int state, slot, saved_errno, kind;
} Task;
typedef struct { Task *owner; unsigned depth; bool recursive; } Mutex;
static Task *tasks[LIMIT], *current;
static emscripten_fiber_t root;
static unsigned char root_async[STACK];
static int pumping, cursor;
static double pump_deadline;
/* Schema, budget yields, then {segments,total ms,max ms} by ChiakiThreadName. */
static double runtime_metrics[2+13*3]={1};
const double *cc_runtime_metrics(void) { return runtime_metrics; }
static void *load(void *p) { void *v; memcpy(&v,p,sizeof(v)); return v; }
static void store(void *p,void *v) { memcpy(p,&v,sizeof(v)); }
static void suspend(void) {
    if(!current || !pumping) abort();
    current->saved_errno=errno;
    emscripten_fiber_swap(&current->fiber,&root);
    errno=current->saved_errno;
}
static void enter(void *arg) {
    Task *t=arg; t->result=t->entry(t->argument); t->state=DONE; suspend(); abort();
}
ChiakiErrorCode chiaki_thread_create(ChiakiThread *thread,ChiakiThreadFunc entry,void *arg) {
    int i; for(i=0;i<LIMIT && tasks[i];i++);
    if(i==LIMIT) return CHIAKI_ERR_THREAD;
    Task *t=calloc(1,sizeof(*t)); if(!t) return CHIAKI_ERR_MEMORY;
    t->stack=aligned_alloc(16,STACK); t->async_stack=malloc(STACK);
    if(!t->stack || !t->async_stack) { free(t->stack); free(t->async_stack); free(t); return CHIAKI_ERR_MEMORY; }
    t->entry=entry; t->argument=arg; t->slot=i;t->kind=12;
    emscripten_fiber_init(&t->fiber,enter,t,t->stack,STACK,t->async_stack,STACK);
    tasks[i]=t; store(&thread->thread,t); return CHIAKI_ERR_SUCCESS;
}
static ChiakiErrorCode join(ChiakiThread *thread,void **out,double end) {
    Task *t=load(&thread->thread); if(!t || t==current) return CHIAKI_ERR_THREAD;
    while(t->state!=DONE) {
        if(emscripten_get_now()>=end) return CHIAKI_ERR_TIMEOUT;
        if(!current) return CHIAKI_ERR_THREAD;
        current->state=JOIN; current->wait=t; current->deadline=end; suspend();
    }
    if(out) *out=t->result;
    tasks[t->slot]=NULL; free(t->stack); free(t->async_stack); free(t); store(&thread->thread,NULL);
    return CHIAKI_ERR_SUCCESS;
}
ChiakiErrorCode chiaki_thread_join(ChiakiThread *t,void **out) { return join(t,out,INFINITY); }
ChiakiErrorCode chiaki_thread_timedjoin(ChiakiThread *t,void **out,uint64_t ms) { return join(t,out,emscripten_get_now()+ms); }
ChiakiErrorCode chiaki_thread_set_name(ChiakiThread *t,const char *name) { (void)t;(void)name;return CHIAKI_ERR_SUCCESS; }
void chiaki_thread_set_affinity(ChiakiThreadName name) { if(current && name>=0 && name<12)current->kind=name; }
void chiaki_thread_set_affinity_cb(ChiakiThreadAffinityFunc fn,void *user) { (void)fn;(void)user; }
int cc_runtime_current_task(void) { return current!=NULL; }
int cc_runtime_tasks(void) { int n=0;for(int i=0;i<LIMIT;i++)if(tasks[i])n++;return n; }
void cc_yield_ms(int ms) { current->deadline=emscripten_get_now()+ms;current->state=SLEEP;suspend(); }
void cc_runtime_checkpoint(void) { if(current && emscripten_get_now()>=pump_deadline){runtime_metrics[1]++;cc_yield_ms(0);} }
static int runnable(Task *t) {
    if(t->state==DONE)return 0;
    if(t->state==READY)return 1;
    if(t->state==MUTEX)return !((Mutex*)t->wait)->owner;
    if(t->state==JOIN && ((Task*)t->wait)->state==DONE)return 1;
    if(t->state==COND && *(uint32_t*)t->wait!=t->generation)return 1;
    return emscripten_get_now()>=t->deadline;
}
int cc_runtime_pump(double budget) {
    if(pumping || !isfinite(budget) || budget<=0 || budget>50)return -1;
    pumping=1; pump_deadline=emscripten_get_now()+budget;
    emscripten_fiber_init_from_current_context(&root,root_async,sizeof(root_async));
    int n=0;
    for(int scan=0;scan<LIMIT*8 && n<128;scan++) {
        Task *t=tasks[cursor];cursor=(cursor+1)%LIMIT;
        if(!t || !runnable(t))continue;
        current=t;t->state=READY;double start=emscripten_get_now();emscripten_fiber_swap(&root,&t->fiber);double elapsed=emscripten_get_now()-start;
        int metric=2+t->kind*3;runtime_metrics[metric]++;runtime_metrics[metric+1]+=elapsed;if(elapsed>runtime_metrics[metric+2])runtime_metrics[metric+2]=elapsed;
        current=NULL;n++;
        if(emscripten_get_now()>=pump_deadline)break;
    }
    pumping=0;return n;
}
ChiakiErrorCode chiaki_mutex_init(ChiakiMutex *m,bool rec) {
    _Static_assert(sizeof(m->mutex)>=sizeof(void*),"opaque mutex storage");
    Mutex *p=calloc(1,sizeof(*p));if(!p)return CHIAKI_ERR_MEMORY;p->recursive=rec;store(&m->mutex,p);return 0;
}
ChiakiErrorCode chiaki_mutex_fini(ChiakiMutex *m) { free(load(&m->mutex));store(&m->mutex,NULL);return 0; }
ChiakiErrorCode chiaki_mutex_trylock(ChiakiMutex *m) {
    Mutex *p=load(&m->mutex);
    /* Root API calls use a sentinel owner; they never hold a lock across a pump. */
    Task *owner=current?current:(Task*)(uintptr_t)1;
    if(p->owner && !(p->owner==owner && p->recursive))return CHIAKI_ERR_MUTEX_LOCKED;
    p->owner=owner;p->depth++;return 0;
}
ChiakiErrorCode chiaki_mutex_lock(ChiakiMutex *m) {
    while(chiaki_mutex_trylock(m)!=0) {
        if(!current)return CHIAKI_ERR_MUTEX_LOCKED;
        current->wait=load(&m->mutex);current->deadline=INFINITY;current->state=MUTEX;suspend();
    }return 0;
}
ChiakiErrorCode chiaki_mutex_unlock(ChiakiMutex *m) {
    Mutex *p=load(&m->mutex);if(p->owner!=(current?current:(Task*)(uintptr_t)1))return CHIAKI_ERR_MUTEX_LOCKED;
    if(!--p->depth)p->owner=NULL;return 0;
}
ChiakiErrorCode chiaki_cond_init(ChiakiCond *c) { memset(c,0,sizeof(*c));return 0; }
ChiakiErrorCode chiaki_cond_fini(ChiakiCond *c) { (void)c;return 0; }
ChiakiErrorCode chiaki_cond_signal(ChiakiCond *c) { ++*(uint32_t*)&c->cond;return 0; }
ChiakiErrorCode chiaki_cond_broadcast(ChiakiCond *c) { return chiaki_cond_signal(c); }
ChiakiErrorCode chiaki_cond_timedwait(ChiakiCond *c,ChiakiMutex *m,uint64_t ms) {
    if(!current)return CHIAKI_ERR_THREAD;
    uint32_t gen=*(uint32_t*)&c->cond;
    current->wait=&c->cond;current->generation=gen;current->deadline=ms==UINT64_MAX?INFINITY:emscripten_get_now()+ms;
    current->state=COND;chiaki_mutex_unlock(m);suspend();
    bool signaled=*(uint32_t*)&c->cond!=gen;
    ChiakiErrorCode err=chiaki_mutex_lock(m);return err?err:signaled?0:CHIAKI_ERR_TIMEOUT;
}
ChiakiErrorCode chiaki_cond_wait(ChiakiCond *c,ChiakiMutex *m) { return chiaki_cond_timedwait(c,m,UINT64_MAX); }
ChiakiErrorCode chiaki_cond_timedwait_pred(ChiakiCond *c,ChiakiMutex *m,uint64_t ms,ChiakiCheckPred pred,void *u) {
    double end=emscripten_get_now()+ms;
    while(!pred(u)) {
        double left=end-emscripten_get_now();if(left<=0)return CHIAKI_ERR_TIMEOUT;
        ChiakiErrorCode err=chiaki_cond_timedwait(c,m,(uint64_t)ceil(left));if(err)return err;
    }return 0;
}
ChiakiErrorCode chiaki_cond_wait_pred(ChiakiCond *c,ChiakiMutex *m,ChiakiCheckPred pred,void *u) {
    while(!pred(u)){ChiakiErrorCode e=chiaki_cond_wait(c,m);if(e)return e;}return 0;
}
uint64_t chiaki_time_now_monotonic_us(void) { return emscripten_get_now()*1000.0; }
extern int cc_random_fill(void *p,int n);
ChiakiErrorCode chiaki_random_bytes_crypt(uint8_t *p,size_t n) { return cc_random_fill(p,n)?CHIAKI_ERR_UNKNOWN:0; }
uint32_t chiaki_random_32(void) { uint32_t n;if(cc_random_fill(&n,4))abort();return n; }
int mbedtls_hardware_poll(void *data,unsigned char *p,size_t len,size_t *olen) {
    (void)data;if(cc_random_fill(p,len)){*olen=0;return -1;}*olen=len;return 0;
}

CHIAKI_EXPORT ChiakiErrorCode chiaki_bool_pred_cond_init(ChiakiBoolPredCond *cond)
{
	cond->pred = false;

	ChiakiErrorCode err = chiaki_mutex_init(&cond->mutex, false);
	if(err != CHIAKI_ERR_SUCCESS)
		return err;

	err = chiaki_cond_init(&cond->cond);
	if(err != CHIAKI_ERR_SUCCESS)
	{
		chiaki_mutex_fini(&cond->mutex);
		return err;
	}

	return CHIAKI_ERR_SUCCESS;
}

CHIAKI_EXPORT ChiakiErrorCode chiaki_bool_pred_cond_fini(ChiakiBoolPredCond *cond)
{
	ChiakiErrorCode err = chiaki_cond_fini(&cond->cond);
	if(err != CHIAKI_ERR_SUCCESS)
		return err;

	err = chiaki_mutex_fini(&cond->mutex);
	if(err != CHIAKI_ERR_SUCCESS)
		return err;

	return CHIAKI_ERR_SUCCESS;
}

CHIAKI_EXPORT ChiakiErrorCode chiaki_bool_pred_cond_lock(ChiakiBoolPredCond *cond)
{
	return chiaki_mutex_lock(&cond->mutex);
}

CHIAKI_EXPORT ChiakiErrorCode chiaki_bool_pred_cond_unlock(ChiakiBoolPredCond *cond)
{
	return chiaki_mutex_unlock(&cond->mutex);
}

bool bool_pred_cond_check_pred(void *user)
{
	ChiakiBoolPredCond *bool_pred_cond = user;
	return bool_pred_cond->pred;
}

CHIAKI_EXPORT ChiakiErrorCode chiaki_bool_pred_cond_wait(ChiakiBoolPredCond *cond)
{
	return chiaki_cond_wait_pred(&cond->cond, &cond->mutex, bool_pred_cond_check_pred, cond);
}

CHIAKI_EXPORT ChiakiErrorCode chiaki_bool_pred_cond_timedwait(ChiakiBoolPredCond *cond, uint64_t timeout_ms)
{
	return chiaki_cond_timedwait_pred(&cond->cond, &cond->mutex, timeout_ms, bool_pred_cond_check_pred, cond);
}

CHIAKI_EXPORT ChiakiErrorCode chiaki_bool_pred_cond_signal(ChiakiBoolPredCond *cond)
{
	ChiakiErrorCode err = chiaki_bool_pred_cond_lock(cond);
	if(err != CHIAKI_ERR_SUCCESS)
		return err;

	cond->pred = true;

	err = chiaki_bool_pred_cond_unlock(cond);
	if(err != CHIAKI_ERR_SUCCESS)
		return err;

	return chiaki_cond_signal(&cond->cond);
}

CHIAKI_EXPORT ChiakiErrorCode chiaki_bool_pred_cond_broadcast(ChiakiBoolPredCond *cond)
{
	ChiakiErrorCode err = chiaki_bool_pred_cond_lock(cond);
	if(err != CHIAKI_ERR_SUCCESS)
		return err;

	cond->pred = true;

	err = chiaki_bool_pred_cond_unlock(cond);
	if(err != CHIAKI_ERR_SUCCESS)
		return err;

	return chiaki_cond_broadcast(&cond->cond);
}
