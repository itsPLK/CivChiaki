/* Native scheduler backend adapted from CivHomebrew, revision
 * bb5dc87abf1415c0edcf0e71da3a37dbbe0da543, XITRIX.
 * Chiaki changes: owned binary transfer helper, bounded partial reads, binary
 * uploads while idle, and bounded larger metadata scripts. Lifecycle and native
 * entry fingerprints are retained. No launcher/core files are changed.
 */
(function(g){
    "use strict";
    var CIV_WORKER_MAGIC = 0x42564943;
    function createCivWorkerNative(primitives) {
        var p = primitives || {};
        var _main_base = p.main_base !== undefined ? p.main_base : (typeof main_base !== "undefined" ? main_base : 0n);
        var _call_rop = p.call_rop || (typeof call_rop === "function" ? call_rop : null);
        var _read8 = p.read8 || (typeof read8 === "function" ? read8 : null);
        var _read32 = p.read32 || (typeof read32 === "function" ? read32 : null);
        var _read64 = p.read64 || (typeof read64 === "function" ? read64 : null);
        var _write32 = p.write32 || (typeof write32 === "function" ? write32 : null);
        var _write64 = p.write64 || (typeof write64 === "function" ? write64 : null);
        var _malloc = p.malloc || (typeof malloc === "function" ? malloc : null);
        var _free = p.free || (typeof free === "function" ? free : null);
        var _addrof = p.addrof || (typeof addrof === "function" ? addrof : null);
        var _now = p.now || (typeof performance !== "undefined" && typeof performance.now === "function" ? function() { return performance.now(); } : Date.now);

        if (!_call_rop || !_read8 || !_read32 || !_read64 || !_write32 || !_write64 || !_malloc || !_free || !_addrof) {
            throw new Error("CivSwitch native primitives unavailable.");
        }

        var state = {
            status: "starting", stage: "preflight", system: 0n, context: 0n, root: 0n,
            buffers: [], nativeDisposed: false, contextDisposed: false, contextCleanupStarted: false,
            submissionStarted: false, callbackComplete: false, adapterInFlight: false,
            adapter: null, depMode: null, tempMode: null, manager: 0n, poisoned: null
        };
        var contextId = 0n, scriptName = null, sourceLimit = 1024;

        function releaseBuffer(ptr) {
            var idx = state.buffers.indexOf(ptr);
            if (idx < 0) throw new Error("release of an untracked buffer");
            _free(ptr);
            state.buffers.splice(idx, 1);
        }

        var entries = {
            factory: [0x7e4e40n, [0xa9be7bfd, 0xa9014ff4, 0x910003fd, 0xaa0003f4]],
            context: [0x7e58acn, [0xd10243ff, 0xa9057bfd, 0xf90033f7, 0xa90757f6]],
            script: [0x7e5de0n, [0xf9402409, 0xb40006c9, 0x9e670120, 0x93407c28]],
            destroy: [0x7e5880n, [0xa9be7bfd, 0xf9000bf3, 0x910003fd, 0xaa0003f3]],
            setPolicy: [0x24407ccn, [0x52993a08, 0xf8686808, 0xb9004901, 0xd65f03c0]],
            getPolicy: [0x24407dcn, [0x52993a08, 0xf8686808, 0xb9404900, 0xd65f03c0]],
            inUse: [0x24413b4n, [0x5294a908, 0xf8686808, 0xf100011f, 0x1a9f07e0]],
            pending: [0x7e6834n, [0x9101a000, 0x14004248, 0xaa0003e1, 0x9101a000]],
            pendingHelper: [0x7f7158n, [0xa9be7bfd, 0xa9014ff4, 0x910003fd, 0xaa0003f3]],
            contextCtor: [0x7d1a0cn, [0xb900001f, 0xd003de48, 0xf900041f, 0x39008003, 0xa9017c1f, 0x3979d108, 0x7100011f, 0x7900441f, 0x1a9f07e8, 0x2a080028, 0x39008408, 0xd65f03c0]],
            contextDtor: [0x7d1a3cn, [0xa9be7bfd, 0xf9000bf3, 0x910003fd, 0xaa0003f3]],
            submit: [0x7d1a90n, [0xd10183ff, 0xa9017bfd, 0xf90013f9, 0xa9035ff8]],
            acquireRoot: [0x71d5acn, [0x91002008, 0x88dffd00, 0xd65f03c0]],
            memcpy: [0x346d370n, [0xb000cad0, 0xf9404611, 0x91022210, 0xd61f0220]],
            thunk: [0xb4174cn, [0xa9408408, 0xf9400c09, 0x8b890500, 0x36000069, 0xf9400008, 0xf8616901, 0xd61f0020]],
            checkpoint: [0x24406c4n, [0x52993a08, 0xaa0003e1, 0xf8686800, 0x39413008, 0x350000a8, 0xb9404008, 0x35000068, 0xb9404408, 0x34000048, 0xd65f03c0, 0x1404577e]],
            locker: [0x2559838n, [0xf81d0ffe, 0xa90157f6, 0xa9024ff4, 0x52802008]],
            enter: [0x240b2acn, [0x1404c9d6, 0xa9bc67fe, 0xa9015ff8, 0xa90257f6]],
            exit: [0x240b4b4n, [0x1404c987]],
            unlock: [0x2559b94n, [0xa9be57fe, 0xa9014ff4, 0x39400008]]
        };

        function need(ok, message) { if (!ok) throw new Error(message); }
        function isPointer(ptr) { return typeof ptr === "bigint" && ptr >= 0x10000n && ptr < 0x8000000000n && (ptr & 7n) === 0n; }

        function fingerprint(key) {
            var entry = entries[key], offset = entry[0], words = entry[1];
            for (var i = 0; i < words.length; i++) {
                need(_read32(_main_base + offset + BigInt(i * 4)) === BigInt(words[i]), "code mismatch: " + key);
            }
        }

        function validateSystem() {
            need(isPointer(state.system), "invalid owned ScriptSystem pointer");
            need(_read64(state.system) === _main_base + 0x4bf7c48n, "owned ScriptSystem vtable mismatch");
            var isolate = _read64(state.system + 0x20n);
            need(isPointer(isolate), "invalid owned isolate pointer");
            var runner = _read64(state.system + 0x30n);
            need(isPointer(runner) && _read64(runner) === _main_base + 0x4bf7ce8n, "external-runner vtable mismatch");
            need(_read64(runner + 0x18n) === state.system, "external-runner owner marker mismatch");
            return isolate;
        }

        var marker = 0x43565332n; // 'CVS2'

        function validateAdapter() {
            var a = state.adapter;
            need(a && isPointer(a.outer) && isPointer(a.inner) && isPointer(a.table), "invalid adapter buffers");
            var isolate = validateSystem();
            need(_read64(a.outer) === _main_base + 0x4bf7d00n && _read64(a.outer + 8n) === isolate, "outer adapter mismatch");
            need(_read64(a.outer + 0x10n) === a.inner && _read64(a.outer + 0x18n) === marker, "outer capture mismatch");
            need(_read64(a.inner) === a.table && _read64(a.inner + 8n) === isolate, "inner adapter mismatch");
            need(_read64(a.inner + 0x10n) === _main_base + entries.checkpoint[0], "checkpoint target mismatch");
            need(_read64(a.inner + 0x18n) === 0n && _read64(a.inner + 0x20n) === marker, "inner marker mismatch");
            need(_read64(a.table) === 0n && _read64(a.table + 8n) === 0n, "unexpected destructor slots");
            need(_read64(a.table + 0x10n) === _main_base + entries.thunk[0] && _read64(a.table + 0x18n) === marker, "thunk table mismatch");
        }

        function callEntry(key) {
            fingerprint(key);
            if (key === "pending") fingerprint("pendingHelper");
            if (key !== "factory") validateSystem();
            if (key === "execute") {
                validateAdapter();
                var deps = ["thunk", "checkpoint", "locker", "enter", "exit", "unlock"];
                for (var i = 0; i < deps.length; i++) fingerprint(deps[i]);
                state.adapterInFlight = true;
            }
            var args = [_main_base + entries[key][0]];
            for (var j = 1; j < arguments.length; j++) args.push(arguments[j]);
            var result = _call_rop.apply(null, args);
            if (key === "execute") state.adapterInFlight = false;
            return result;
        }

        function allocate(bytes) {
            var ptr = _malloc(bytes);
            need(isPointer(ptr), "loader allocation failed/alignment mismatch");
            state.buffers.push(ptr);
            for (var i = 0; i < bytes; i += 4) _write32(ptr + BigInt(i), 0n);
            return ptr;
        }

        function asciiBuffer(text) {
            var isBytes = text instanceof Uint8Array;
            var len = text.length;
            need(len > 0 && len < sourceLimit, "source bound exceeded");
            var aligned = (len + 4) & ~3;
            var ptr = _malloc(aligned);
            need(isPointer(ptr), "loader allocation failed/alignment mismatch");
            state.buffers.push(ptr);
            _write32(ptr + BigInt(aligned - 4), 0n);
            for (var i = 0; i < len; i += 4) {
                var word = 0;
                for (var j = 0; j < 4 && i + j < len; j++) {
                    var c = isBytes ? text[i + j] : text.charCodeAt(i + j);
                    need(c > 0 && c < 128, "only ASCII source supported");
                    word |= c << (j * 8);
                }
                _write32(ptr + BigInt(i), BigInt(word >>> 0));
            }
            return { pointer: ptr, length: BigInt(len) };
        }

        function runScript(stage, text) {
            state.stage = stage;
            var source = asciiBuffer(text);
            var status;
            try {
                status = callEntry("script", state.system, contextId, source.pointer, source.length, scriptName.pointer, scriptName.length);
            } finally {
                releaseBuffer(source.pointer);
            }
            need((status & 1n) === 1n, "worker script failed: " + stage);
        }

        function readRootCount() {
            fingerprint("acquireRoot");
            return _call_rop(_main_base + entries.acquireRoot[0], state.root + 0x20n);
        }

        function preflightScheduler() {
            var manager = _read64(_main_base + 0x839be18n);
            need(isPointer(manager), "Platform/GTS manager is not initialized");
            var depMode = _read8(_main_base + 0x839be73n);
            var tempMode = _read8(_main_base + 0x839be74n);
            state.manager = manager;
            state.depMode = depMode;
            state.tempMode = tempMode;
            need((depMode === 0n || depMode === 1n) && tempMode === 0n,
                "scheduler mode is unsupported; depMode=" + depMode + ", tempMode=" + tempMode + "; refusing");
        }

        function validateContext(checkArena) {
            need(isPointer(state.context), "invalid scheduler context");
            need(_read64(state.context + 8n) === 0n, "unexpected nested scheduler dependency");
            var expectedDependencyOption = state.depMode === 1n ? 1n : 0n;
            need(_read8(state.context + 0x21n) === 0n && _read8(state.context + 0x22n) === expectedDependencyOption && _read8(state.context + 0x23n) === 0n,
                "scheduler context option/arena/force-class mismatch");
            need(_read8(_main_base + 0x839be73n) === state.depMode && _read8(_main_base + 0x839be74n) === 0n,
                "scheduler mode changed after preflight");
            if (!checkArena) {
                need(_read64(state.context + 0x10n) === 0n, "constructor unexpectedly selected a scheduler arena");
                return 0n;
            }
            var arena = _read64(state.context + 0x10n);
            var fallback0 = _read64(_main_base + 0x839be00n);
            var fallback1 = _read64(_main_base + 0x839be10n);
            need(isPointer(arena) && (arena === fallback0 || arena === fallback1), "context did not select a shared fallback arena");
            return arena;
        }

        function validateRoot(expected) {
            need(isPointer(state.root), "invalid scheduler root task");
            need(_read64(state.context + 0x18n) === state.root, "context/root identity mismatch");
            need(_read64(state.root) === _main_base + 0x4bf77b0n, "root task vtable mismatch");
            need((_read32(state.root + 0x34n) & 0x10n) !== 0n, "root external-retain flag missing");
            need(readRootCount() === expected, "scheduler root reference count mismatch");
        }

        // Preflight loader call gadgets
        var loaderGuards = [[0x515b50n, 0xa9bc7bfd], [0x515a60n, 0xa9be7bfd], [0x3428ec4n, 0xf94032a9]];
        for (var lg = 0; lg < loaderGuards.length; lg++) {
            need(_read32(_main_base + loaderGuards[lg][0]) === BigInt(loaderGuards[lg][1]), "loader fingerprint mismatch");
        }
        var entryKeys = Object.keys(entries);
        for (var ek = 0; ek < entryKeys.length; ek++) fingerprint(entryKeys[ek]);

        try {
            state.stage = "scheduler-preflight";
            preflightScheduler();
            var cfg = allocate(0x18);
            _write32(cfg + 8n, BigInt(32 << 16));
            need(_read64(cfg) === 0n && _read32(cfg + 8n) === 0x00200000n && _read64(cfg + 0x10n) === 0n, "isolate config mismatch");
            state.stage = "factory";
            state.system = callEntry("factory", cfg);
            var isolate = validateSystem();
            need(callEntry("inUse", isolate) === 0n && callEntry("getPolicy", isolate) === 2n, "unexpected new isolate state");
            callEntry("setPolicy", isolate, 0n);
            need(callEntry("getPolicy", validateSystem()) === 0n, "explicit microtask policy did not stick");
            scriptName = asciiBuffer("CivChiaki-binary-worker");
            state.stage = "create-script-context";
            contextId = callEntry("context", state.system, scriptName.pointer, scriptName.length);
            need(contextId === 1n, "unexpected fresh ScriptSystem context ID");
            state.stage = "build-adapter";
            var a = { outer: allocate(0x20), inner: allocate(0x28), table: allocate(0x20) };
            state.adapter = a;
            isolate = validateSystem();
            _write64(a.outer, _main_base + 0x4bf7d00n);
            _write64(a.outer + 8n, isolate);
            _write64(a.outer + 0x10n, a.inner);
            _write64(a.outer + 0x18n, marker);
            _write64(a.inner, a.table);
            _write64(a.inner + 8n, isolate);
            _write64(a.inner + 0x10n, _main_base + entries.checkpoint[0]);
            _write64(a.inner + 0x18n, 0n);
            _write64(a.inner + 0x20n, marker);
            _write64(a.table + 0x10n, _main_base + entries.thunk[0]);
            _write64(a.table + 0x18n, marker);
            validateAdapter();
        } catch (error) {
            try {
                if (state.system !== 0n && callEntry("inUse", validateSystem()) === 0n && callEntry("pending", state.system) === 0n) {
                    callEntry("destroy", state.system);
                    state.system = 0n;
                }
                if (state.system === 0n) {
                    while (state.buffers.length) _free(state.buffers.pop());
                }
            } catch (cleanupError) {
                error.cleanupError = cleanupError;
            }
            throw error;
        }

        state.status = "ready";
        var SHARED_BYTES = 0n, shared = null, job = null, seq = 0;

        function locateShared() {
            var iso = validateSystem();
            var heap = iso + 0x9768n;
            var sweeper = _read64(heap + 0x8c8n);
            need(isPointer(sweeper), "invalid ArrayBufferSweeper pointer");
            need(_read64(sweeper + 0x58n) === heap, "ArrayBufferSweeper heap back-pointer mismatch");
            var lastError = "extension list unstable";
            for (var attempt = 0; attempt < 4; attempt++) {
                var f00 = _read8(sweeper), f60 = _read8(sweeper + 0x60n);
                var jobState = _read32(sweeper + 0x18n);
                var matches = [], lists = [];
                var nodes = 0, consistent = true;
                var activeLists = (f00 !== 0n || f60 !== 0n)
                    ? [[0xa8n, "young"], [0xc0n, "old"], [0x20n, "young-parked"], [0x38n, "old-parked"]]
                    : [[0xa8n, "young"], [0xc0n, "old"]];
                for (var al = 0; al < activeLists.length; al++) {
                    var listOffset = activeLists[al][0], listName = activeLists[al][1];
                    var head = _read64(sweeper + listOffset), tail = _read64(sweeper + listOffset + 8n);
                    var ext = head, last = 0n, count = 0, walked = 0n;
                    while (isPointer(ext)) {
                        if (++count > 2048) { consistent = false; lastError = "extension list walk exceeded 2048 nodes"; break; }
                        var len = _read64(ext + 0x20n);
                        var bs = _read64(ext + 0x8n);
                        var next = _read64(ext + 0x18n);
                        walked += len;
                        if (len === SHARED_BYTES && isPointer(bs)) {
                            var data = _read64(bs);
                            if (isPointer(data) && _read32(data) === BigInt(CIV_WORKER_MAGIC)) {
                                matches.push({ ext: ext, bs: bs, data: data, list: listName });
                            }
                        }
                        last = ext;
                        ext = next;
                    }
                    if (!consistent) break;
                    if (tail !== last || _read64(sweeper + listOffset) !== head || _read64(sweeper + listOffset + 8n) !== tail) {
                        consistent = false;
                        lastError = "extension list tail mismatch (" + listName + ", f00=" + f00 + ", f60=" + f60 + ", jobState=" + jobState + ")";
                        break;
                    }
                    var stated = _read64(sweeper + listOffset + 0x10n);
                    lists.push({ name: listName, stated: stated, walked: walked, count: count });
                    nodes += count;
                }
                if (!consistent) continue;
                if (matches.length !== 1) {
                    lastError = "expected exactly one " + SHARED_BYTES + "-byte candidate, found " + matches.length;
                    continue;
                }
                var found = matches[0];
                need(_read64(found.bs + 0x8n) === SHARED_BYTES, "BackingStore byte length mismatch");
                need((_read64(found.bs + 0x30n) & 1n) === 0n, "the worker BackingStore claims shared ownership");
                return { sweeper: sweeper, nodes: nodes, found: found, lists: lists, f00: f00, f60: f60 };
            }
            throw new Error(lastError);
        }

        function poison(why) {
            state.poisoned = String(why);
            state.status = "poisoned";
        }

        function assertUsable() {
            if (state.poisoned) throw new Error("worker unusable: " + state.poisoned);
        }

        var transfers = g.CivChiakiWorkerTransfer.create({
            addrof: _addrof, read8: _read8, read32: _read32, read64: _read64,
            memcpy: function(to, from, bytes) { return callEntry("memcpy", to, from, bytes); },
            now: _now, shared: function() { return shared; }, busy: function() { return !!job; }
        });
        function copyOut(dst, bytes, offset) { return transfers.read(dst, bytes, offset); }

        return Object.freeze({
            evaluate: function(stage, text, limit) {
                assertUsable();
                if (job) throw new Error("worker job in flight");
                sourceLimit = limit || 1024;
                try { runScript(stage, text); } finally { sourceLimit = 1024; }
            },
            readShared: function(dst, bytes, offset) {
                assertUsable();
                if (job) throw new Error("worker job in flight");
                return copyOut(dst, bytes, offset);
            },
            writeShared: function(src, offset) {
                assertUsable();
                if (job) throw new Error("worker job in flight");
                return transfers.write(src, offset);
            },
            locate: function(bytes) {
                assertUsable();
                if (job) throw new Error("worker job in flight");
                SHARED_BYTES = BigInt(bytes);
                var walk = locateShared();
                shared = { bs: walk.found.bs, data: walk.found.data, bytes: bytes, list: walk.found.list, nodes: walk.nodes };
                return { list: shared.list, nodes: shared.nodes };
            },
            submit: function(queueScript) {
                assertUsable();
                if (job) throw new Error("worker job in flight");
                var label = "job-" + (++seq);
                need(typeof queueScript === "string" && queueScript.length <= 65536 + 256, "queue source bound exceeded");
                sourceLimit = Math.max(1024, queueScript.length + 1);
                try { runScript("queue-" + label, queueScript); } finally { sourceLimit = 1024; }
                need(callEntry("inUse", validateSystem()) === 0n, "isolate in use before submission");
                var r = { label: label, submitAtMs: null, submitReturnedAtMs: null, completeSeenAtMs: null, elapsedMs: null,
                    submitReturnedCount: null, completionCount: null, framesWhilePending: 0, outcome: null };
                var a = state.adapter;
                try {
                    state.stage = "create-scheduler-context-" + label;
                    state.contextDisposed = false;
                    state.contextCleanupStarted = false;
                    state.callbackComplete = false;
                    state.context = allocate(0x28);
                    callEntry("contextCtor", state.context, 0n, 0n, 0n);
                    need(_read32(state.context + 0x20n) === 0n, "unexpected scheduler context mode before option");
                    if (state.depMode === 1n) {
                        _write32(state.context + 0x20n, 0x00010000n);
                        need(_read32(state.context + 0x20n) === 0x00010000n, "dependency suppression option did not stick");
                    }
                    validateContext(false);
                    need(_read64(state.context + 0x18n) === 0n, "root unexpectedly existed before submit");
                    validateAdapter();

                    state.stage = "submit-" + label;
                    need(_read8(state.context + 0x20n) === 0n, "immediate-execution flag is not zero");
                    need(_read64(state.context + 0x10n) === 0n, "context arena was populated before scheduler setup");
                    state.submissionStarted = true;
                    r.submitAtMs = _now();
                    _call_rop(_main_base + entries.submit[0], state.context, a.outer, a.outer + 8n);
                    r.submitReturnedAtMs = _now();
                    state.root = _read64(state.context + 0x18n);
                    need(isPointer(state.root), "submitter did not create a root task");
                    var submittedCount = readRootCount();
                    r.submitReturnedCount = submittedCount;
                    need(submittedCount === 2n || submittedCount === 3n, "unexpected post-submit root count");
                    validateContext(true);
                } catch (error) {
                    if (state.submissionStarted) poison("submission failed after start: " + error);
                    throw error;
                }
                job = r;
                if (r.submitReturnedCount === 2n) r.completeSeenAtMs = r.submitReturnedAtMs;
                return seq;
            },
            poll: function(dst, timeoutMs, waitMs, bytes) {
                assertUsable();
                if (!job) throw new Error("no worker job in flight");
                var r = job;
                if (r.completeSeenAtMs === null) {
                    var count = readRootCount();
                    if (count === 3n && waitMs > 0) {
                        var deadline = _now() + Math.min(waitMs, 10);
                        while (count === 3n && _now() < deadline) {
                            count = _call_rop(_main_base + entries.acquireRoot[0], state.root + 0x20n);
                        }
                    }
                    if (count === 3n) {
                        r.framesWhilePending++;
                        if (_now() - r.submitAtMs > timeoutMs) poison("job " + r.label + " exceeded " + timeoutMs + " ms");
                        assertUsable();
                        return null;
                    }
                    need(count === 2n, "root count left the expected one-child state");
                    r.completeSeenAtMs = _now();
                }
                var submittedCount = r.submitReturnedCount, label = r.label;
                try {
                    r.completionCount = readRootCount();
                    need(r.completionCount === 2n, "scheduled callback did not finish within 300 frames: " + label);
                    r.elapsedMs = r.completeSeenAtMs - r.submitAtMs;
                    r.outcome = submittedCount === 2n ? "complete-at-submit-return" :
                        (r.framesWhilePending > 0 ? "frames-advanced-while-child-pending" : "no-pending-frame-sample");
                    state.callbackComplete = true;
                    validateRoot(2n);
                    need(callEntry("inUse", validateSystem()) === 0n, "worker left isolate entered");

                    state.stage = "release-scheduler-context-" + label;
                    state.contextCleanupStarted = true;
                    callEntry("contextDtor", state.context);
                    need(_read64(state.context + 0x10n) === 0n && _read64(state.context + 0x18n) === 0n, "scheduler context destructor left owned pointers");
                    state.contextDisposed = true;
                    state.root = 0n;
                    _free(state.context);
                    state.buffers.splice(state.buffers.indexOf(state.context), 1);
                    state.context = 0n;
                    state.submissionStarted = false;
                } catch (error) {
                    poison("completion failed: " + error);
                    throw error;
                }
                job = null;
                var copyMs = copyOut(dst, bytes);
                return { seq: Number(r.label.slice(4)), waitMs: r.completeSeenAtMs - r.submitReturnedAtMs,
                    submitMs: r.submitReturnedAtMs - r.submitAtMs, copyMs: copyMs, inline: submittedCount === 2n };
            },
            get busy() { return !!job; },
            forgetShared: function() { shared = null; SHARED_BYTES = 0n; },
            stats: function() {
                return { status: state.status, poisoned: state.poisoned, jobs: seq, busy: !!job,
                    buffers: state.buffers.length, shared: shared ? { bytes: shared.bytes, list: shared.list } : null };
            },
            _tryDestroyIdle: function() {
                if (job || state.poisoned) return false;
                try {
                    if (state.system !== 0n && callEntry("inUse", validateSystem()) === 0n && callEntry("pending", state.system) === 0n) {
                        callEntry("destroy", state.system);
                        state.system = 0n;
                        while (state.buffers.length) _free(state.buffers.pop());
                        return true;
                    }
                } catch (e) {}
                return false;
            }
        });
    }


    g.CivChiakiWorkerNative={create:createCivWorkerNative};
})(typeof window!=="undefined"?window:globalThis);
