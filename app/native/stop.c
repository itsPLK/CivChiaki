/* In a cooperative runtime the stop flag needs no OS pipe or reserved fd. */
#include <chiaki/stoppipe.h>
#include "runtime.h"
#include <poll.h>
#include <math.h>
#include <errno.h>
#include <sys/socket.h>
#include <emscripten/emscripten.h>
ChiakiErrorCode chiaki_stop_pipe_init(ChiakiStopPipe *s) { s->fds[0]=0;return 0; }
void chiaki_stop_pipe_fini(ChiakiStopPipe *s) { (void)s; }
void chiaki_stop_pipe_stop(ChiakiStopPipe *s) { s->fds[0]=1; }
ChiakiErrorCode chiaki_stop_pipe_reset(ChiakiStopPipe *s) { s->fds[0]=0;return 0; }
ChiakiErrorCode chiaki_stop_pipe_select_single(ChiakiStopPipe *s,chiaki_socket_t fd,bool writing,uint64_t ms) {
    double end=ms==UINT64_MAX?INFINITY:emscripten_get_now()+ms;
    for(;;) {
        if(s->fds[0])return CHIAKI_ERR_CANCELED;
        if(fd>=0) {
            struct pollfd p={.fd=fd,.events=writing?POLLOUT:POLLIN};
            int n=poll(&p,1,0);if(n<0)return CHIAKI_ERR_NETWORK;
            if(n && p.revents&(POLLIN|POLLOUT|POLLHUP|POLLERR))return 0;
        }
        if(emscripten_get_now()>=end)return CHIAKI_ERR_TIMEOUT;
        cc_yield_ms(1);
    }
}
ChiakiErrorCode chiaki_stop_pipe_connect(ChiakiStopPipe *s,chiaki_socket_t fd,struct sockaddr *addr,size_t len,uint64_t ms) {
    int n=connect(fd,addr,len);if(n>=0 || errno==EISCONN)return 0;
    if(errno!=EINPROGRESS && errno!=EALREADY)return errno==ECONNREFUSED?CHIAKI_ERR_CONNECTION_REFUSED:CHIAKI_ERR_NETWORK;
    ChiakiErrorCode err=chiaki_stop_pipe_select_single(s,fd,true,ms);if(err)return err;
    int value=0;socklen_t size=sizeof(value);
    if(getsockopt(fd,SOL_SOCKET,SO_ERROR,&value,&size)<0)return CHIAKI_ERR_NETWORK;
    return !value?0:value==ECONNREFUSED?CHIAKI_ERR_CONNECTION_REFUSED:CHIAKI_ERR_NETWORK;
}
