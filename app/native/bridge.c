#include <chiaki/session.h>
#include <chiaki/regist.h>
#include <chiaki/log.h>
#include <chiaki/discovery.h>
#include <chiaki/time.h>
#include <arpa/inet.h>
#include "runtime.h"
#include <stdlib.h>
#include <string.h>
extern void cc_log(int level,const char *text);
extern void cc_event(int type,int a,int b,const char *text);
extern void cc_registered(int target,const char *name,const uint8_t *mac,const void *key,const void *morning);
extern int cc_video(uint8_t *,int,int,int);
extern void cc_audio_header(int,int,int);
extern void cc_audio(uint8_t *,int);
extern void cc_discovered(int,const char *,const char *,int);
int cc_verify_video_mac; /* 0: skip video GMAC checks (default) */
double cc_video_mac_skipped;
void cc_set_verify_video_mac(int verify) { cc_verify_video_mac=!!verify; }
double cc_video_mac_skipped_count(void) { return cc_video_mac_skipped; }
static ChiakiLog log_state;
static ChiakiSession session;
static ChiakiRegist registration;
static int mode; /* 0 idle, 1 registering, 2 session, 3 cleaning */
static int cleanup_requested, finished, initialized;
static ChiakiThread cleanup_thread;
static char address[256];
static ChiakiDiscovery discovery;
static ChiakiDiscoveryThread discovery_thread;
static uint64_t discovery_until;
static void logger(ChiakiLogLevel level,const char *text,void *u) { (void)u;cc_log(level,text); }
static void event(ChiakiEvent *e,void *u) {
    (void)u;
    if(e->type==CHIAKI_EVENT_QUIT) { cc_event(e->type,e->quit.reason,0,e->quit.reason_str);cleanup_requested=1; }
    else if(e->type==CHIAKI_EVENT_RUMBLE)cc_event(e->type,e->rumble.left,e->rumble.right,NULL);
    else if(e->type==CHIAKI_EVENT_LOGIN_PIN_REQUEST)cc_event(e->type,e->login_pin_request.pin_incorrect,0,NULL);
    else cc_event(e->type,0,0,NULL);
}
static bool video(uint8_t *buf,size_t size,int32_t lost,bool recovered,void *u) { (void)u;return cc_video(buf,size,lost,recovered)!=0; }
static void audio_header(ChiakiAudioHeader *h,void *u) { (void)u;cc_audio_header(h->rate,h->channels,h->frame_size); }
static void audio_frame(uint8_t *buf,size_t size,void *u) { (void)u;cc_audio(buf,size); }
static void registered(ChiakiRegistEvent *e,void *u) {
    (void)u;
    if(e->type==CHIAKI_REGIST_EVENT_TYPE_FINISHED_SUCCESS) {
        ChiakiRegisteredHost *h=e->registered_host;
        cc_registered(h->target,h->server_nickname,h->server_mac,h->rp_regist_key,h->rp_key);
    } else cc_event(100,e->type,0,NULL);
    cleanup_requested=1;
}
int cc_init(void) {
    if(initialized)return 0;
    chiaki_log_init(&log_state,CHIAKI_LOG_ERROR|CHIAKI_LOG_WARNING|CHIAKI_LOG_INFO,logger,NULL);
    int err=chiaki_lib_init();if(!err)initialized=1;return err;
}
int cc_mode(void) { return mode; }
static void *cleanup(void *arg) {
    int old=(int)(uintptr_t)arg;
    if(old==4) { chiaki_discovery_thread_stop(&discovery_thread);chiaki_discovery_fini(&discovery); }
    else if(old==1)chiaki_regist_fini(&registration);
    else { chiaki_session_join(&session);chiaki_session_fini(&session); }
    finished=1;return NULL;
}
int cc_tick(double budget) {
    if(mode==4 && chiaki_time_now_monotonic_ms()>=discovery_until)cleanup_requested=1;
    if(cleanup_requested && (mode==1 || mode==2 || mode==4)) {
        if(!chiaki_thread_create(&cleanup_thread,cleanup,(void*)(uintptr_t)mode)) { mode=3;cleanup_requested=0; }
    }
    int n=cc_runtime_pump(budget);
    if(finished) { chiaki_thread_join(&cleanup_thread,NULL);finished=0;mode=0;cc_event(101,0,0,NULL); }
    return n;
}
int cc_register(const char *host,int target,const uint8_t *account,uint32_t pin) {
    if(mode || !initialized || strlen(host)>=sizeof(address) || pin>99999999)return CHIAKI_ERR_INVALID_DATA;
    strcpy(address,host);
    ChiakiRegistInfo info={0};info.target=target;info.host=address;info.pin=pin;memcpy(info.psn_account_id,account,8);
    int err=chiaki_regist_start(&registration,&log_state,&info,registered,NULL);if(!err)mode=1;return err;
}
int cc_connect(const char *host,int ps5,const uint8_t *key,const uint8_t *morning,int preset,int fps,int bitrate) {
    if(mode || !initialized || strlen(host)>=sizeof(address) || preset<1 || preset>4 || (fps!=30 && fps!=60) || bitrate<1000 || bitrate>50000)return CHIAKI_ERR_INVALID_DATA;
    strcpy(address,host);ChiakiConnectInfo info={0};info.host=address;info.ps5=!!ps5;
    memcpy(info.regist_key,key,16);memcpy(info.morning,morning,16);
    chiaki_connect_video_profile_preset(&info.video_profile,preset,fps);
    info.video_profile.codec=CHIAKI_CODEC_H264;info.video_profile.bitrate=bitrate;
    info.video_profile_auto_downgrade=false;info.enable_idr_on_fec_failure=true;info.packet_loss_max=0.05;
    int err=chiaki_session_init(&session,&info,&log_state);if(err)return err;
    chiaki_session_set_event_cb(&session,event,NULL);chiaki_session_set_video_sample_cb(&session,video,NULL);
    ChiakiAudioSink sink={.header_cb=audio_header,.frame_cb=audio_frame};chiaki_session_set_audio_sink(&session,&sink);
    err=chiaki_session_start(&session);if(err){chiaki_session_fini(&session);return err;}mode=2;return 0;
}
void cc_stop(void) {
    if(mode==1)chiaki_regist_stop(&registration);
    else if(mode==2)chiaki_session_stop(&session);
    else if(mode==4)cleanup_requested=1;
}
static void discovered(ChiakiDiscoveryHost *h,void *u) {
    (void)u;if(!h->host_addr || !h->system_version)return;
    /* PS5 firmware <8.05 falls through upstream's PS4 numeric thresholds. */
    ChiakiTarget target=chiaki_discovery_host_is_ps5(h)?CHIAKI_TARGET_PS5_1:chiaki_discovery_host_system_version_target(h);
    cc_discovered(target,h->host_addr,h->host_name?h->host_name:"PlayStation",h->state);
}
int cc_discover_at(const char *host) {
    if(mode || !initialized)return CHIAKI_ERR_UNINITIALIZED;
    int err=chiaki_discovery_init(&discovery,&log_state,AF_INET);if(err)return err;
    err=chiaki_discovery_thread_start(&discovery_thread,&discovery,discovered,NULL);
    if(err){chiaki_discovery_fini(&discovery);return err;}
    mode=4;discovery_until=chiaki_time_now_monotonic_ms()+1800;
    struct sockaddr_in addr={.sin_family=AF_INET,.sin_addr.s_addr=INADDR_BROADCAST};
    if(host && *host && inet_pton(AF_INET,host,&addr.sin_addr)!=1){cleanup_requested=1;return CHIAKI_ERR_PARSE_ADDR;}
    for(int ps5=0;ps5<=1;ps5++){
        addr.sin_port=htons(ps5?CHIAKI_DISCOVERY_PORT_PS5:CHIAKI_DISCOVERY_PORT_PS4);
        ChiakiDiscoveryPacket packet={.cmd=CHIAKI_DISCOVERY_CMD_SRCH,.protocol_version=ps5?CHIAKI_DISCOVERY_PROTOCOL_VERSION_PS5:CHIAKI_DISCOVERY_PROTOCOL_VERSION_PS4};
        err=chiaki_discovery_send(&discovery,&packet,(struct sockaddr*)&addr,sizeof(addr));if(err){cleanup_requested=1;return err;}
    }return 0;
}
int cc_discover(void) { return cc_discover_at(NULL); }
int cc_wakeup(const char *host,int ps5,const char *credential) {
    if(mode || !initialized)return CHIAKI_ERR_UNINITIALIZED;
    char *end;uint64_t key=strtoull(credential,&end,16);
    if(end==credential || *end)return CHIAKI_ERR_INVALID_DATA;
    return chiaki_discovery_wakeup(&log_state,NULL,host,key,!!ps5);
}
int cc_login_pin(const char *pin) { return mode==2?chiaki_session_set_login_pin(&session,(const uint8_t*)pin,strlen(pin)):CHIAKI_ERR_UNINITIALIZED; }
int cc_controller(uint32_t buttons,int l2,int r2,int lx,int ly,int rx,int ry) {
    if(mode!=2)return CHIAKI_ERR_UNINITIALIZED;
    ChiakiControllerState state;chiaki_controller_state_set_idle(&state);
    state.buttons=buttons;state.l2_state=l2;state.r2_state=r2;state.left_x=lx;state.left_y=ly;state.right_x=rx;state.right_y=ry;
    return chiaki_session_set_controller_state(&session,&state);
}
