#include <chiaki/fec.h>
#include "runtime.h"
extern int cc_fec_begin(uint8_t *,int,int,int,int,const unsigned int *,int,int);
extern int cc_fec_poll(void);
static ChiakiErrorCode perform(uint8_t *buf,size_t unit,size_t stride,unsigned k,unsigned m,const unsigned *erasures,size_t count,int encode) {
    if(stride<unit || k<1 || k+m>256 || unit>65536 || stride>65536 || count>m)return CHIAKI_ERR_INVALID_DATA;
    int result=cc_fec_begin(buf,unit,stride,k,m,erasures,count,encode);
    while(result==1) { if(!cc_runtime_current_task())return CHIAKI_ERR_FEC_FAILED;cc_yield_ms(0);result=cc_fec_poll(); }
    return result==0?0:CHIAKI_ERR_FEC_FAILED;
}
ChiakiErrorCode chiaki_fec_decode(uint8_t *b,size_t u,size_t s,unsigned k,unsigned m,const unsigned *e,size_t n) { return perform(b,u,s,k,m,e,n,0); }
ChiakiErrorCode chiaki_fec_encode(uint8_t *b,size_t u,size_t s,unsigned k,unsigned m) { return perform(b,u,s,k,m,NULL,0,1); }
