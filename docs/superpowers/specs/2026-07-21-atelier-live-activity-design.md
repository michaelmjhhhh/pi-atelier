# Pi Atelier Live Activity Sidebar Design

## Summary

Make the sidebar uniquely useful by adding live agent-run and tool-execution information that cannot fit reliably in the one-line footer. Keep the existing Agent status, then add an Activity section showing the current turn, live elapsed time, all currently executing tools, the three most recent completed tools, and aggregate success/failure counts.

The feature uses Pi's public lifecycle events and remains local, ephemeral, non-capturing, and privacy-conscious.

## Goals

- Show what the agent is doing now, not only static model and usage metadata.
- Display current turn and run elapsed time.
- Support concurrent tool execution.
- Retain the three most recent completed tool results for immediate context.
- Show run-level completed and failed tool counts.
- Continue showing the current agent status in the Agent section.
- Update time while work is active without leaving background timers after hide, settle, reload, or shutdown.

## Non-goals

- Displaying prompt text, tool output, provider payloads, or model reasoning.
- Persisting run activity into session entries or configuration.
- Adding navigation, tool cancellation, logs, telemetry, dependencies, or Pi core changes.
- Replacing existing Project, Agent, Context, Session, Usage, or Tools information.

## Visual Structure

```text
│ AGENT
│ gpt-5.6-sol
│ openai-codex · medium
│ Working · implementing
│
│ ACTIVITY
│ Turn 3 · running 18s
│ read  src/state.ts                    2s
│ bash  npm test                   done 4s
│ edit  src/sidebar.ts             done 1s
│ tools 3 done · 0 failed
│
```

When settled:

```text
│ ACTIVITY
│ Last run · 24s
│ bash  npm test                   done 4s
│ edit  src/sidebar.ts             done 1s
│ read  src/types.ts               done 1s
│ tools 3 done · 0 failed
```

Errors use the semantic error role and the word `failed`; success uses the ready role and `done`. Running tools use the working role and show a live duration without an extra status word.

## Activity Domain Model

Create `src/run-activity.ts` as the single owner of event-to-state transitions.

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

export interface RunActivityTracker {
	startRun(now?: number): void;
	startTurn(turnIndex: number): void;
	startTool(event: ToolExecutionStartEvent, now?: number): void;
	finishTool(event: ToolExecutionEndEvent, now?: number): void;
	settle(now?: number): void;
	reset(): void;
	isRunning(): boolean;
	getSnapshot(): RunActivitySnapshot;
}
```

`turnIndex` is converted to a one-based display number with `Math.max(0, Math.trunc(turnIndex)) + 1`.

Tracker invariants:

- `startRun` resets turn, tools, counts, and timestamps.
- Active tools are keyed by `toolCallId`, so parallel execution is safe.
- `finishTool` ignores unknown IDs rather than inventing history.
- Completion removes the tool from active state, records duration, increments exactly one aggregate count, and prepends the result to recent history.
- Recent history is capped at three entries.
- `settle` captures run duration and safely finalizes any still-active tools as failed before clearing the active set.
- `reset` restores the idle empty state.
- No tracker state is persisted.

## Safe Tool Summaries

`src/run-activity.ts` derives one sanitized, single-line summary at tool start. It strips ANSI/control characters, collapses whitespace, and truncates by visible width before storage.

Rules:

- `read`, `edit`, `write`: home-shortened or project-relative `path` when available.
- `bash`: command text, capped at 26 visible columns.
- `grep`: `pattern`, followed by `in <path>` when present and space permits.
- `find`: `pattern`, followed by `in <path>` when present.
- `ls`: target `path`.
- custom tools: the tool name only; do not inspect arbitrary argument values.

The renderer still applies its own final width truncation. Tool output, result content, prompt text, and unknown custom arguments are never stored or displayed.

## Extension Event Flow

Create one tracker per live session during `session_start`. Register existing global Pi handlers to forward events only to the current tracker/runtime generation:

- `agent_start` → `tracker.startRun()` and `runtime.setActivity("working")`
- `turn_start` → `tracker.startTurn(event.turnIndex)`
- `tool_execution_start` → `tracker.startTool(event)`
- `tool_execution_end` → `tracker.finishTool(event)`
- `agent_settled` → `tracker.settle()` and `runtime.setActivity("ready")`
- `session_shutdown` → `tracker.reset()` and release the reference

Every transition requests footer/sidebar rendering through the existing generation-safe callback. Stale session instances cannot update the active UI.

`getSidebarSnapshot()` adds the tracker's immutable activity snapshot. The footer state remains unchanged and does not render tool history.

## Sidebar Snapshot and Rendering

Extend `SidebarSnapshot`:

```ts
runActivity: RunActivitySnapshot;
```

Add `activityRows(snapshot, contentWidth, now, palette)`. `renderSidebarLines` gains an optional final `now = Date.now()` argument so tests remain deterministic.

Rendering order:

1. Project
2. Agent
3. Activity
4. Context
5. Session
6. Usage
7. Tools

Activity section rules:

- Omit the entire section only when phase is `idle` and there is no history.
- Render active tools before recent completed tools.
- Deduplicate by tool-call ID if defensive input contains overlap.
- Use stable order for active parallel tools: earliest `startedAt` first.
- Recent results render newest first, capped at three.
- Durations use compact formatting: `<1s`, `12s`, `1m 08s`, with negative/non-finite values clamped to zero.
- The summary line is `Turn N · running <duration>` while active and `Last run · <duration>` after settle.
- Aggregate row is `tools N done · M failed` and is omitted before any completion.

## Live Timer Lifecycle

Extend `SidebarControllerOptions` with:

```ts
shouldAnimate?(): boolean;
animationIntervalMs?: number;
```

The controller owns at most one interval:

- Start it only when the overlay is logically visible and `shouldAnimate()` is true.
- Each tick calls the current overlay render request.
- `requestRender()` resynchronizes the timer after activity transitions.
- Stop it immediately on hide, settle, disposal, overlay closure, stale generation, or session shutdown.
- Default interval is `1_000` ms.
- Do not animate when the terminal-width visibility predicate hides the overlay; Pi does not expose visibility-predicate transitions to the controller, so logical sidebar visibility is the enforceable boundary. Width-hidden renders remain harmless, and no additional timers are created.

The extension supplies `shouldAnimate: () => tracker.isRunning()`.

## Short-Terminal Priorities

Project, Agent, active Activity summary/tools, and Context are highest priority.

When height is constrained, drop in this order:

1. Extension status details
2. Recent completed tool rows beyond the newest
3. Aggregate activity counts
4. Remaining recent completed rows
5. Tools availability section
6. Usage section
7. Session section

Never drop active tool rows before optional static sections. If even required content exceeds height, the final dock compositor truncates at terminal height while preserving top-to-bottom order.

## Error Handling

- Malformed times and turn indexes are normalized.
- Unknown or duplicate tool completions are ignored.
- Summary extraction never throws on unusual argument values.
- Tracker event handling must not block or alter Pi tool execution.
- Existing docked `Sidebar unavailable` fallback remains the renderer boundary.

## Testing

### Tracker tests

Create `tests/run-activity.test.ts` covering:

- run reset and one-based turn conversion
- parallel active tools
- completion duration and newest-first recent history
- three-entry cap
- done/failed counts
- unknown completion IDs
- settle behavior with active tools
- safe summary extraction for built-in and custom tools
- ANSI/control stripping and truncation
- reset and immutable snapshot behavior

### Sidebar tests

Cover:

- running and settled Activity layouts with deterministic `now`
- active-before-recent ordering
- parallel active tool order
- semantic success/error/working roles
- compact duration formatting
- omission when idle
- short-height priority dropping
- exact height and width with long summaries

### Extension/controller tests

Cover:

- Pi event forwarding
- generation safety across overlapping session starts
- one timer while visible/running
- timer stops on settle, hide, close, dispose, reload, and shutdown
- no timer while sidebar is off
- existing command, footer, `NO_COLOR`, privacy, and package behavior

Run `npm run check`, `npm pack --dry-run`, and `git diff --check` before integration.

## Acceptance Criteria

- The sidebar shows current run/turn state and all active tools with live elapsed time.
- It retains exactly the three most recent completed tools with duration and done/failed state.
- Parallel tool execution and aggregate counts are correct.
- Agent status remains visible and consistent with the activity section.
- The footer does not duplicate tool history.
- No prompt, reasoning, tool output, or arbitrary custom-tool arguments are displayed or persisted.
- Timers are bounded to sidebar-visible active work and cleaned up across every lifecycle path.
- Short terminals prioritize active work over optional static information.
- All existing sidebar, footer, lifecycle, privacy, `NO_COLOR`, and package tests remain green.
