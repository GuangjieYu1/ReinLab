# P1-11 credential scanner independent review

Reviewed `tooling/security/scan-mcp-credentials.py` and `tooling/security/test-scan.py` read-only. No real credential sources were opened, and no implementation or test source was changed. Additional reproductions used temporary synthetic credential files only, mocked Git enumeration, mocked home/log paths, and suppressed local-task discovery so real logs were never read.

## Verified corrections

The scanner's seven pure fixture unit tests pass. The earlier findings are corrected:

- Required missing scopes produce `incomplete`; optional Codex log layouts expose availability explicitly.
- File opening uses O_NOFOLLOW and O_NONBLOCK, followed by regular-file validation. FIFO and symlink fixtures are rejected without blocking.
- Git enumeration suppresses diagnostic stderr; Git object streaming also suppresses stderr. This closes the previously demonstrated secret-bearing broken-ref diagnostic output path.

## Closed P2: unreadable subdirectories formerly disappeared from coverage

The original tree helper called `os.walk` without an `onerror` handler. Directory traversal errors were silently ignored, so an unreadable child directory did not increase readErrors and did not prevent a clean status.

Confirmed with a pure fixture: all required scopes existed; a worktree subdirectory containing the selected synthetic value was chmod 000. The scanner returned `status=passed`, worktree readErrors=0, matchingFiles=0. The fixture restored permissions and removed itself afterwards. No actual secret value was printed.

The final `scan_tree` helper now supplies an os.walk onerror callback that increments readErrors without recording exception text or paths. A deterministic traversal-error unit test was added. Independently reran the actual chmod 000 directory fixture after the correction: status was `incomplete`, worktree readErrors was 1, and the false-pass reproduction was closed. Permissions were restored and temporary files removed. No real credential or real log sources were read.

## Final assessment

No unresolved confirmed P1/P2 remains in this scanner review. Missing required scopes, unreadable files/directories, special-file blocking, and Git diagnostic disclosure have explicit handling and fixture coverage. This assessment is limited to the selected-value scanner behavior and the stated scope/exclusion policy.

## Evidence boundary

This review validates scanner code and synthetic behavior. It does not constitute T9's actual-value audit, OCR of historical images, inspection of genuine shell snapshots/logs, or confirmation that every historical capability-token value was selected for scanning. Prior independently executed 15/15 integration/security/papers results can be included as their separate targeted fixture evidence; they do not replace an actual credential audit.
