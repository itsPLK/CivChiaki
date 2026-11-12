/* POSIX socket calls preserve upstream code while yielding on native readiness. */
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <netdb.h>
#include <poll.h>
#include <fcntl.h>
#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <sys/time.h>
#include "runtime.h"
#include <stdarg.h>
#include <emscripten/emscripten.h>

enum { IO_SOCKET=1, IO_BIND, IO_CONNECT, IO_SENDTO, IO_RECVFROM, IO_NAME,
       IO_SETOPT, IO_GETOPT, IO_SHUTDOWN, IO_CLOSE, IO_POLL };
extern int cc_io(int operation,int a,int b,int c,int d,int e,int f);
typedef struct { int used,nonblocking,receive_timeout,send_timeout; } SocketState;
static SocketState sockets[2048];
static int native_errno(int e) {
    switch(e){case 4:return EINTR;case 9:return EBADF;case 11:case 35:return EAGAIN;case 12:return ENOMEM;
    case 22:return EINVAL;case 24:return EMFILE;case 38:return ENOSYS;case 90:return EMSGSIZE;
    case 92:return ENOPROTOOPT;case 95:return EOPNOTSUPP;case 97:return EAFNOSUPPORT;case 98:return EADDRINUSE;
    case 99:return EADDRNOTAVAIL;case 101:return ENETUNREACH;case 103:return ECONNABORTED;case 104:return ECONNRESET;
    case 106:return EISCONN;case 107:return ENOTCONN;case 110:return ETIMEDOUT;case 111:return ECONNREFUSED;
    case 114:return EALREADY;case 115:return EINPROGRESS;default:return EIO;}
}
static int result(int value) { if(value<0){errno=native_errno(-value);return -1;}return value; }
static int pointer(const void* p) { return (int)(uintptr_t)p; }
static int valid(int fd) { return fd>=0&&fd<2048&&sockets[fd].used; }
int __wrap_socket(int family,int type,int protocol) {
    int fd=result(cc_io(IO_SOCKET,family,type,protocol,0,0,0));
    if(fd>=0){if(fd>=2048){cc_io(IO_CLOSE,fd,0,0,0,0,0);errno=EMFILE;return -1;}sockets[fd]=(SocketState){.used=1,.send_timeout=10000};}
    return fd;
}
int __wrap_bind(int fd,const struct sockaddr* address,socklen_t length) { return result(cc_io(IO_BIND,fd,pointer(address),length,0,0,0)); }
int __wrap_connect(int fd,const struct sockaddr* address,socklen_t length) { return result(cc_io(IO_CONNECT,fd,pointer(address),length,0,0,0)); }
int __wrap_getsockname(int fd,struct sockaddr* address,socklen_t* length) { return result(cc_io(IO_NAME,fd,pointer(address),pointer(length),0,0,0)); }
int __wrap_getpeername(int fd,struct sockaddr* address,socklen_t* length) { return result(cc_io(IO_NAME,fd,pointer(address),pointer(length),1,0,0)); }
int __wrap_setsockopt(int fd,int level,int option,const void* value,socklen_t length) {
    if(!valid(fd)){errno=EBADF;return -1;}
    if(level==SOL_SOCKET&&(option==SO_RCVTIMEO||option==SO_SNDTIMEO)){
        const struct timeval* time=value;if(length!=sizeof(*time)){errno=EINVAL;return -1;}
        int milliseconds=time->tv_sec*1000+time->tv_usec/1000;
        if(option==SO_RCVTIMEO)sockets[fd].receive_timeout=milliseconds;else sockets[fd].send_timeout=milliseconds;
        return 0;
    }
    return result(cc_io(IO_SETOPT,fd,level,option,pointer(value),length,0));
}
int __wrap_getsockopt(int fd,int level,int option,void* value,socklen_t* length) { return result(cc_io(IO_GETOPT,fd,level,option,pointer(value),pointer(length),0)); }
int __wrap_shutdown(int fd,int how) { return result(cc_io(IO_SHUTDOWN,fd,how,0,0,0,0)); }
int __wrap_close(int fd) { if(!valid(fd)){errno=EBADF;return -1;}sockets[fd].used=0;return result(cc_io(IO_CLOSE,fd,0,0,0,0,0)); }
int __wrap_fcntl(int fd,int command,...) {
    if(!valid(fd)){errno=EBADF;return -1;}
    if(command==F_GETFL)return sockets[fd].nonblocking?O_NONBLOCK:0;
    if(command==F_SETFL){va_list args;va_start(args,command);sockets[fd].nonblocking=!!(va_arg(args,int)&O_NONBLOCK);va_end(args);return 0;}
    if(command==F_SETFD)return 0;
    errno=EINVAL;return -1;
}
int __wrap_poll(struct pollfd* fds,nfds_t count,int timeout) {
    double end=emscripten_get_now()+(timeout<0?2147483647.0:timeout);
    for(;;){
        cc_runtime_checkpoint();
        int value=result(cc_io(IO_POLL,pointer(fds),count,0,0,0,0));
        if(value||timeout==0||emscripten_get_now()>=end)return value;
        if(!cc_runtime_current_task()){errno=EWOULDBLOCK;return -1;}cc_yield_ms(2);
    }
}
static ssize_t transfer(int op,int fd,void* data,size_t length,int flags,struct sockaddr* address,void* address_length) {
    if(!valid(fd)){errno=EBADF;return -1;}
    int timeout=op==IO_RECVFROM?sockets[fd].receive_timeout:sockets[fd].send_timeout;
    double end=emscripten_get_now()+(timeout>0?timeout:2147483647.0);
    for(;;){
        cc_runtime_checkpoint();
        int value=result(cc_io(op,fd,pointer(data),length,flags,pointer(address),pointer(address_length)));
        if(value>=0||errno!=EAGAIN)return value;
        if(sockets[fd].nonblocking||(flags&MSG_DONTWAIT)||!cc_runtime_current_task()||emscripten_get_now()>=end)return -1;
        cc_yield_ms(2);
    }
}
ssize_t __wrap_sendto(int fd,const void* data,size_t length,int flags,const struct sockaddr* address,socklen_t address_length) { return transfer(IO_SENDTO,fd,(void*)data,length,flags,(struct sockaddr*)address,(void*)(uintptr_t)address_length); }
ssize_t __wrap_recvfrom(int fd,void* data,size_t length,int flags,struct sockaddr* address,socklen_t* address_length) { return transfer(IO_RECVFROM,fd,data,length,flags,address,address_length); }
ssize_t __wrap_send(int fd,const void* data,size_t length,int flags) { return __wrap_sendto(fd,data,length,flags,NULL,0); }
ssize_t __wrap_recv(int fd,void* data,size_t length,int flags) { return __wrap_recvfrom(fd,data,length,flags,NULL,NULL); }
ssize_t __wrap_sendmsg(int fd,const struct msghdr* message,int flags) {
    size_t length=0;for(size_t i=0;i<message->msg_iovlen;i++)length+=message->msg_iov[i].iov_len;
    if(length>1048576){errno=EMSGSIZE;return -1;}char* data=malloc(length?length:1);if(!data){errno=ENOMEM;return -1;}
    size_t offset=0;for(size_t i=0;i<message->msg_iovlen;i++){memcpy(data+offset,message->msg_iov[i].iov_base,message->msg_iov[i].iov_len);offset+=message->msg_iov[i].iov_len;}
    ssize_t value=__wrap_sendto(fd,data,length,flags,message->msg_name,message->msg_namelen);free(data);return value;
}
ssize_t __wrap_recvmsg(int fd,struct msghdr* message,int flags) {
    size_t length=0;for(size_t i=0;i<message->msg_iovlen;i++)length+=message->msg_iov[i].iov_len;
    if(length>1048576){errno=EMSGSIZE;return -1;}char* data=malloc(length?length:1);if(!data){errno=ENOMEM;return -1;}
    socklen_t address_length=message->msg_namelen;
    ssize_t value=__wrap_recvfrom(fd,data,length,flags,message->msg_name,&address_length);
    if(value>=0){size_t offset=0;for(size_t i=0;i<message->msg_iovlen&&offset<(size_t)value;i++){size_t part=message->msg_iov[i].iov_len;if(part>(size_t)value-offset)part=value-offset;memcpy(message->msg_iov[i].iov_base,data+offset,part);offset+=part;}message->msg_namelen=address_length;message->msg_flags=0;message->msg_controllen=0;}
    free(data);return value;
}

/* Initial experiment accepts numeric IPv4 only; never synthesize fake DNS IPs. */
int __wrap_getaddrinfo(const char* host,const char* service,const struct addrinfo* hints,struct addrinfo** output) {
    if(!host||!output)return EAI_NONAME;
    if(hints&&hints->ai_family!=AF_UNSPEC&&hints->ai_family!=AF_INET)return EAI_FAMILY;
    struct sockaddr_in address={.sin_family=AF_INET};if(inet_pton(AF_INET,host,&address.sin_addr)!=1)return EAI_NONAME;
    if(service){char* end;long port=strtol(service,&end,10);if(*end||port<0||port>65535)return EAI_SERVICE;address.sin_port=htons(port);}
    struct addrinfo* info=calloc(1,sizeof(*info));if(!info)return EAI_MEMORY;
    info->ai_addr=malloc(sizeof(address));if(!info->ai_addr){free(info);return EAI_MEMORY;}memcpy(info->ai_addr,&address,sizeof(address));
    info->ai_family=AF_INET;info->ai_socktype=hints?hints->ai_socktype:SOCK_STREAM;info->ai_protocol=hints?hints->ai_protocol:0;info->ai_addrlen=sizeof(address);*output=info;return 0;
}
void __wrap_freeaddrinfo(struct addrinfo* info) { while(info){struct addrinfo* next=info->ai_next;free(info->ai_addr);free(info->ai_canonname);free(info);info=next;} }
