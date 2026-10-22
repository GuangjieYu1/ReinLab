# P1-11 independent security stage review

Reviewed worktree: `/Users/guangjieyu/.codex/worktrees/research-foundation/ReinLab`, branch `codex/p1-11-mcp-capabilities`, uncommitted token/authority/engine/migration stage.

Only added `services/control/test/independent-mcp-security.test.ts`. No implementation edits, real credentials, browser, real models, or infrastructure startup. Commands used `login:false` and unset `DEEPSEEK_API_KEY`. Tests used the explicitly authorized disposable PostgreSQL 16 fixture on loopback port 55433.

## Finding: P2 — ask read approvals cannot be resumed without requestId

`services/control/src/mcp/engine.ts:50-51` only requires requestId for idempotent capabilities. A non-idempotent read capability with an ask grant receives an internal random requestId. The approval response returns approvalId but not that requestId. A retry without requestId generates a different requestId and fails APPROVAL_INVALID; the approved call cannot be resumed.

Reproduction uses the legitimate narrowing catalog mapping `memory_read -> memory.read` with minimumPermission ask. A request without requestId currently returns APPROVAL_REQUIRED and creates an approval, instead of rejecting before approval creation. The added regression expects REQUEST_ID_REQUIRED. Alternatively returning and preserving requestId in the response would also resolve the issue, with an adjusted test.

## Verification performed

- Node 22.23.3: first six independent tests, 5 passed / 1 failed (the finding above).
- Node 24.14.1: seven independent tests, 6 passed / 1 failed (same finding).
- Passed checks: signed but unregistered identity denied; plain claims passed to validateClient denied; foreign-account transaction cannot validate another account token; overlapping issuance and run revocation leave every issued token invalid and prohibit later issuance; direct server mismatch/schema/foreign-account approval denied; admitted concurrent duplicate observes unknown state without a second effect; successful request replays original result; consumed approval and final invocation result cannot be reverted; a handler with unknown outcome cannot be re-executed; NULL-decision consumption fails CHECK; mismatched dossier credential fails composite FK; app role cannot read anonymous audit or delete run revocation records.

The earlier migration trigger-field and nullable CHECK issues are corrected. Real PG tests exercised credential revocation, approval decision/consumption, invocation finalization, and relevant immutable guards successfully. No new P1 token/tenant/revocation defect was confirmed in this stage.

## Remaining integration requirements

- Approval rows/events currently include capability and argsHash, but no user-readable target/change summary. Before exposing user approval routes, provide a safe, bounded operation summary (e.g. file destination and change summary) so a human can review what the bound hash represents. A hash alone is not an informed operation description.
- Concrete files/memory/cards handlers are intentionally not implemented at this stage. This review does not certify their path, memory-level/reference, card-schema, or gate mutation checks.
- Admission validation releases DB locks before the handler runs. Treat admission as the operation authorization linearization point; concrete handlers must not silently defer new independent effects beyond that admission, and must enforce context.scope themselves.
- This is targeted independent security testing, not the final full-suite/Node matrix or credential-value scan evidence.
