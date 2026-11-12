/* Chiaki-NG's Mbed TLS implementation uses the legacy 2.x ECDH context ABI. */
#include <mbedtls/config.h>
#define MBEDTLS_NO_PLATFORM_ENTROPY
#define MBEDTLS_ENTROPY_HARDWARE_ALT
#undef MBEDTLS_HAVEGE_C
#undef MBEDTLS_ENTROPY_NV_SEED
