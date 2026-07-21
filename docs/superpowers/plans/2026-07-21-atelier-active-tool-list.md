# Pi Atelier Activated Tool List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show exact activated Pi tool names as a deterministic two-column list beneath the sidebar Tools count.

**Architecture:** Carry active names through the existing sidebar snapshot boundary, normalize them there, and render each two-column row as an independently droppable optional group. Keep Pi's active-tool API authoritative and Activity history separate.

**Tech Stack:** TypeScript 5.9, Pi extension API 0.80.7, Pi TUI width helpers, Vitest 4.1, Biome 2.5.

## Global Constraints

- Preserve width `44`, threshold `88`, top-right anchoring, exact-height rendering, and non-capturing behavior.
- Add no dependencies, configuration, persistence, telemetry, or commands.
- Preserve live Activity, lifecycle generation safety, privacy, and `NO_COLOR`.

---

### Task 1: Render exact activated tool names

**Files:**
- Modify: `src/sidebar.ts`
- Modify: `extensions/index.ts`
- Modify: `tests/sidebar.test.ts`
- Modify: `tests/extension.test.ts`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Adds: `SidebarSnapshotInput.activeToolNames` and `SidebarSnapshot.activeToolNames`.
- Consumes: exact names returned by `pi.getActiveTools()`.

- [ ] **Step 1: Write failing snapshot and renderer tests**

Assert sanitization, empty removal, deduplication, lexical sorting, and two-column rows:

```ts
expect(snapshot.activeToolNames).toEqual(["bash", "edit", "read"]);
expect(rows).toContain("bash                 edit");
expect(rows).toContain("read");
```

Cover zero, odd, even, long, and ANSI-tainted names. Add a constrained-height test proving name rows disappear before `4 / 7 active`.

- [ ] **Step 2: Write failing extension integration test**

Set `getActiveTools()` to `['write', 'read', 'bash', 'edit']`, render the sidebar, and assert all four names appear in sorted two-column rows while inactive names from `getAllTools()` do not.

- [ ] **Step 3: Run focused tests and verify RED**

```bash
npm test -- tests/sidebar.test.ts tests/extension.test.ts
```

Expected: FAIL because snapshots carry only an active count.

- [ ] **Step 4: Add normalized snapshot data**

Sanitize names with the existing sidebar sanitizer, remove empty entries, deduplicate with `Set`, and sort using `(a, b) => a.localeCompare(b, "en")`. Copy into a new array so callers cannot mutate the snapshot.

- [ ] **Step 5: Render independent two-column groups**

Pair names row-first using the existing two-column width helper. Keep `TOOLS` plus count in `toolsStatus`; append each name row directly after it in display order. Assign increasing drop ranks so the bottom name row drops first, then earlier rows, all before the Tools count group.

- [ ] **Step 6: Wire exact Pi names**

In `getSidebarSnapshot()`, read `const activeTools = pi.getActiveTools()` once and pass both `activeToolCount: activeTools.length` and `activeToolNames: activeTools`.

- [ ] **Step 7: Update docs and verify**

Document exact activated names in README and changelog, then run:

```bash
npm run format
npm run check
npm pack --dry-run
git diff --check
```

Expected: all tests and packaging pass.

- [ ] **Step 8: Commit**

```bash
git add src/sidebar.ts extensions/index.ts tests/sidebar.test.ts tests/extension.test.ts README.md CHANGELOG.md
git commit -m "feat(sidebar): list activated tools"
```
