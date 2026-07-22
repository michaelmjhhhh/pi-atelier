# Task 3 quality follow-up

## Scope

Resolved the remaining sidebar lifecycle warning without changing split-pane behavior:

- Added a terminal disposed state to the sidebar controller so `show()` after `dispose()` is a no-op.
- Treat a `split.attach(tui)` failure as an activation failure: disable the controller, invalidate the activation generation, stop animation, clear overlay callbacks/handles, hide the split, and close the pending overlay.
- Preserved the existing hide → show lifecycle when the same TUI instance is reused.

## TDD evidence

### RED

Command:

```text
npm test -- --run tests/sidebar.test.ts -t "show after dispose|replacement TUI"
```

Observed before implementation:

```text
Test Files  1 failed (1)
Tests       2 failed | 43 skipped (45)

makes show after dispose a no-op
  expected true to be false

aborts overlay activation when a replacement TUI cannot attach
  expected true to be false
```

Both focused tests demonstrated the persistent enabled state before production code changed.

### GREEN

Focused command after implementation:

```text
npm test -- --run tests/sidebar.test.ts -t "show after dispose|replacement TUI"
```

Observed:

```text
Test Files  1 passed (1)
Tests       2 passed | 43 skipped (45)
```

Final sidebar/split validation:

```text
npm test -- --run tests/sidebar.test.ts tests/split-pane.test.ts
```

Observed:

```text
Test Files  2 passed (2)
Tests       74 passed (74)
```

Type validation:

```text
npm run typecheck
```

Observed: `tsc --noEmit` completed successfully with no diagnostics.

Formatting/lint validation for changed TypeScript files:

```text
npx biome check src/sidebar.ts tests/sidebar.test.ts
```

Observed: `Checked 2 files ... No fixes applied.`

Diff validation:

```text
git diff --check
```

Observed: completed successfully with no whitespace errors.

## Focused regression coverage

- `makes show after dispose a no-op` verifies no second overlay is created, visibility remains false, the prior overlay is closed, and main rendering returns to full width.
- `aborts overlay activation when a replacement TUI cannot attach` verifies the attach error is reported, controller visibility is cleared, pending overlay and handle are closed/hidden, no animation timer persists, and both TUI instances render the main view at full width.

## Residual risk

None identified within the requested lifecycle scope.
