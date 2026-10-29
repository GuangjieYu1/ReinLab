# P1-11 independent files security review

Worktree: `/Users/guangjieyu/.codex/worktrees/research-foundation/ReinLab`, branch `codex/p1-11-mcp-capabilities`.

Reviewed `services/account-runtime/mcp/files.py`, `services/control/src/mcp/files.ts`, and existing files tests. Added only `services/control/test/independent-mcp-files.test.ts`; did not edit implementation. No real credentials, models, browser, database, or infrastructure startup were used. Test commands used login:false and unset DEEPSEEK_API_KEY.

## Finding and correction

Confirmed P2 in the initial Node wrapper: stdout chunks were decoded separately with `chunk.toString()`. A valid UTF-8 file containing Chinese/emoji was correct on disk but was returned with corrupted characters when multibyte characters crossed pipe chunks. The independent regression first failed on Node 22.

Root subsequently changed the wrapper to retain Buffer chunks and decode Buffer.concat once. The independent UTF-8 regression now passes. This reviewer did not make that implementation change.

## Final independent checks

Six tests pass on Node 22.23.3 and Node 24.14.1:

1. Unicode content survives writing and reading exactly across pipe chunk boundaries.
2. Ten concurrent helpers preserve every independent write and pre-existing content.
3. Injected precommit failure leaves both target files and version history unchanged; duplicate patch destinations are rejected.
4. Undo requires scope for every original path, rejects a partial scope without changes, and preserves unrelated later writes.
5. Ancestor symlinks, listed symlinks, unrelated hardlinks, and FIFO presence are rejected without writing outside the dossier.
6. Fifty newest versions are retained, an expired version cannot be undone, and a retained latest version restores the expected content.

The fixture canonicalizes macOS temporary root paths with realpath before calling the helper, matching its trusted canonical-root contract. An initial fixture using `/var/...` instead of `/private/var/...` correctly failed closed. An initial concurrent test used Promise.all, allowing cleanup to race still-running child processes after a rejection; it now waits for all processes to settle before asserting or cleaning up. Subsequent full runs pass; no stable implementation concurrency failure was confirmed.

## Review assessment and limits

No unresolved P1/P2 security defect was confirmed in this stage after the UTF-8 fix. Descriptor-relative traversal with O_NOFOLLOW, hardlink/special-file rejection, per-dossier flock, stage copy and atomic directory exchange, precommit inode identity metadata, and scoped path-wise undo are consistent with the tested boundary. The Node process supplies an explicit PATH-only child environment; no parent credentials are inherited through that environment or supplied to the helper.

Tests cover ordinary concurrency and a controlled failure before commit. They do not establish power-loss durability or arbitrary process-kill recovery at every syscall. Atomic exchange was exercised on this macOS host, not the Linux account container. Account-image wiring, authorization transport into the deployed account process, and backup retention of old versions remain explicitly outside this implementation stage and this review's certification.
