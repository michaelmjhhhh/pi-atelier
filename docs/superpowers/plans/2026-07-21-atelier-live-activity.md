# Pi Atelier Live Sidebar Activity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add live turn, elapsed-time, parallel-tool, recent-tool, and tool-result information to the sidebar without duplicating it in the footer.

**Architecture:** Introduce a pure `RunActivityTracker` domain module that converts Pi lifecycle events into immutable snapshots. Feed that snapshot into the existing sidebar renderer, and let the sidebar controller own a visibility-bounded one-second render timer while activity is running.

**Tech Stack:** TypeScript 5.9, Pi extension API 0.80.7, `@earendil-works/pi-tui` 0.80.7, Vitest 4.1, Biome 2.5.

## Global Constraints

- Use only Pi's public extension API and lifecycle events.
- Display no prompt text, reasoning, provider payloads, tool output, result content, or arbitrary custom-tool arguments.
- Persist no activity history.
- Keep exactly three recent completed tools, newest first.
- Support parallel active tools keyed by `toolCallId`.
- Keep width `44`, auto-hide threshold `88`, top-right anchoring, exact-height rendering, and non-capturing behavior.
- Preserve footer rendering, existing controls, generation safety, privacy, `NO_COLOR`, and package behavior.
- Add no dependencies, telemetry, network calls, or Pi core changes.

---

### Task 1: Build the run activity tracker

**Files:**
- Create: `src/run-activity.ts`
- Create: `tests/run-activity.test.ts`

**Interfaces:**
- Consumes: Pi `ToolExecutionStartEvent` and `ToolExecutionEndEvent`.
- Produces: `ToolActivity`, `RunActivitySnapshot`, `RunActivityTracker`, `EMPTY_RUN_ACTIVITY`, `createRunActivityTracker(...)`, `formatDuration(...)`, and `summarizeTool(...)`.

- [ ] **Step 1: Write failing transition tests**

Create `tests/run-activity.test.ts` with deterministic timestamps:

```ts
const tracker = createRunActivityTracker({ cwd: "/repo", onChange });
tracker.startRun(1_000);
tracker.startTurn(2);
tracker.startTool({
	type: "tool_execution_start",
	toolCallId: "read-1",
	toolName: "read",
	args: { path: "/repo/src/state.ts" },
}, 2_000);

expect(tracker.getSnapshot()).toMatchObject({
	phase: "running",
	turnNumber: 3,
	startedAt: 1_000,
	activeTools: [{ id: "read-1", name: "read", summary: "src/state.ts", startedAt: 2_000 }],
});
```

Add tests for parallel insertion order, done/failed completion, duration, newest-first history, three-entry cap, unknown completion IDs, settle with active tools, reset, run reset, and snapshot array isolation.

- [ ] **Step 2: Write failing summary and duration tests**

Cover:

```ts
expect(formatDuration(0)).toBe("<1s");
expect(formatDuration(12_400)).toBe("12s");
expect(formatDuration(68_000)).toBe("1m 08s");
expect(summarizeTool("bash", { command: "npm test\nrm -rf nope" }, "/repo")).toBe("npm test rm -rf nope");
expect(summarizeTool("read", { path: "/repo/src/state.ts" }, "/repo")).toBe("src/state.ts");
expect(summarizeTool("custom", { secret: "must-not-render" }, "/repo")).toBe("");
```

Also cover ANSI/control stripping, home shortening, `grep`, `find`, `ls`, non-object args, non-finite times, and 26-column summary truncation.

- [ ] **Step 3: Run focused tests and verify RED**

```bash
npm test -- tests/run-activity.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 4: Implement immutable activity types and helpers**

Create `src/run-activity.ts` with:

```ts
export type ToolActivityStatus = "running" | "done" | "failed";

export interface ToolActivity {
	id: string;
	name: string;
	summary: string;
	status: ToolActivityStatus;
	startedAt: number;
	durationMs?: number;
}

export interface RunActivitySnapshot {
	phase: "idle" | "running" | "settled";
	turnNumber?: number;
	startedAt?: number;
	durationMs?: number;
	activeTools: readonly ToolActivity[];
	recentTools: readonly ToolActivity[];
	completedCount: number;
	failedCount: number;
}

export const EMPTY_RUN_ACTIVITY: RunActivitySnapshot = Object.freeze({
	phase: "idle",
	activeTools: Object.freeze([]),
	recentTools: Object.freeze([]),
	completedCount: 0,
	failedCount: 0,
});
```

Normalize timestamps with a private finite non-negative helper. Sanitize stored names and summaries. `getSnapshot()` returns new frozen arrays and cloned tool records.

- [ ] **Step 5: Implement tracker transitions**

Use a `Map<string, ToolActivity>` for active tools and an array for recent results. `finishTool` must remove before notifying, compute `Math.max(0, end - start)`, increment one counter, and `unshift`/slice to three. `settle` fails remaining active tools using the settle timestamp, then captures total run duration. Call `onChange` once per public transition that changes state.

- [ ] **Step 6: Run focused tests and commit**

```bash
npm test -- tests/run-activity.test.ts
npm run typecheck
git add src/run-activity.ts tests/run-activity.test.ts
git commit -m "feat(sidebar): track live agent tool activity"
```

Expected: tracker tests and typecheck pass.

---

### Task 2: Render activity and manage live sidebar ticks

**Files:**
- Modify: `src/sidebar.ts`
- Modify: `tests/sidebar.test.ts`

**Interfaces:**
- Consumes: `RunActivitySnapshot` and `formatDuration` from `src/run-activity.ts`.
- Produces: `SidebarSnapshot.runActivity`, deterministic `renderSidebarLines(..., now?)`, and timer-aware `SidebarControllerOptions`.

- [ ] **Step 1: Add failing activity rendering tests**

Update sidebar fixtures with `runActivity: EMPTY_RUN_ACTIVITY`. Add deterministic tests using `now = 20_000`:

```ts
const rows = contentRows(renderSidebarLines(activeSnapshot, config, theme, 44, 36, false, 20_000));
expect(rows).toContain("ACTIVITY");
expect(rows).toContain("Turn 3 · running 19s");
expect(rows).toContain(expect.stringMatching(/^read\s+src\/state\.ts\s+18s$/));
expect(rows).toContain(expect.stringMatching(/^bash\s+npm test\s+done 4s$/));
expect(rows).toContain("tools 2 done · 1 failed");
```

Add settled, idle omission, active-before-recent, parallel start order, long-summary width, success/error/working palette-role, and recent cap tests.

- [ ] **Step 2: Add failing priority tests**

Construct a snapshot with two active tools, three recent tools, aggregate counts, statuses, and all static sections. Assert height reduction drops in this order: extension statuses; older recent rows; aggregate row; newest recent row; Tools; Usage; Session. Active tools remain before optional static sections.

- [ ] **Step 3: Add failing controller timer tests**

Use fake timers and inject `animationIntervalMs: 10`:

```ts
const controller = createSidebarController({
	...options,
	shouldAnimate: () => running,
	animationIntervalMs: 10,
});
controller.show();
await flushOverlay();
vi.advanceTimersByTime(30);
expect(requestRender).toHaveBeenCalledTimes(3);
```

Cover no timer while off, exactly one timer after repeated show/requestRender, and immediate stop on settle plus `requestRender`, hide, overlay closure, dispose, and stale generation.

- [ ] **Step 4: Run focused tests and verify RED**

```bash
npm test -- tests/sidebar.test.ts
```

Expected: FAIL because activity rendering and controller animation options do not exist.

- [ ] **Step 5: Extend the sidebar snapshot and renderer**

Add `runActivity` to `SidebarSnapshotInput` and `SidebarSnapshot`. Add optional `now = Date.now()` after `colorEnabled` in `renderSidebarLines`.

Implement `activityRows()` as structured groups:

```ts
interface ActivityGroups {
	core: string[];
	recent: Array<{ id: string; row: string }>;
	aggregate: string[];
}
```

The core contains heading, run/turn summary, and every active tool. Use an ANSI-width-aware three-column row composer for tool name, summary, and status/duration. Active rows sort by `startedAt`; recent rows deduplicate active IDs and remain newest first.

- [ ] **Step 6: Replace positional dropping with ranked ordered groups**

Change `SidebarGroup` to:

```ts
interface SidebarGroup {
	name: string;
	rows: string[];
	required: boolean;
	dropRank: number;
}
```

`composeGroups()` repeatedly removes the lowest-rank optional group while preserving the original display order. Assign ranks exactly as the design specifies: status details `0`; recent oldest and middle `10/11`; aggregate `20`; newest recent `30`; Tools `40`; Usage `50`; Session `60`. Project, Agent, non-idle Activity core, and Context are required.

- [ ] **Step 7: Implement controller animation lifecycle**

Extend `SidebarControllerOptions`:

```ts
shouldAnimate?(): boolean;
animationIntervalMs?: number;
```

Maintain one interval. `syncAnimation()` starts only when `enabled && shouldAnimate?.()` and stops otherwise. Call it from `show`, `requestRender`, overlay resolution/closure, `hide`, and `dispose`. Each tick calls only the current `requestOverlayRender`; default to `1_000` ms and call `.unref?.()` when supported.

- [ ] **Step 8: Run focused and full tests, then commit**

```bash
npm test -- tests/sidebar.test.ts tests/run-activity.test.ts
npm run check
git add src/sidebar.ts tests/sidebar.test.ts
git commit -m "feat(sidebar): show live run activity"
```

Expected: focused tests and all repository checks pass.

---

### Task 3: Wire Pi events and document unique sidebar value

**Files:**
- Modify: `extensions/index.ts`
- Modify: `tests/extension.test.ts`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: `createRunActivityTracker(...)`, tracker event methods, and `SidebarControllerOptions.shouldAnimate`.
- Produces: generation-safe event forwarding and user-facing documentation.

- [ ] **Step 1: Add failing extension event tests**

Extend the fake Pi harness to capture `turn_start`, `tool_execution_start`, and `tool_execution_end` handlers. Assert:

- `agent_start` resets activity and marks Agent working.
- `turn_start` uses one-based turn display.
- start/end tool events update the sidebar snapshot and request render.
- `agent_settled` freezes duration, marks Agent ready, and stops animation.
- session reload/shutdown clears tracker state and cannot let old transitions update the new sidebar.
- footer output never contains tool names/history.

- [ ] **Step 2: Run extension tests and verify RED**

```bash
npm test -- tests/extension.test.ts
```

Expected: FAIL because event handlers are not registered and snapshots lack activity.

- [ ] **Step 3: Create one tracker per session generation**

In `extensions/index.ts`, hold `let runActivity: RunActivityTracker | undefined`. During `session_start`, create a local tracker with `cwd` and a generation-safe `onChange` that calls `requestAllRenders()` only when it remains current. Assign it atomically with the runtime/sidebar after initialization succeeds; reset the previous tracker when replacing sessions.

Pass `runActivity.getSnapshot()` to `buildSidebarSnapshot`. Supply `shouldAnimate: () => runActivity?.isRunning() ?? false` to the sidebar controller.

- [ ] **Step 4: Register event forwarding**

Register:

```ts
pi.on("agent_start", () => {
	runActivity?.startRun();
	runtime?.setActivity("working");
});
pi.on("turn_start", (event) => runActivity?.startTurn(event.turnIndex));
pi.on("tool_execution_start", (event) => runActivity?.startTool(event));
pi.on("tool_execution_end", (event) => runActivity?.finishTool(event));
pi.on("agent_settled", () => {
	runActivity?.settle();
	runtime?.setActivity("ready");
	sidebar?.requestRender();
});
```

Reset and clear activity on startup failure, replacement, and shutdown. Keep existing usage/Git refresh behavior.

- [ ] **Step 5: Update README and changelog**

Document that the sidebar uniquely shows current turn, elapsed run time, active parallel tools, three recent results, durations, and failure totals while the footer remains compact. Add an Unreleased changelog bullet.

- [ ] **Step 6: Run complete verification**

Before Biome, remove `.pi-subagents` and immediately recreate `.pi-subagents/artifacts`, then run:

```bash
npm run format
npm run check
npm pack --dry-run
git diff --check
```

Expected: all tests pass; package verification includes `src/run-activity.ts`; no whitespace errors.

- [ ] **Step 7: Commit and verify clean state**

```bash
git add extensions/index.ts tests/extension.test.ts README.md CHANGELOG.md
git commit -m "feat(sidebar): wire live Pi activity events"
npm run check
git status --short --branch
```

Expected: final checks pass and the feature worktree is clean.
