/* Compile the actual adapted ACK handler with a narrow send-buffer/callback harness. */
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process');
test('Takion retires reliable data for valid gap/duplicate ACKs and rejects malformed lengths',()=>{
 const source=fs.readFileSync('build/runtime/takion.c','utf8'),start=source.indexOf('static void takion_handle_packet_message_data_ack(ChiakiTakion *takion, uint8_t flags, uint8_t *buf, size_t buf_size)\n{');assert.ok(start>=0,'Build the core first');const end=source.indexOf('\n}\n',start)+3,handler=source.slice(start,end),dir=fs.mkdtempSync(path.join(os.tmpdir(),'civchiaki-ack-'));
 const code=`
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <arpa/inet.h>
#include <assert.h>
#define CHIAKI_LOGE(...) ((void)0)
#define CHIAKI_LOGW(...) ((void)0)
#define CHIAKI_LOGV(...) ((void)0)
#define CHIAKI_TAKION_SEND_BUFFER_SIZE 16
#define CHIAKI_TAKION_EVENT_TYPE_DATA_ACK 1
typedef uint32_t chiaki_unaligned_uint32_t __attribute__((aligned(1)));
typedef uint16_t chiaki_unaligned_uint16_t __attribute__((aligned(1)));
typedef uint32_t ChiakiSeqNum32;
typedef struct {int type;struct {uint32_t seq_num;} data_ack;} ChiakiTakionEvent;
typedef struct {void *log;int send_buffer;void (*cb)(ChiakiTakionEvent*,void*);void *cb_user;} ChiakiTakion;
static int calls,events;
static void chiaki_takion_send_buffer_ack(int *buffer,uint32_t cumulative,uint32_t *seq,size_t *count){assert(cumulative==0x12345678);calls++;seq[0]=cumulative;*count=1;}
static void callback(ChiakiTakionEvent *e,void *user){assert(e->type==1&&e->data_ack.seq_num==0x12345678);events++;}
${handler}
static void run(unsigned gaps,unsigned duplicates,size_t bytes,int expected){uint8_t raw[81]={0},*p=raw+1;uint32_t seq=htonl(0x12345678);uint16_t a=htons(gaps),b=htons(duplicates);memcpy(p,&seq,4);memcpy(p+8,&a,2);memcpy(p+10,&b,2);ChiakiTakion t={.cb=callback};calls=events=0;takion_handle_packet_message_data_ack(&t,0,p,bytes);assert(calls==expected&&events==expected);}
int main(void){run(0,0,12,1);run(1,0,16,1);run(0,1,16,1);run(2,1,24,1);run(0,0,11,0);run(1,0,12,0);run(0,0,16,0);run(65535,65535,12,0);return 0;}
`;
 try{fs.writeFileSync(path.join(dir,'test.c'),code);execFileSync('cc',['-O2',path.join(dir,'test.c'),'-o',path.join(dir,'test')],{stdio:'pipe'});execFileSync(path.join(dir,'test'));}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
