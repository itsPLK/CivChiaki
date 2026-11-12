/* Local Remote Play does not invoke the upstream PSN/curl/NAT traversal path. */
#include <arpa/inet.h>
#include <chiaki/remote/holepunch.h>
#include <stdlib.h>
#include <errno.h>
int galois_init_default_field(int w) { return w==8?0:EINVAL; }
ChiakiErrorCode chiaki_aia_init(void) { return 0; }
void chiaki_holepunch_session_fini(ChiakiHolepunchSession s) { if(s)abort(); }
void chiaki_holepunch_main_thread_cancel(ChiakiHolepunchSession s,bool stop) { (void)stop;if(s)abort(); }
ChiakiHolepunchRegistInfo chiaki_get_regist_info(ChiakiHolepunchSession s) { (void)s;abort(); }
void chiaki_get_ps_selected_addr(ChiakiHolepunchSession s,char *ip) { (void)s;(void)ip;abort(); }
uint16_t chiaki_get_ps_ctrl_port(ChiakiHolepunchSession s) { (void)s;abort(); }
chiaki_socket_t *chiaki_get_holepunch_sock(ChiakiHolepunchSession s,ChiakiHolepunchPortType t) { (void)s;(void)t;abort(); }
ChiakiErrorCode holepunch_session_create_offer(ChiakiHolepunchSession s) { (void)s;return CHIAKI_ERR_UNINITIALIZED; }
ChiakiErrorCode chiaki_holepunch_session_punch_hole(ChiakiHolepunchSession s,ChiakiHolepunchPortType t) { (void)s;(void)t;return CHIAKI_ERR_UNINITIALIZED; }
