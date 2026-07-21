# Pi Atelier Persistent Sidecar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert `/atelier sidebar` from a focused modal into a session-scoped, non-capturing right-edge sidecar with command and menu toggles.

**Architecture:** Keep snapshot construction and width-safe rendering in `src/sidebar.ts`, but replace the awaited modal opener with a controller that owns one overlay lifecycle. `extensions/index.ts` creates and disposes the controller per TUI session, while `src/menu.ts` consumes a narrow visibility/toggle interface for dynamic menu copy.

**Tech Stack:** TypeScript 5.9, Pi extension API 0.80.7, `@earendil-works/pi-tui` 0.80.7, Vitest 4.1, Biome 2.5.

## Global Constraints

- Use only Pi's public extension API; do not modify Pi core.
- The sidecar is a non-capturing overlay, not a true width-reserving split.
- `/atelier sidebar` toggles; `/atelier sidebar on` and `off` are idempotent.
- The main Atelier menu exposes accurate `Sidebar: On/Off` copy.
- Visibility is session-scoped and starts disabled.
- Wide layout uses `anchor: "right-center"`, width `44`, margin `0`, and `nonCapturing: true`.
- The overlay auto-hides below `88` columns and restores when widened.
- Remove modal close instructions and keyboard capture.
- Preserve current snapshot data, live invalidation, error fallback, fixed palette, and `NO_COLOR` behavior.
- Footer enable/disable remains independent from sidecar visibility.
- Do not add dependencies, telemetry, network access, or persistent sidebar state.
- Pi `0.80.7` and Node.js `22.19.0` remain minimum versions.

---

## File Structure

- Modify `src/sidebar.ts` — remove modal behavior and add the session-scoped sidecar controller.
- Modify `tests/sidebar.test.ts` — verify controller lifecycle, non-capturing options, auto-hide, and absence of key capture.
- Modify `src/menu.ts` — add dynamic sidebar control to the root Atelier menu.
- Modify `tests/menu.test.ts` — verify dynamic menu copy and shared toggle behavior.
- Modify `extensions/index.ts` — create/dispose the controller and route toggle/on/off actions.
- Modify `tests/extension.test.ts` — verify command parsing, idempotence, menu integration, footer independence, and shutdown.
- Modify `README.md` — document persistent sidecar controls and replace modal close-key copy.
- Modify `CHANGELOG.md` — record the persistent sidecar redesign under Unreleased.

---

### Task 1: Replace the modal opener with a sidecar controller

**Files:**
- Modify: `src/sidebar.ts`
- Modify: `tests/sidebar.test.ts`

**Interfaces:**
- Retains: `SidebarSnapshot`, `buildSidebarSnapshot`, and `renderSidebarLines`.
- Produces:
  - `SidebarController` with `show()`, `hide()`, `toggle()`, `isVisible()`, `requestRender()`, and `dispose()`.
  - `createSidebarController(options: SidebarControllerOptions): SidebarController`.
  - `sidebarOverlayOptions(): OverlayOptions`.
- Removes: `openAtelierSidebar`, `OpenSidebarOptions`, modal `onClose`, and close-key handling.

- [ ] **Step 1: Rewrite overlay tests to describe the persistent behavior**

Replace modal close-key and opener tests in `tests/sidebar.test.ts` with:

```ts
it("uses an attached non-capturing overlay with responsive visibility", () => {
	const options = sidebarOverlayOptions();
	expect(options).toMatchObject({
		anchor: "right-center",
		width: 44,
		margin: 0,
		nonCapturing: true,
	});
	expect(options.visible?.(87, 40)).toBe(false);
	expect(options.visible?.(88, 40)).toBe(true);
	expect(options.visible?.(160, 40)).toBe(true);
});

it("does not capture editor input or render modal close help", () => {
	const component = createSidebarComponent({
		getSnapshot: snapshot,
		getConfig: () => DEFAULT_CONFIG,
		theme,
	});
	expect(component.handleInput).toBeUndefined();
	expect(component.render(44).join("\n")).not.toContain("esc/q close");
});
```

Add a controller harness whose `ctx.ui.custom` captures `done`, `onHandle`, and the returned component. Assert:

- initial `isVisible()` is false;
- `show()` calls `custom` once and becomes visible;
- repeated `show()` remains one overlay;
- `requestRender()` calls the captured TUI renderer;
- `hide()` invokes the idempotent close path and becomes false;
- repeated `hide()` is harmless;
- `toggle()` can create a fresh second component after hiding;
- `dispose()` closes the current component and remains disabled.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
npm test -- tests/sidebar.test.ts
```

Expected: FAIL because the controller and persistent overlay options do not exist.

- [ ] **Step 3: Remove modal-only rendering and key handling**

In `renderSidebarLines`, remove:

```ts
helpRow("esc/q close", innerWidth, palette),
```

Remove `onClose` from `SidebarComponentOptions` and remove `handleInput` from the returned component. Change the error fallback rows to:

```ts
return frameRows(["PI ATELIER", "Sidebar unavailable", detail], width, {
	paint: (_role, text) => text,
});
```

Remove now-unused `Key` and `matchesKey` imports.

- [ ] **Step 4: Add fixed sidecar overlay options**

Replace `selectSidebarOverlay` with:

```ts
export function sidebarOverlayOptions(): OverlayOptions {
	return {
		anchor: "right-center",
		width: 44,
		maxHeight: "100%",
		margin: 0,
		nonCapturing: true,
		visible: (termWidth) => termWidth >= 88,
	};
}
```

The logical enabled state belongs to the controller; the `visible` callback handles only responsive auto-hide.

- [ ] **Step 5: Implement the controller**

Add these public contracts:

```ts
export interface SidebarController {
	show(): void;
	hide(): void;
	toggle(): void;
	isVisible(): boolean;
	requestRender(): void;
	dispose(): void;
}

export interface SidebarControllerOptions {
	ctx: ExtensionContext;
	getSnapshot(): SidebarSnapshot;
	getConfig(): AtelierConfig;
	colorEnabled?: boolean;
	onError?(error: unknown): void;
}
```

Implement `createSidebarController` with a monotonically increasing generation id so stale promise `finally` callbacks cannot clear a newly opened instance. `show()` must:

1. no-op if already enabled;
2. set logical enabled state;
3. call `void ctx.ui.custom(...)` with `{ overlay: true, overlayOptions: sidebarOverlayOptions(), onHandle }`;
4. capture an idempotent `done(undefined)` close callback, `tui.requestRender`, and the overlay handle;
5. use `.catch(options.onError)` and a generation-checked `.finally(...)` to clear references.

`hide()` must mark disabled, increment the generation, invoke the captured close callback when available, call `handle.hide()` only when no close callback is available, and clear render/handle references. `toggle()` delegates to `show()` or `hide()`. `dispose()` delegates to `hide()`.

If `ctx.mode !== "tui"`, `show()` calls `onError` with an explanatory error and remains disabled.

- [ ] **Step 6: Run focused tests and verify GREEN**

```bash
npm test -- tests/sidebar.test.ts
```

Expected: all sidebar tests pass, including existing snapshot, width, palette, and error tests.

- [ ] **Step 7: Commit Task 1**

```bash
git add src/sidebar.ts tests/sidebar.test.ts
git commit -m "refactor(sidebar): make panel a persistent sidecar"
```

---

### Task 2: Integrate commands, menu toggle, and lifecycle

**Files:**
- Modify: `src/menu.ts`
- Modify: `tests/menu.test.ts`
- Modify: `extensions/index.ts`
- Modify: `tests/extension.test.ts`

**Interfaces:**
- Consumes: `createSidebarController` and `SidebarController` from Task 1.
- Produces: `SidebarControls` in `src/menu.ts` and command actions `sidebar`, `sidebar on`, and `sidebar off`.

- [ ] **Step 1: Add failing menu-control tests**

Export this interface from `src/menu.ts`:

```ts
export interface SidebarControls {
	isVisible(): boolean;
	toggle(): void;
}
```

Before implementing it, update `tests/menu.test.ts` to open the root menu with a fake `SidebarControls` and capture the root `SelectItem[]`. Test both states:

```ts
expect(items).toContainEqual({
	value: "sidebar",
	label: "Sidebar: Off",
	description: "Show the live session sidecar",
});
```

and:

```ts
expect(items).toContainEqual({
	value: "sidebar",
	label: "Sidebar: On",
	description: "Hide the live session sidecar",
});
```

Select `sidebar`, then `close`, and assert `toggle()` was called once.

- [ ] **Step 2: Add failing extension command tests**

Update the extension harness to capture `overlayOptions`, `onHandle`, the custom component, and its `done` callback without awaiting closure.

Add tests proving:

```text
sidebar        off -> on -> off
sidebar on     off -> on; repeated on stays one custom overlay
sidebar off    on -> off; repeated off is harmless
sidebar maybe  warns with: Usage: /atelier sidebar [on|off]
```

Also assert:

- `disable` does not hide an enabled sidecar;
- `enable` does not show a disabled sidecar;
- shutdown closes an enabled sidecar;
- the controller starts disabled after `session_start`;
- menu invocation receives the same controller state used by commands;
- `NO_COLOR` still reaches sidebar rendering.

- [ ] **Step 3: Run focused tests and verify RED**

```bash
npm test -- tests/menu.test.ts tests/extension.test.ts
```

Expected: FAIL because menu controls and controller command routing are not integrated.

- [ ] **Step 4: Add dynamic menu control**

Change `openAtelierMenu` to accept `sidebar: SidebarControls`. Construct the root items on every loop:

```ts
const sidebarVisible = sidebar.isVisible();
const section = await showSelection(ctx, "◆ Pi Atelier", [
	{
		value: "sidebar",
		label: `Sidebar: ${sidebarVisible ? "On" : "Off"}`,
		description: sidebarVisible ? "Hide the live session sidecar" : "Show the live session sidecar",
	},
	{ value: "model", label: "Model", description: "Model and thinking level" },
	// existing rows unchanged
]);
```

Handle it before other sections:

```ts
if (section === "sidebar") {
	sidebar.toggle();
	continue;
}
```

- [ ] **Step 5: Replace modal state in the extension**

In `extensions/index.ts`:

- import `createSidebarController` and `SidebarController`;
- remove `sidebarOpen`, `closeSidebar`, `sidebarRequestRender`, and awaited `openAtelierSidebar` flow;
- add `let sidebar: SidebarController | undefined`;
- make `requestAllRenders()` call `sidebar?.requestRender()`;
- make extension-status changes call `sidebar?.requestRender()`;
- pass `sidebar` into `openAtelierMenu` after checking it exists;
- create the controller after runtime initialization with current snapshot/config getters, `NO_COLOR`, and an `onError` notification;
- dispose the old controller before replacing it on session start/reload;
- dispose it before clearing runtime during session shutdown.

Command parsing must use exact tokens:

```ts
const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
const [action, sidebarAction, ...extra] = parts;
```

For `action === "sidebar"`:

- reject extra tokens or a second token other than `on`/`off` with `Usage: /atelier sidebar [on|off]`;
- ensure TUI and initialized controller;
- no second token -> `sidebar.toggle()`;
- `on` -> `sidebar.show()`;
- `off` -> `sidebar.hide()`;
- return immediately.

Bare `/atelier`, `enable`, and `disable` remain unchanged except that `openMenu` now receives the controller.

- [ ] **Step 6: Run focused tests and verify GREEN**

```bash
npm test -- tests/menu.test.ts tests/extension.test.ts tests/sidebar.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 7: Commit Task 2**

```bash
git add src/menu.ts tests/menu.test.ts extensions/index.ts tests/extension.test.ts
git commit -m "feat(sidebar): add persistent toggle controls"
```

---

### Task 3: Update documentation and verify packaging

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: completed persistent sidecar behavior.
- Produces: accurate user-facing controls and limitations.

- [ ] **Step 1: Replace README sidebar copy**

Document all commands:

````md
```text
/atelier sidebar
/atelier sidebar on
/atelier sidebar off
```
````

State that the sidecar stays visible without taking editor focus, is attached to the right edge, auto-hides below 88 columns, starts disabled each session, and can also be toggled through the Atelier menu. Remove claims that `Esc`, `q`, or `Ctrl+C` close it.

- [ ] **Step 2: Update Unreleased changelog**

Replace or supplement the existing sidebar entry with:

```md
- Convert `/atelier sidebar` into a session-scoped, non-capturing right-edge sidecar with command and menu on/off controls.
```

- [ ] **Step 3: Run formatting and full verification**

Delegation scratch can confuse Biome. Remove `.pi-subagents`, immediately recreate `.pi-subagents/artifacts`, then run:

```bash
npm run format
npm run check
npm pack --dry-run
git diff --check
```

Expected: formatting succeeds, all tests pass, package verification includes `src/sidebar.ts`, dry-run packaging succeeds, and no whitespace errors are reported.

- [ ] **Step 4: Commit documentation**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: describe persistent Atelier sidecar"
```

- [ ] **Step 5: Verify the committed branch**

```bash
npm run check
git status --short --branch
```

Expected: all checks pass and the feature worktree is clean.
