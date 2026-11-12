cmake_minimum_required(VERSION 3.16)
project(civchiaki C)
if(NOT EMSCRIPTEN)
  message(FATAL_ERROR "Use tools/build.py and the pinned Emscripten SDK")
endif()
get_filename_component(ROOT "${CMAKE_CURRENT_SOURCE_DIR}/.." ABSOLUTE)
set(UP "${ROOT}/third_party/chiaki/lib")
set(NATIVE "${ROOT}/app/native")
set(ENABLE_PROGRAMS OFF CACHE BOOL "" FORCE)
set(ENABLE_TESTING OFF CACHE BOOL "" FORCE)
set(MBEDTLS_FATAL_WARNINGS OFF CACHE BOOL "" FORCE)
set(CIVCHIAKI_OPT "-O3 -flto -mbulk-memory" CACHE STRING "Optimization flags for compile and link")
set(CIVCHIAKI_LINK_EXTRA "-mbulk-memory" CACHE STRING "Extra link flags (semicolon list)")
separate_arguments(CIVCHIAKI_OPT_LIST UNIX_COMMAND "${CIVCHIAKI_OPT}")
add_compile_definitions(MBEDTLS_CONFIG_FILE="${CMAKE_CURRENT_SOURCE_DIR}/crypto-config.h")
add_subdirectory("${ROOT}/third_party/mbedtls" mbedtls EXCLUDE_FROM_ALL)
file(GLOB SOURCES "${UP}/src/*.c")
list(FILTER SOURCES EXCLUDE REGEX "/(takion|streamconnection|senkusha|gkcrypt|frameprocessor|videoreceiver|congestioncontrol|thread|stoppipe|time|random|fec|common|aia|aia_openssl|opusdecoder|opusencoder|ffmpegdecoder|pidecoder)\\.c$")
set(CORE_SOURCES ${SOURCES} "${CMAKE_CURRENT_BINARY_DIR}/common.c" "${CMAKE_CURRENT_BINARY_DIR}/frameprocessor.c"
  "${CMAKE_CURRENT_BINARY_DIR}/senkusha.c" "${CMAKE_CURRENT_BINARY_DIR}/gkcrypt.c"
  "${CMAKE_CURRENT_BINARY_DIR}/streamconnection.c" "${CMAKE_CURRENT_BINARY_DIR}/videoreceiver.c" "${CMAKE_CURRENT_BINARY_DIR}/congestioncontrol.c"
  "${UP}/src/remote/rudp.c" "${UP}/src/remote/rudpsendbuffer.c"
  "${NATIVE}/platform.c" "${NATIVE}/io.c" "${NATIVE}/stop.c" "${NATIVE}/lan.c"
  "${NATIVE}/fec.c" "${NATIVE}/bridge.c" "${NATIVE}/video-decrypt.c" "${NATIVE}/video-queue.c" "${NATIVE}/video-recovery.c" "${CMAKE_CURRENT_BINARY_DIR}/takion.pb.c"
  "${ROOT}/third_party/nanopb/pb_common.c" "${ROOT}/third_party/nanopb/pb_encode.c" "${ROOT}/third_party/nanopb/pb_decode.c")
add_executable(chiaki-core ${CORE_SOURCES} "${CMAKE_CURRENT_BINARY_DIR}/takion.c")
target_include_directories(chiaki-core PRIVATE "${CMAKE_CURRENT_BINARY_DIR}" "${UP}/include" "${UP}/src" "${NATIVE}" "${ROOT}/third_party/nanopb")
target_compile_definitions(chiaki-core PRIVATE CHIAKI_LIB_ENABLE_MBEDTLS CHIAKI_VERSION_MAJOR=1 CHIAKI_VERSION_MINOR=10 CHIAKI_VERSION_PATCH=0 CHIAKI_VERSION="civchiaki")
target_compile_options(chiaki-core PRIVATE ${CIVCHIAKI_OPT_LIST} -fno-vectorize -fno-slp-vectorize)
target_link_libraries(chiaki-core PRIVATE mbedcrypto)
set_target_properties(chiaki-core PROPERTIES SUFFIX ".js")
target_link_options(chiaki-core PRIVATE ${CIVCHIAKI_OPT_LIST} --no-entry
  -sWASM=0 -sSINGLE_FILE=1 -sMODULARIZE=1 -sEXPORT_NAME=ChiakiCore
  -sENVIRONMENT=web,node -sFILESYSTEM=0 -sALLOW_MEMORY_GROWTH=1
  -sINITIAL_MEMORY=33554432 -sMAXIMUM_MEMORY=134217728 -sSTACK_SIZE=1048576
  -sASSERTIONS=1 -sASYNCIFY=1 -sBINARYEN_EXTRA_PASSES=alignment-lowering
  "-sEXPORTED_FUNCTIONS=@${CMAKE_CURRENT_BINARY_DIR}/exports.json"
  "-sEXPORTED_RUNTIME_METHODS=['ccall','cwrap','UTF8ToString','stringToUTF8','lengthBytesUTF8']"
  --js-library "${NATIVE}/platform-library.js" ${CIVCHIAKI_LINK_EXTRA})
foreach(name socket bind connect getsockname getpeername setsockopt getsockopt shutdown close fcntl poll sendto recvfrom send recv sendmsg recvmsg getaddrinfo freeaddrinfo)
  target_link_options(chiaki-core PRIVATE "-Wl,--wrap=${name}")
endforeach()

