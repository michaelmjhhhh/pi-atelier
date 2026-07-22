# Task 2 Report: Temporary Resize Mode

## Scope
Implemented SGR mouse parsing and temporary mouse/keyboard sidebar Resize mode in `src/split-pane.ts`, with focused behavioral coverage in `tests/split-pane.test.ts`.

## TDD Evidence
### RED
Command: `npm test -- tests/split-pane.test.ts`

Result: 13 failures / 9 passes. Failures were the expected missing APIs: `parseSgrMouseEvent` was not a function and `beginResize` was not a function (with dependent Resize-mode failures).

### GREEN
Command: `npm test -- tests/split-pane.test.ts`

Result: 1 test file passed, 22 tests passed.

## Validation
- `npm run typecheck` — passed
- `npm run format:check` — passed
- `npm test` — passed (12 files, 205 tests)

## Changes
- Added strict SGR mouse parser and public `SgrMouseEvent` interface.
- Added Resize options and controller lifecycle APIs.
- Added temporary mouse reporting enable/disable, input subscription cleanup, drag handling, keyboard arrows/shift-arrows/Enter/Escape, rollback, and narrow-terminal reconciliation.
- Added focused parser, lifecycle, drag, cancellation, cleanup, keyboard, and responsive-width tests.

## Self-review
No blockers found. Cleanup is centralized and idempotent; unrelated input returns `undefined`. Public Task 1 APIs and lifecycle behavior remain intact.

## Residual risks
- The resize input subscription is intentionally delegated to the host via `subscribeInput`; integration behavior depends on the host honoring `{ consume: true }`.

## Review Finding: Mouse Press Filtering
### RED
Command: `npm test -- tests/split-pane.test.ts`

Result: 1 failure / 23 passes. The regression test demonstrated that SGR wheel code `64` at the divider incorrectly initiated dragging, changing the sidebar width from 44 to 51 on subsequent motion.

### GREEN
Updated `handleResizeInput` to require a non-motion primary press and explicitly reject the SGR wheel bit (`(mouse.button & 64) === 0`); the existing low-bit check continues to reject non-primary buttons while allowing modifier bits.

Regression coverage verifies wheel and right-button events do not initiate dragging, and unrelated keyboard input (`"a"`) returns `undefined` (unconsumed).

### Validation Results
- `npm test -- tests/split-pane.test.ts` — passed (1 file, 24 tests)
- `npm run typecheck` — passed

## Review Finding: Renderer Throw During Resize Mode
### RED
Command: `npx vitest run tests/split-pane.test.ts`

Result: 1 failure / 24 passes. The regression test reproduced the defect: a throwing reserved-width renderer retried full-width without writing the disable-mouse sequence or unsubscribing, leaving `isResizing()` true.

### GREEN
Updated the render error path to call `stopResize(true)` before disabling the split, reporting the error, and retrying the prior renderer full-width. This safely cancels Resize mode and restores the starting sidebar width while preserving Task 1 error reporting and fallback behavior.

Added regression coverage that begins Resize mode, throws from the prior renderer, and asserts disable mouse reporting, exactly-once input unsubscribe, `isResizing() === false`, error reporting, and the full-width retry.

### Validation Results
- `npx vitest run tests/split-pane.test.ts` — passed (1 file, 25 tests)
- `npm run typecheck` — passed

## Task 2 Cleanup Exception-Safety Hardening
### RED
Command: `npx vitest run tests/split-pane.test.ts --reporter=dot`

Result: 4 focused tests failed as expected. Throwing terminal disable, unsubscribe, `onError`, and `onResizeChange` callbacks escaped cleanup and/or prevented remaining cleanup attempts.

### GREEN
Refactored `stopResize` to clear resize, drag, mouse-reporting, and input-subscription state before independently attempting disable, unsubscribe, `onResizeChange(false)`, and render-request actions through safe-call handling. Begin-resize and render error paths now clean up before safely reporting errors. Full-width renderer retry and idempotence are preserved.

Added focused tests covering throwing disable writes, throwing unsubscribe, throwing `onError` during begin failure, and throwing `onResizeChange`; each verifies best-effort cleanup and `isResizing() === false`.

### Validation
- `npx vitest run tests/split-pane.test.ts --reporter=dot` — passed (1 file, 29 tests)
- `npm run typecheck` — passed
- `npm test -- --reporter=dot` — passed (12 files, 212 tests)
- `npm run format:check` — not clean due to pre-existing `.pi-subagents/artifacts/9fe5fb7b-5122-4520-bfa2-ff1f46f95538_reviewer_meta.json` formatting; source changes are confined to the listed files.

### Residual risks
If `terminal.write(DISABLE_MOUSE)` rejects or throws, physical terminal mouse reporting cannot be claimed disabled; internal state and listener cleanup still complete best-effort.
