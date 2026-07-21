# Pi Atelier Activated Tool List Design

## Summary

Extend the sidebar Tools section to show the exact tool names currently activated in Pi. Keep the existing active/available count, then render the activated names as a compact two-column list.

## Visual Structure

```text
│ TOOLS
│ 4 / 7 active
│ bash                 edit
│ read                 write
```

## Data Flow

`pi.getActiveTools()` remains authoritative. `getSidebarSnapshot()` passes both its count and names into `buildSidebarSnapshot()`.

Extend snapshot input/state with:

```ts
activeToolNames: readonly string[];
```

At the snapshot boundary:

1. Strip ANSI and control characters.
2. Collapse whitespace and trim.
3. Remove empty names.
4. Deduplicate exact sanitized names.
5. Sort with deterministic lexical comparison.

Do not infer activation from tool execution history. The Activity section continues to show currently executing and recently completed tools.

## Rendering

The Tools section renders:

1. `TOOLS`
2. `<active> / <available> active`
3. Two equal-width columns of activated names, filled row-first.

Examples:

- Four tools: rows `[bash, edit]`, `[read, write]`
- Three tools: rows `[bash, edit]`, `[read, ""]`
- Zero tools: count only; no placeholder name row

Use the existing ANSI-aware column padding and final dock truncation. Names use the primary role; count behavior remains unchanged.

## Short-Terminal Behavior

Each name row is an independent optional group. Drop rows from the bottom before dropping the Tools count section. Preserve the existing higher-priority Activity and core sections.

## Constraints

- Keep width `44`, top-right dock, threshold `88`, and non-capturing behavior.
- Add no dependencies, commands, configuration, persistence, telemetry, or Pi core changes.
- Preserve lifecycle generation safety, `NO_COLOR`, privacy, and package behavior.

## Testing

- Snapshot construction sanitizes, deduplicates, and sorts active names.
- Two-column layout handles even, odd, zero, long, and ANSI-tainted names.
- Short height drops names before the active/available count.
- Extension snapshot uses exact `pi.getActiveTools()` names.
- Existing Activity tool history remains separate.
- Run `npm run check`, `npm pack --dry-run`, and `git diff --check`.

## Acceptance Criteria

- The sidebar shows every activated Pi tool name in deterministic two-column rows.
- The active/available count remains visible when name rows are dropped.
- No inactive tool appears in the list.
- Long or hostile names cannot break width or inject terminal control sequences.
- All existing tests and package checks pass.
