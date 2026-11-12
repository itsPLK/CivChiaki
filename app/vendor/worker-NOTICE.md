The native scheduler backend in worker-native.js is adapted from XITRIX's
CivHomebrew app/src/platform/native-worker.js, revision
bb5dc87abf1415c0edcf0e71da3a37dbbe0da543.

The ScriptSystem/isolate, scheduler lifecycle and instruction fingerprints are
retained. Chiaki changes are limited to an app-owned namespace, a checked
bidirectional transfer helper, prefix/range result reads and bounded metadata
scripts. The generic high-level CivHomebrew worker interface is replaced by
Chiaki's worker.js adapter.

The original source is from the same CivHomebrew project credited for the
native keyboard in CivChiakiNotices. This backend runs only
on the fingerprint-checked Civ VII build. Its native isolate is retained after
off-thread use, following the original backend's lifecycle restriction.
