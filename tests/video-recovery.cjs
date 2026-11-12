/* Overload recovery (app/native/video-recovery.c), compiled natively with the
 * real upstream H.264 slice parser and real slices from the H.264 fixture. */
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process');
const fixture=fs.readFileSync('tests/fixtures/h264-sequence.js','utf8'),seq=JSON.parse(fixture.slice(fixture.indexOf('{'),fixture.lastIndexOf('}')+1));
function nals(hex){const b=Buffer.from(hex,'hex'),starts=[];for(let i=0;i+4<=b.length;i++)if(b[i]===0&&b[i+1]===0&&b[i+2]===0&&b[i+3]===1){starts.push(i);i+=3;}return starts.map((s,j)=>b.subarray(s,j+1<starts.length?starts[j+1]:b.length));}
let idr,p;for(const packet of seq.packets)for(const n of nals(packet)){if((n[4]&31)===5&&!idr)idr=n;if((n[4]&31)===1&&!p)p=n;}
const c=bytes=>'{'+[...bytes].join(',')+'}',header=Buffer.concat([Buffer.from('00000001'+seq.sps,'hex'),Buffer.from('00000001'+seq.pps,'hex')]);
test('FEC is skipped only for P-slice frames while waiting for an IDR; reports coalesce',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'civchiaki-recovery-')),code=`
#include <chiaki/frameprocessor.h>
#include <chiaki/bitstream.h>
#include <assert.h>
#include <string.h>
struct chiaki_frame_unit_t { size_t data_size; };
extern ChiakiBitstream *cc_fec_skip_bitstream;
extern double cc_recovery_stats[2];
int cc_frame_skip_fec(ChiakiFrameProcessor *);
int cc_corrupt_report_due(ChiakiSeqNum16, uint64_t);
static uint8_t header[]=${c(header)},idr[]=${c(idr)},p[]=${c(p)},buf[4096];
static int skip(ChiakiBitstream *bs,const uint8_t *slice,size_t n,size_t unit0){
 struct chiaki_frame_unit_t units[2]={{unit0},{0}};ChiakiFrameProcessor fp;memset(&fp,0,sizeof(fp));
 memset(buf,0,sizeof(buf));memcpy(buf+2,slice,n);fp.frame_buf=buf;fp.unit_slots=units;fp.unit_slots_size=2;
 cc_fec_skip_bitstream=bs;return cc_frame_skip_fec(&fp);}
int main(void){
 ChiakiLog log;chiaki_log_init(&log,0,NULL,NULL);ChiakiBitstream bs;chiaki_bitstream_init(&bs,&log,CHIAKI_CODEC_H264);
 assert(chiaki_bitstream_header(&bs,header,sizeof(header)));
 assert(skip(&bs,p,sizeof(p),sizeof(p)+2)==1);      /* P while waiting: skip */
 assert(skip(NULL,p,sizeof(p),sizeof(p)+2)==0);     /* not waiting: FEC as upstream */
 assert(skip(&bs,idr,sizeof(idr),sizeof(idr)+2)==0); /* could be the IDR: keep FEC */
 assert(skip(&bs,p,sizeof(p),0)==0);                 /* unit 0 missing: unknown */
 static const uint8_t junk[]={0,0,0,1,0x09,0x10,0xff};
 assert(skip(&bs,junk,sizeof(junk),sizeof(junk)+2)==0); /* not a slice: keep FEC */
 assert(cc_recovery_stats[0]==1);
 assert(cc_corrupt_report_due(5,1000)&&!cc_corrupt_report_due(5,1050)&&!cc_corrupt_report_due(5,1099));
 assert(cc_corrupt_report_due(5,1100)&&cc_corrupt_report_due(6,1101)&&!cc_corrupt_report_due(6,1150));
 assert(cc_recovery_stats[1]==3);return 0;}
`;
 try{fs.writeFileSync(path.join(dir,'test.c'),code);
  execFileSync('cc',['-O1','-w','-Ithird_party/chiaki/lib/include','-Ithird_party/chiaki/lib/src','-Ibuild/runtime',path.join(dir,'test.c'),'app/native/video-recovery.c','third_party/chiaki/lib/src/bitstream.c','third_party/chiaki/lib/src/log.c','-o',path.join(dir,'test')],{stdio:'pipe'});
  execFileSync(path.join(dir,'test'),{stdio:'pipe'});}
 finally{fs.rmSync(dir,{recursive:true,force:true});}
});
