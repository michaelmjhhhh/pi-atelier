# Pi Atelier Resizable Split Sidebar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Atelier sidebar visually non-overlapping and session-resizable without modifying Pi source code, using a width-reserving TUI render wrapper and a temporary `Ctrl+Shift+R` mouse/keyboard Resize mode.

**Architecture:** Add a focused `src/split-pane.ts` controller that owns width reservation, safe `TUI.render` wrapping, responsive bounds, temporary SGR mouse handling, and cleanup. Compose that controller into the existing sidebar overlay so Pi renders its base workspace at the reduced width while the overlay remains anchored to the real right edge. Keep sidebar data/rendering in `src/sidebar.ts` and lifecycle/shortcut routing in `extensions/index.ts`.

**Tech Stack:** TypeScript 5.9, `@earendil-works/pi-coding-agent` 0.80.7+, `@earendil-works/pi-tui` 0.80.7+, Vitest 4, Biome, Node.js 22.19+.

## Global Constraints

- Modify only Pi Atelier files; do not patch or fork Pi or `@earendil-works/pi-tui`.
- Add no runtime dependency.
- Default sidebar width is exactly 44 columns, including the divider.
- Sidebar width is clamped to 28–72 columns.
- Main-pane width is never less than 64 columns.
- Below 92 terminal columns, reserve no sidebar width and hide the visual overlay while preserving logical sidebar enablement.
- Sidebar width is session-scoped and resets to 44 for every replacement session.
- Mouse reporting is enabled only during Resize mode and must never leak past exit, hide, disable, reload, replacement, error, or shutdown.
- `Ctrl+Shift+R` enters Resize mode; mouse release and Enter accept, while Escape restores the entry width.
- Normal terminal text selection must be unaffected outside Resize mode.
- Preserve existing `NO_COLOR`, activity animation, lifecycle-generation, snapshot, menu, footer, and package behavior unless this plan explicitly changes it.
- Document that wrapping `TUI.render` is a Pi-version-sensitive runtime integration.

## File Structure

- Create `src/split-pane.ts` — generic width reservation, render wrapping, responsive sizing, SGR mouse parsing, Resize mode, and terminal/input cleanup. It must not import Atelier runtime, metrics, Git, tool, snapshot, or palette modules.
- Create `tests/split-pane.test.ts` — isolated controller, parser, width, renderer identity, input, and cleanup tests using fake TUI/terminal objects.
- Modify `src/sidebar.ts` — compose the split controller with the existing overlay, make overlay width dynamic, display Resize state, and expose Resize control.
- Modify `tests/sidebar.test.ts` — update overlay harnesses for dynamic options and verify sidebar/split composition and Resize presentation.
- Modify `extensions/index.ts` — register `Ctrl+Shift+R`, route it only to the active session controller, and make `/atelier disable` close the full sidebar presentation.
- Modify `tests/extension.test.ts` — add TUI render/input/terminal fakes and verify shortcut, width reservation, disable, replacement, and shutdown behavior.
- Modify `README.md` — document non-overlap, bounds, Resize mode, keyboard controls, temporary mouse behavior, and compatibility limitation.
- Modify `CHANGELOG.md` — add the feature under Unreleased.

---

### Task 1: Add responsive width reservation and safe TUI render wrapping

**Files:**
- Create: `src/split-pane.ts`
- Create: `tests/split-pane.test.ts`

**Interfaces:**
- Consumes: `TUI`, `OverlayOptions`, and `Component` contracts from `@earendil-works/pi-tui`.
- Produces:

```ts
export const DEFAULT_SIDEBAR_WIDTH = 44;
export const MIN_SIDEBAR_WIDTH = 28;
export const MAX_SIDEBAR_WIDTH = 72;
export const MIN_MAIN_WIDTH = 64;

export interface SplitPaneControllerOptions {
  defaultSidebarWidth?: number;
  minSidebarWidth?: number;
  maxSidebarWidth?: number;
  minMainWidth?: number;
  onError?(error: unknown): void;
}

export interface SplitPaneController {
  attach(tui: TUI): void;
  show(): void;
  hide(): void;
  setSidebarWidth(width: number): void;
  getSidebarWidth(): number;
  isEnabled(): boolean;
  isVisibleAtWidth(terminalWidth: number): boolean;
  overlayOptions(): OverlayOptions;
  requestRender(): void;
  dispose(): void;
}

export function createSplitPaneController(options?: SplitPaneControllerOptions): SplitPaneController;
```

- Later tasks extend these same interfaces with Resize-mode methods and options; do not rename the Task 1 methods.

- [ ] **Step 1: Write failing controller tests**

Create `tests/split-pane.test.ts` with a reusable fake TUI that records widths passed to the base renderer:

```ts
import type { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_MAIN_WIDTH,
  MIN_SIDEBAR_WIDTH,
  createSplitPaneController,
} from "../src/split-pane.js";

function harness(columns = 120) {
  const baseRender = vi.fn((width: number) => [`base:${width}`]);
  const requestRender = vi.fn();
  const write = vi.fn();
  const tui = {
    render: baseRender,
    requestRender,
    terminal: { columns, rows: 36, write },
  } as unknown as TUI;
  return { tui, baseRender, requestRender, write };
}

describe("split pane width reservation", () => {
  it("reserves the default sidebar width without changing overlay coordinates", () => {
    const h = harness(120);
    const split = createSplitPaneController();
    split.attach(h.tui);
    split.show();

    expect(h.tui.render(120)).toEqual(["base:76"]);
    expect(h.baseRender).toHaveBeenLastCalledWith(120 - DEFAULT_SIDEBAR_WIDTH);
    expect(split.overlayOptions()).toMatchObject({
      anchor: "top-right",
      width: 44,
      maxHeight: "100%",
      margin: 0,
      nonCapturing: true,
    });
  });

  it("uses full width when hidden or too narrow and restores on widen", () => {
    const h = harness(120);
    const split = createSplitPaneController();
    split.attach(h.tui);
    split.show();

    expect(h.tui.render(MIN_MAIN_WIDTH + MIN_SIDEBAR_WIDTH - 1)).toEqual(["base:91"]);
    expect(split.isVisibleAtWidth(91)).toBe(false);
    expect(h.tui.render(120)).toEqual(["base:76"]);

    split.hide();
    expect(h.tui.render(120)).toEqual(["base:120"]);
  });

  it("clamps configured and runtime widths while preserving the main pane", () => {
    const h = harness(100);
    const split = createSplitPaneController();
    split.attach(h.tui);
    split.show();

    split.setSidebarWidth(999);
    expect(split.getSidebarWidth()).toBe(MAX_SIDEBAR_WIDTH);
    expect(h.tui.render(100)).toEqual([`base:${MIN_MAIN_WIDTH}`]);
    expect(split.overlayOptions()).toMatchObject({ width: 36 });

    split.setSidebarWidth(Number.NaN);
    expect(split.getSidebarWidth()).toBe(MAX_SIDEBAR_WIDTH);

    split.setSidebarWidth(-10);
    expect(split.getSidebarWidth()).toBe(MIN_SIDEBAR_WIDTH);
    expect(h.tui.render(100)).toEqual(["base:72"]);
  });
});
```

Append renderer identity and lifecycle tests:

```ts
describe("split pane render lifecycle", () => {
  it("attaches once and restores the exact original method on dispose", () => {
    const h = harness();
    const original = h.tui.render;
    const split = createSplitPaneController();

    split.attach(h.tui);
    const wrapped = h.tui.render;
    split.attach(h.tui);
    expect(h.tui.render).toBe(wrapped);

    split.dispose();
    expect(h.tui.render).toBe(original);
    split.dispose();
    expect(h.tui.render).toBe(original);
  });

  it("does not overwrite a renderer installed later by another extension", () => {
    const h = harness();
    const split = createSplitPaneController();
    split.attach(h.tui);
    const atelierWrapper = h.tui.render;
    const laterWrapper = vi.fn((width: number) => atelierWrapper.call(h.tui, width));
    h.tui.render = laterWrapper;

    split.dispose();

    expect(h.tui.render).toBe(laterWrapper);
    expect(h.tui.render(120)).toEqual(["base:120"]);
  });

  it("keeps show, hide, width updates, and requests idempotent", () => {
    const h = harness();
    const split = createSplitPaneController();
    split.attach(h.tui);
    split.show();
    split.show();
    split.setSidebarWidth(44);
    split.requestRender();
    split.hide();
    split.hide();

    expect(split.isEnabled()).toBe(false);
    expect(h.tui.render(120)).toEqual(["base:120"]);
    expect(h.requestRender.mock.calls.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run the new tests and verify the module is missing**

Run:

```bash
npm test -- tests/split-pane.test.ts
```

Expected: FAIL because `../src/split-pane.js` does not exist.

- [ ] **Step 3: Implement the minimal width and render controller**

Create `src/split-pane.ts`. Use the current function object rather than a bound replacement so cleanup can restore exact identity:

```ts
import type { OverlayOptions, TUI } from "@earendil-works/pi-tui";

export const DEFAULT_SIDEBAR_WIDTH = 44;
export const MIN_SIDEBAR_WIDTH = 28;
export const MAX_SIDEBAR_WIDTH = 72;
export const MIN_MAIN_WIDTH = 64;

type RenderFunction = TUI["render"];

export interface SplitPaneControllerOptions {
  defaultSidebarWidth?: number;
  minSidebarWidth?: number;
  maxSidebarWidth?: number;
  minMainWidth?: number;
  onError?(error: unknown): void;
}

export interface SplitPaneController {
  attach(tui: TUI): void;
  show(): void;
  hide(): void;
  setSidebarWidth(width: number): void;
  getSidebarWidth(): number;
  isEnabled(): boolean;
  isVisibleAtWidth(terminalWidth: number): boolean;
  overlayOptions(): OverlayOptions;
  requestRender(): void;
  dispose(): void;
}

const finiteInteger = (value: number, fallback: number): number =>
  Number.isFinite(value) ? Math.trunc(value) : fallback;

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

export function createSplitPaneController(
  options: SplitPaneControllerOptions = {},
): SplitPaneController {
  const minimumSidebar = Math.max(1, finiteInteger(options.minSidebarWidth ?? MIN_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH));
  const maximumSidebar = Math.max(
    minimumSidebar,
    finiteInteger(options.maxSidebarWidth ?? MAX_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH),
  );
  const minimumMain = Math.max(1, finiteInteger(options.minMainWidth ?? MIN_MAIN_WIDTH, MIN_MAIN_WIDTH));
  let sidebarWidth = clamp(
    finiteInteger(options.defaultSidebarWidth ?? DEFAULT_SIDEBAR_WIDTH, DEFAULT_SIDEBAR_WIDTH),
    minimumSidebar,
    maximumSidebar,
  );
  let tui: TUI | undefined;
  let originalRender: RenderFunction | undefined;
  let wrappedRender: RenderFunction | undefined;
  let enabled = false;
  let disposed = false;

  const visibleAt = (terminalWidth: number): boolean =>
    enabled && Number.isFinite(terminalWidth) && terminalWidth >= minimumMain + minimumSidebar;

  const effectiveSidebarWidth = (terminalWidth: number): number => {
    if (!visibleAt(terminalWidth)) return 0;
    return clamp(sidebarWidth, minimumSidebar, Math.min(maximumSidebar, terminalWidth - minimumMain));
  };

  const requestRender = () => tui?.requestRender();

  const attach = (nextTui: TUI) => {
    if (disposed) throw new Error("Cannot attach a disposed split pane");
    if (tui === nextTui) return;
    if (tui) throw new Error("Split pane is already attached to another TUI");
    tui = nextTui;
    originalRender = nextTui.render;
    const previousRender = nextTui.render;
    wrappedRender = function (this: TUI, terminalWidth: number): string[] {
      const reserved = effectiveSidebarWidth(terminalWidth);
      try {
        return previousRender.call(nextTui, Math.max(1, terminalWidth - reserved));
      } catch (error) {
        enabled = false;
        options.onError?.(error);
        return previousRender.call(nextTui, terminalWidth);
      }
    };
    nextTui.render = wrappedRender;
    requestRender();
  };

  return {
    attach,
    show() {
      if (disposed || enabled) return;
      enabled = true;
      requestRender();
    },
    hide() {
      if (!enabled) return;
      enabled = false;
      requestRender();
    },
    setSidebarWidth(width) {
      const next = clamp(finiteInteger(width, sidebarWidth), minimumSidebar, maximumSidebar);
      if (next === sidebarWidth) return;
      sidebarWidth = next;
      requestRender();
    },
    getSidebarWidth: () => sidebarWidth,
    isEnabled: () => enabled,
    isVisibleAtWidth: visibleAt,
    overlayOptions: () => ({
      anchor: "top-right",
      width: tui ? effectiveSidebarWidth(tui.terminal.columns) : sidebarWidth,
      maxHeight: "100%",
      margin: 0,
      nonCapturing: true,
      visible: (terminalWidth) => visibleAt(terminalWidth),
    }),
    requestRender,
    dispose() {
      if (disposed) return;
      disposed = true;
      enabled = false;
      if (tui && originalRender && tui.render === wrappedRender) tui.render = originalRender;
      tui?.requestRender();
      tui = undefined;
      originalRender = undefined;
      wrappedRender = undefined;
    },
  };
}
```

If Biome requests line wrapping, accept its formatting without changing the interface or constants.

- [ ] **Step 4: Run focused tests and type checking**

Run:

```bash
npm test -- tests/split-pane.test.ts
npm run typecheck
```

Expected: all split-pane tests PASS and TypeScript exits 0.

- [ ] **Step 5: Commit the independent width-reservation layer**

```bash
git add src/split-pane.ts tests/split-pane.test.ts
git commit -m "feat(sidebar): reserve width for split layout"
```

---

### Task 2: Add temporary mouse and keyboard Resize mode

**Files:**
- Modify: `src/split-pane.ts`
- Modify: `tests/split-pane.test.ts`

**Interfaces:**
- Consumes: Task 1's `createSplitPaneController`, width bounds, attached `TUI`, and render lifecycle.
- Extends `SplitPaneControllerOptions` with:

```ts
subscribeInput?(handler: (data: string) => { consume?: boolean; data?: string } | undefined): () => void;
onResizeChange?(resizing: boolean): void;
onWarning?(message: string): void;
```

- Extends `SplitPaneController` with:

```ts
beginResize(): boolean;
finishResize(): void;
cancelResize(): void;
isResizing(): boolean;
```

- Produces the pure parser:

```ts
export interface SgrMouseEvent {
  button: number;
  x: number;
  y: number;
  release: boolean;
  motion: boolean;
}

export function parseSgrMouseEvent(data: string): SgrMouseEvent | undefined;
```

- [ ] **Step 1: Add failing parser and Resize-mode tests**

Extend the harness so its terminal columns can change and writes are observable. Add these tests to `tests/split-pane.test.ts`:

```ts
import { parseSgrMouseEvent } from "../src/split-pane.js";

const press = (x: number, y = 4) => `\u001b[<0;${x};${y}M`;
const motion = (x: number, y = 4) => `\u001b[<32;${x};${y}M`;
const release = (x: number, y = 4) => `\u001b[<0;${x};${y}m`;

describe("SGR mouse parsing", () => {
  it("parses press, held motion, and release coordinates", () => {
    expect(parseSgrMouseEvent(press(77))).toEqual({
      button: 0,
      x: 77,
      y: 4,
      release: false,
      motion: false,
    });
    expect(parseSgrMouseEvent(motion(70))).toMatchObject({ x: 70, motion: true, release: false });
    expect(parseSgrMouseEvent(release(70))).toMatchObject({ x: 70, motion: false, release: true });
  });

  it.each(["", "left", "\u001b[<x;1;1M", "\u001b[<0;0;1M"])("rejects malformed input: %j", (data) => {
    expect(parseSgrMouseEvent(data)).toBeUndefined();
  });
});
```

Add a Resize harness that captures the temporary input handler:

```ts
function resizeHarness(columns = 120) {
  const h = harness(columns);
  let input: ((data: string) => { consume?: boolean; data?: string } | undefined) | undefined;
  const unsubscribe = vi.fn();
  const onResizeChange = vi.fn();
  const split = createSplitPaneController({
    subscribeInput(handler) {
      input = handler;
      return unsubscribe;
    },
    onResizeChange,
  });
  split.attach(h.tui);
  split.show();
  return { ...h, split, unsubscribe, onResizeChange, send: (data: string) => input?.(data) };
}

describe("temporary Resize mode", () => {
  it("enables mouse reporting only during Resize mode", () => {
    const h = resizeHarness();
    expect(h.write).not.toHaveBeenCalled();

    expect(h.split.beginResize()).toBe(true);
    expect(h.write).toHaveBeenCalledWith("\u001b[?1002h\u001b[?1006h");
    expect(h.split.isResizing()).toBe(true);

    h.split.finishResize();
    expect(h.write).toHaveBeenLastCalledWith("\u001b[?1006l\u001b[?1002l");
    expect(h.unsubscribe).toHaveBeenCalledOnce();
    expect(h.split.isResizing()).toBe(false);
  });

  it("drags only from the divider and accepts on release", () => {
    const h = resizeHarness();
    h.split.beginResize();
    const dividerX = 120 - DEFAULT_SIDEBAR_WIDTH + 1;

    expect(h.send(press(dividerX))).toEqual({ consume: true });
    expect(h.send(motion(70))).toEqual({ consume: true });
    expect(h.split.getSidebarWidth()).toBe(51);
    expect(h.send(release(70))).toEqual({ consume: true });
    expect(h.split.isResizing()).toBe(false);
    expect(h.split.getSidebarWidth()).toBe(51);
  });

  it("cancels when pressing outside the divider", () => {
    const h = resizeHarness();
    h.split.beginResize();
    h.send("\u001b[C");
    expect(h.split.getSidebarWidth()).toBe(43);

    h.send(press(10));

    expect(h.split.getSidebarWidth()).toBe(DEFAULT_SIDEBAR_WIDTH);
    expect(h.split.isResizing()).toBe(false);
  });

  it("supports arrows, shifted arrows, Enter, and Escape rollback", () => {
    const h = resizeHarness();
    h.split.beginResize();
    h.send("\u001b[D");
    expect(h.split.getSidebarWidth()).toBe(45);
    h.send("\u001b[1;2D");
    expect(h.split.getSidebarWidth()).toBe(49);
    h.send("\u001b");
    expect(h.split.getSidebarWidth()).toBe(44);

    h.split.beginResize();
    h.send("\u001b[C");
    h.send("\r");
    expect(h.split.getSidebarWidth()).toBe(43);
    expect(h.split.isResizing()).toBe(false);
  });
});
```

Use `matchesKey()` in implementation and adjust literal test sequences only if the repository's active pi-tui version encodes shifted arrows differently. Keep the behavioral assertions unchanged.

Add cleanup and narrow-terminal tests:

```ts
it("refuses Resize mode when the split is hidden or not attached", () => {
  const warnings: string[] = [];
  const split = createSplitPaneController({ onWarning: (message) => warnings.push(message) });
  expect(split.beginResize()).toBe(false);
  expect(warnings.at(-1)).toContain("not ready");

  const h = harness(91);
  split.attach(h.tui);
  split.show();
  expect(split.beginResize()).toBe(false);
  expect(h.write).not.toHaveBeenCalled();
});

it.each(["hide", "dispose"] as const)("cleans mouse state on %s", (action) => {
  const h = resizeHarness();
  h.split.beginResize();
  h.split[action]();
  expect(h.write).toHaveBeenLastCalledWith("\u001b[?1006l\u001b[?1002l");
  expect(h.unsubscribe).toHaveBeenCalledOnce();
});

it("reclamps while resizing and exits safely when the terminal becomes too narrow", () => {
  const h = resizeHarness();
  h.split.setSidebarWidth(72);
  h.split.beginResize();
  expect(h.split.getSidebarWidth()).toBe(56);

  h.tui.terminal.columns = 100;
  h.tui.render(100);
  expect(h.split.getSidebarWidth()).toBe(36);

  h.tui.terminal.columns = 91;
  h.tui.render(91);
  expect(h.split.isResizing()).toBe(false);
  expect(h.write).toHaveBeenLastCalledWith("\u001b[?1006l\u001b[?1002l");
});
```

- [ ] **Step 2: Run tests and verify Resize APIs are missing**

Run:

```bash
npm test -- tests/split-pane.test.ts
```

Expected: FAIL because `parseSgrMouseEvent`, `beginResize`, `finishResize`, `cancelResize`, and `isResizing` do not exist.

- [ ] **Step 3: Implement SGR parsing and Resize-mode lifecycle**

Add to `src/split-pane.ts`:

```ts
import { matchesKey } from "@earendil-works/pi-tui";

const ENABLE_MOUSE = "\u001b[?1002h\u001b[?1006h";
const DISABLE_MOUSE = "\u001b[?1006l\u001b[?1002l";
const SGR_MOUSE = /^\u001b\[<(\d+);(\d+);(\d+)([Mm])$/;

export interface SgrMouseEvent {
  button: number;
  x: number;
  y: number;
  release: boolean;
  motion: boolean;
}

export function parseSgrMouseEvent(data: string): SgrMouseEvent | undefined {
  const match = data.match(SGR_MOUSE);
  if (!match) return undefined;
  const button = Number(match[1]);
  const x = Number(match[2]);
  const y = Number(match[3]);
  if (![button, x, y].every(Number.isFinite) || x < 1 || y < 1) return undefined;
  return {
    button,
    x,
    y,
    release: match[4] === "m",
    motion: (button & 32) !== 0,
  };
}
```

Extend the interfaces exactly as listed above. Add controller state:

```ts
let resizing = false;
let resizeStartWidth = sidebarWidth;
let dragging = false;
let unsubscribeInput: (() => void) | undefined;
let mouseReportingEnabled = false;
```

Add one cleanup function used by finish, cancel, hide, dispose, and responsive terminal shrink:

```ts
const stopResize = (restore: boolean) => {
  if (!resizing && !mouseReportingEnabled && !unsubscribeInput) return;
  if (restore) sidebarWidth = resizeStartWidth;
  dragging = false;
  resizing = false;
  if (mouseReportingEnabled) {
    tui?.terminal.write(DISABLE_MOUSE);
    mouseReportingEnabled = false;
  }
  unsubscribeInput?.();
  unsubscribeInput = undefined;
  options.onResizeChange?.(false);
  requestRender();
};
```

Add a resize reconciliation helper and invoke it at the start of the wrapped renderer before computing reserved width:

```ts
const reconcileResizeWidth = (terminalWidth: number) => {
  if (!resizing) return;
  if (!visibleAt(terminalWidth)) {
    stopResize(true);
    return;
  }
  const effectiveMax = Math.min(maximumSidebar, terminalWidth - minimumMain);
  sidebarWidth = clamp(sidebarWidth, minimumSidebar, Math.max(minimumSidebar, effectiveMax));
};
```

In `wrappedRender`, call `reconcileResizeWidth(terminalWidth)` before `effectiveSidebarWidth(terminalWidth)`. This guarantees terminal shrink cannot leave mouse reporting active over a hidden split.

Implement the temporary input handler with a single decision path:

```ts
const handleResizeInput = (data: string): { consume?: boolean; data?: string } | undefined => {
  const mouse = parseSgrMouseEvent(data);
  if (mouse) {
    if (mouse.release) {
      if (dragging) stopResize(false);
      return { consume: true };
    }
    if (!mouse.motion && (mouse.button & 3) === 0) {
      const dividerX = (tui?.terminal.columns ?? 0) - sidebarWidth + 1;
      if (mouse.x !== dividerX) {
        stopResize(true);
      } else {
        dragging = true;
      }
      return { consume: true };
    }
    if (mouse.motion && dragging && tui) {
      const proposed = tui.terminal.columns - mouse.x + 1;
      const effectiveMax = Math.min(maximumSidebar, tui.terminal.columns - minimumMain);
      sidebarWidth = clamp(proposed, minimumSidebar, Math.max(minimumSidebar, effectiveMax));
      requestRender();
    }
    return { consume: true };
  }

  if (matchesKey(data, "shift+left")) {
    controller.setSidebarWidth(sidebarWidth + 4);
    return { consume: true };
  }
  if (matchesKey(data, "shift+right")) {
    controller.setSidebarWidth(sidebarWidth - 4);
    return { consume: true };
  }
  if (matchesKey(data, "left")) {
    controller.setSidebarWidth(sidebarWidth + 1);
    return { consume: true };
  }
  if (matchesKey(data, "right")) {
    controller.setSidebarWidth(sidebarWidth - 1);
    return { consume: true };
  }
  if (matchesKey(data, "enter")) {
    stopResize(false);
    return { consume: true };
  }
  if (matchesKey(data, "escape")) {
    stopResize(true);
    return { consume: true };
  }
  return undefined;
};
```

Declare `let controller: SplitPaneController;`, assign the returned object to it, and use that stable object inside the handler. Implement the new public methods:

```ts
beginResize() {
  if (resizing) return true;
  if (!tui || !enabled) {
    options.onWarning?.("Atelier sidebar is not ready to resize");
    return false;
  }
  if (!visibleAt(tui.terminal.columns)) {
    options.onWarning?.("Terminal is too narrow to resize the Atelier sidebar");
    return false;
  }
  if (!options.subscribeInput) {
    options.onWarning?.("Terminal input is unavailable for sidebar resizing");
    return false;
  }
  sidebarWidth = effectiveSidebarWidth(tui.terminal.columns);
  resizeStartWidth = sidebarWidth;
  dragging = false;
  resizing = true;
  try {
    unsubscribeInput = options.subscribeInput(handleResizeInput);
    mouseReportingEnabled = true;
    tui.terminal.write(ENABLE_MOUSE);
    options.onResizeChange?.(true);
    requestRender();
    return true;
  } catch (error) {
    options.onError?.(error);
    stopResize(true);
    return false;
  }
},
finishResize: () => stopResize(false),
cancelResize: () => stopResize(true),
isResizing: () => resizing,
```

Call `stopResize(true)` at the start of `hide()` and `dispose()`. Keep cleanup idempotent and leave unrelated keyboard input unconsumed.

- [ ] **Step 4: Run focused tests, typecheck, and formatter**

Run:

```bash
npm test -- tests/split-pane.test.ts
npm run typecheck
npm run format:check
```

Expected: tests and typecheck PASS. If format check fails, run `npm run format`, inspect the diff, then rerun the three commands.

- [ ] **Step 5: Commit temporary Resize mode**

```bash
git add src/split-pane.ts tests/split-pane.test.ts
git commit -m "feat(sidebar): add temporary resize mode"
```

---

### Task 3: Compose split behavior into the sidebar controller and renderer

**Files:**
- Modify: `src/sidebar.ts:68-81, 93-105, 498-718`
- Modify: `tests/sidebar.test.ts:108-226, 836-1100`

**Interfaces:**
- Consumes: Task 2's `createSplitPaneController`, `SplitPaneController`, dynamic `overlayOptions()`, and Resize methods.
- Extends the existing `SidebarController` with:

```ts
beginResize(): boolean;
isResizing(): boolean;
getWidth(): number;
```

- Extends `SidebarComponentOptions` with:

```ts
isResizing?(): boolean;
```

- Produces: one session-scoped sidebar controller that owns exactly one overlay and one split controller.

- [ ] **Step 1: Update sidebar tests to require dynamic width and Resize state**

In `tests/sidebar.test.ts`, remove the standalone static `sidebarOverlayOptions()` assertion. Import the constants from `src/split-pane.ts` and update controller fakes so the TUI has `render`, `terminal.columns`, `terminal.write`, and `requestRender`:

```ts
function fakeTui(requestRender = vi.fn()) {
  return {
    render: vi.fn((width: number) => [`main:${width}`]),
    requestRender,
    terminal: { columns: 120, rows: 36, write: vi.fn() },
  };
}
```

Update the lifecycle test's `custom` factory to retain this TUI and resolve function-valued options:

```ts
const tui = fakeTui(requestRender);
components.push(factory(tui as never, theme as never, {} as never, done));
const overlayOptions =
  typeof customOptions.overlayOptions === "function"
    ? customOptions.overlayOptions()
    : customOptions.overlayOptions;
expect(overlayOptions).toMatchObject({
  anchor: "top-right",
  width: 44,
  nonCapturing: true,
});
expect(tui.render(120)).toEqual(["main:76"]);
```

Add a component presentation test:

```ts
it("shows a visible Resize state and active divider styling", () => {
  const fg = vi.fn((_color: string, text: string) => text);
  const component = createSidebarComponent({
    getSnapshot: snapshot,
    getConfig: () => DEFAULT_CONFIG,
    getHeight: () => 36,
    isResizing: () => true,
    theme: { ...theme, fg },
  });

  expect(component.render(44).join("\n")).toContain("RESIZE");
  expect(fg).toHaveBeenCalledWith("warning", "│");
});
```

Add a controller Resize test with an input handler capture:

```ts
it("enters Resize mode through the composed sidebar controller", () => {
  let input: ((data: string) => unknown) | undefined;
  const tui = fakeTui();
  const custom = vi.fn((factory, options) => {
    factory(tui as never, theme as never, {} as never, vi.fn());
    options.onHandle?.({ hide: vi.fn() });
    return new Promise(() => undefined);
  });
  const controller = createSidebarController({
    ctx: {
      mode: "tui",
      ui: {
        custom,
        onTerminalInput: vi.fn((handler) => {
          input = handler;
          return vi.fn();
        }),
      },
    } as never,
    getSnapshot: snapshot,
    getConfig: () => DEFAULT_CONFIG,
  });

  controller.show();
  expect(controller.beginResize()).toBe(true);
  expect(controller.isResizing()).toBe(true);
  expect(controller.getWidth()).toBe(44);
  expect(input).toBeTypeOf("function");
});
```

- [ ] **Step 2: Run sidebar tests and verify failures**

Run:

```bash
npm test -- tests/sidebar.test.ts
```

Expected: FAIL because the sidebar still uses static overlay options, does not reserve main width, and lacks Resize methods/state.

- [ ] **Step 3: Integrate the split controller into `src/sidebar.ts`**

Import the split controller:

```ts
import {
  createSplitPaneController,
  type SplitPaneController,
} from "./split-pane.js";
```

Remove the old exported `sidebarOverlayOptions()` function. Change divider rendering to accept Resize state:

```ts
function renderDock(
  rows: string[],
  width: number,
  height: number,
  palette: AtelierPalette,
  resizing = false,
): string[] {
  // keep existing safe width/height and content logic
  const divider = palette.paint(resizing ? "warning" : "dim", "│");
  // keep the existing Array.from body
}
```

In `renderSidebarLines`, add a final `resizing = false` parameter after `now`, prepend one required Resize group when active, and pass the flag to `renderDock`:

```ts
const groups: SidebarGroup[] = [
  ...(resizing
    ? [{ name: "resize", rows: [palette.paint("warning", "RESIZE · drag divider"), ""], required: true, dropRank: Number.POSITIVE_INFINITY }]
    : []),
  // existing project, agent, activity, context, session, usage, tools, statuses
];
return renderDock(flattenGroups(composeGroups(groups, safeHeight)), safeWidth, safeHeight, palette, resizing);
```

Pass `options.isResizing?.() ?? false` from `createSidebarComponent`. Pass the same flag to `renderSidebarError` so the active divider remains visible even when content rendering fails.

Extend `SidebarControllerOptions` with `onWarning?(message: string): void`. Extend controller interfaces:

```ts
export interface SidebarController {
  show(): void;
  hide(): void;
  toggle(): void;
  isVisible(): boolean;
  beginResize(): boolean;
  isResizing(): boolean;
  getWidth(): number;
  requestRender(): void;
  dispose(): void;
}
```

Inside `createSidebarController`, instantiate one split controller before defining `show`/`hide`:

```ts
let splitRequestRender: (() => void) | undefined;
const split: SplitPaneController = createSplitPaneController({
  subscribeInput: (handler) => options.ctx.ui.onTerminalInput(handler),
  onResizeChange: () => {
    requestOverlayRender?.();
    splitRequestRender?.();
  },
  onWarning: options.onWarning,
  onError: options.onError,
});
```

When the overlay factory receives `tui`, attach and expose its render request:

```ts
split.attach(tui);
splitRequestRender = () => tui.requestRender();
```

Pass `isResizing: split.isResizing` into `createSidebarComponent`. Replace static overlay options with:

```ts
overlayOptions: () => split.overlayOptions(),
```

Lifecycle ordering:

- `show()` calls `split.show()` before creating the overlay.
- If overlay creation throws or its promise rejects, call `split.hide()`.
- `hide()` calls `split.cancelResize()`, closes/hides the overlay, then calls `split.hide()` and clears callbacks.
- `requestRender()` calls both `requestOverlayRender?.()` and `split.requestRender()`.
- `dispose()` calls existing hide logic and then `split.dispose()`.
- Return `beginResize: split.beginResize`, `isResizing: split.isResizing`, and `getWidth: split.getSidebarWidth`.

Do not move sidebar snapshot, activity, palette, or animation responsibilities into `split-pane.ts`.

- [ ] **Step 4: Run split and sidebar suites**

Run:

```bash
npm test -- tests/split-pane.test.ts tests/sidebar.test.ts
npm run typecheck
```

Expected: both suites PASS and TypeScript exits 0.

- [ ] **Step 5: Commit sidebar composition**

```bash
git add src/sidebar.ts tests/sidebar.test.ts
git commit -m "refactor(sidebar): compose resizable split presentation"
```

---

### Task 4: Register the Resize shortcut and enforce lifecycle cleanup

**Files:**
- Modify: `extensions/index.ts:23-362`
- Modify: `tests/extension.test.ts:13-520`

**Interfaces:**
- Consumes: Task 3's `SidebarController.beginResize()`, split-aware `show/hide/dispose`, and current lifecycle-generation guard.
- Produces: registered `Ctrl+Shift+R` routing to only the active session and `/atelier disable` cleanup of both footer and sidebar presentation.

- [ ] **Step 1: Extend the extension harness and write failing integration tests**

Change `tests/extension.test.ts` shortcut storage from only a string array to both keys and handlers:

```ts
const shortcuts: string[] = [];
const shortcutHandlers = new Map<string, (ctx: any) => Promise<void> | void>();
// ...
registerShortcut: vi.fn((key: string, options: any) => {
  shortcuts.push(key);
  shortcutHandlers.set(key, options.handler);
}),
```

Add `onTerminalInput`, a real fake render method, and terminal writes to the harness:

```ts
let terminalInput: ((data: string) => unknown) | undefined;
const terminalWrite = vi.fn();
const baseRender = vi.fn((width: number) => [`main:${width}`]);
const tui = {
  render: baseRender,
  terminal: { columns: 120, rows: 36, width: 120, write: terminalWrite },
  requestRender,
};
// pass `tui` to factory
// add to ctx.ui:
onTerminalInput: vi.fn((handler) => {
  terminalInput = handler;
  return vi.fn();
}),
```

Resolve function-valued overlay options before checking `nonCapturing`:

```ts
const overlayOptions =
  typeof options?.overlayOptions === "function"
    ? options.overlayOptions()
    : options?.overlayOptions;
if (!overlayOptions?.nonCapturing) done();
```

Return `shortcutHandlers`, `terminalWrite`, `baseRender`, and a getter for `terminalInput` from `harness()`.

Update registration expectations:

```ts
expect(h.shortcuts).toContain("alt+a");
expect(h.shortcuts).toContain("ctrl+shift+r");
```

Add integration tests:

```ts
it("reflows the Pi workspace beside the visible sidebar", async () => {
  const h = harness();
  await start(h);
  await command(h, "sidebar on");

  expect(h.overlays[0]?.options.overlayOptions()).toMatchObject({ width: 44 });
  expect(h.overlays[0]?.tui.render(120)).toEqual(["main:76"]);

  await command(h, "sidebar off");
  expect(h.overlays[0]?.tui.render(120)).toEqual(["main:120"]);
});

it("enters Resize mode with Ctrl+Shift+R only for the active visible sidebar", async () => {
  const h = harness();
  await start(h);
  await h.shortcutHandlers.get("ctrl+shift+r")?.(h.ctx);
  expect(h.terminalWrite).not.toHaveBeenCalled();
  expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("sidebar"), "warning");

  await command(h, "sidebar on");
  await h.shortcutHandlers.get("ctrl+shift+r")?.(h.ctx);
  expect(h.terminalWrite).toHaveBeenCalledWith("\u001b[?1002h\u001b[?1006h");
});

it("disable closes the sidebar and restores render and mouse state", async () => {
  const h = harness();
  await start(h);
  await command(h, "sidebar on");
  await h.shortcutHandlers.get("ctrl+shift+r")?.(h.ctx);

  await command(h, "disable");

  expect(h.overlays[0]?.done).toHaveBeenCalledOnce();
  expect(h.terminalWrite).toHaveBeenLastCalledWith("\u001b[?1006l\u001b[?1002l");
  expect(h.overlays[0]?.tui.render(120)).toEqual(["main:120"]);
  expect(h.setFooter).toHaveBeenLastCalledWith(undefined);
});
```

Update the existing test named `keeps sidebar and footer enablement independent`; replace it with the disable cleanup expectation above because the approved spec intentionally changes disable semantics.

Add a stale-context assertion by invoking the resize shortcut with an old replacement context and checking no new terminal mouse enable sequence is written.

- [ ] **Step 2: Run extension tests and verify registration/lifecycle failures**

Run:

```bash
npm test -- tests/extension.test.ts
```

Expected: FAIL because `ctrl+shift+r` is not registered, the base renderer is not width-wrapped, and disable leaves the sidebar alive.

- [ ] **Step 3: Register and route the Resize shortcut**

In `extensions/index.ts`, add a separate registration guard:

```ts
let resizeShortcutRegistered = false;
```

During successful TUI initialization, next to the existing Atelier menu shortcut registration, register:

```ts
if (isFresh() && !resizeShortcutRegistered) {
  pi.registerShortcut("ctrl+shift+r" as KeyId, {
    description: "Resize Pi Atelier sidebar",
    handler: (shortcutContext) => {
      const current = getCurrentContextState(shortcutContext);
      if (!current?.sidebar || !current.sidebar.isVisible()) {
        shortcutContext.ui.notify("Show the Pi Atelier sidebar before resizing it", "warning");
        return;
      }
      current.sidebar.beginResize();
    },
  });
  resizeShortcutRegistered = true;
}
```

Do not use the user-configurable menu shortcut for Resize mode; `Ctrl+Shift+R` is a fixed interaction specified by the approved design.

When constructing the sidebar controller during `session_start`, pass `onWarning: (message) => initializationContext.ui.notify(message, "warning")` alongside the existing `onError` callback.

Change `/atelier disable` to close the complete Atelier presentation before clearing the footer:

```ts
if (action === "disable") {
  enabled = false;
  sidebar?.hide();
  updateExtensionStatuses([]);
  ctx.ui.setFooter(undefined);
  ctx.ui.notify("Pi Atelier disabled", "info");
  return;
}
```

Keep session replacement and shutdown disposal ordering: sidebar first, runtime second, run activity third, footer cleanup last. The Task 3 controller now restores width and mouse state through the existing `dispose()` calls.

- [ ] **Step 4: Run all functional test suites**

Run:

```bash
npm test -- tests/split-pane.test.ts tests/sidebar.test.ts tests/extension.test.ts tests/menu.test.ts
npm run typecheck
```

Expected: all selected suites PASS and TypeScript exits 0.

- [ ] **Step 5: Commit extension integration**

```bash
git add extensions/index.ts tests/extension.test.ts
git commit -m "feat(sidebar): wire resize shortcut and cleanup"
```

---

### Task 5: Document behavior, compatibility, and complete verification

**Files:**
- Modify: `README.md:106-130, 172-200`
- Modify: `CHANGELOG.md:1-5`
- Modify if packaging expectations require it: `tests/package.test.ts`

**Interfaces:**
- Consumes: completed user behavior and verified limits from Tasks 1–4.
- Produces: user-facing command/shortcut guidance and release notes consistent with actual implementation.

- [ ] **Step 1: Add a failing documentation contract test**

In `tests/package.test.ts`, add a focused assertion that prevents publishing without Resize documentation:

```ts
import { readFile } from "node:fs/promises";

it("documents the split sidebar Resize interaction", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  expect(readme).toContain("Ctrl+Shift+R");
  expect(readme).toContain("28");
  expect(readme).toContain("72");
  expect(readme).toContain("version-sensitive");
});
```

If `tests/package.test.ts` already reads README text, reuse its helper rather than adding a duplicate read.

- [ ] **Step 2: Run the package test and verify missing documentation**

Run:

```bash
npm test -- tests/package.test.ts
```

Expected: FAIL because README does not yet mention `Ctrl+Shift+R` or the version-sensitive integration.

- [ ] **Step 3: Update README and changelog with exact behavior**

Replace the current statement that the rail always overlays the right edge and auto-hides below 88 columns. Document:

```markdown
The sidebar uses a non-overlapping split presentation: Pi's workspace reflows into the columns to the left of the rail instead of rendering underneath it. It starts at 44 columns, can be resized between 28 and 72 columns, always preserves at least 64 columns for Pi, and auto-hides below 92 terminal columns.

Press `Ctrl+Shift+R` to enter temporary Resize mode. Drag the divider and release to accept, use Left/Right for one-column adjustments, Shift+Left/Shift+Right for four-column adjustments, Enter to accept, or Escape to restore the previous width. Mouse reporting is active only during Resize mode, so ordinary terminal text selection is unchanged at all other times.

The split is implemented entirely inside Pi Atelier by wrapping the active TUI renderer at runtime; no Pi files are modified. This is a version-sensitive integration with Pi's current TUI structure and may require compatibility updates when Pi changes its renderer internals. A terminal character divider cannot display Ghostty's native hover resize cursor.
```

Add under `## Unreleased` in `CHANGELOG.md`:

```markdown
- Reflow Pi beside the sidebar with an extension-only, non-overlapping split presentation.
- Add session-scoped sidebar resizing through temporary `Ctrl+Shift+R` mouse and keyboard controls.
```

Keep the README command examples and existing activity/sidebar feature description.

- [ ] **Step 4: Run the complete verification pipeline**

Run:

```bash
npm run check
npm pack --dry-run
```

Expected:

- TypeScript exits 0.
- Biome lint and format checks exit 0.
- All Vitest suites pass, including the new split-pane suite.
- Package verification reports the expected included files and no forbidden files.
- `npm pack --dry-run` exits 0 and includes `src/split-pane.ts` because the package already ships the complete `src` directory.

If any command fails, fix the specific failure, rerun its focused command, then rerun both commands above from the beginning. Do not mark implementation complete with a failing check.

- [ ] **Step 5: Inspect the final diff for scope and safety**

Run:

```bash
git status --short
git diff --check
git diff --stat 8e52c17..HEAD
git diff 8e52c17..HEAD -- src/split-pane.ts src/sidebar.ts extensions/index.ts README.md CHANGELOG.md
```

Expected: only the files named in this plan plus their tests are changed; no Pi installation files, generated tarballs, credentials, or unrelated refactors appear.

- [ ] **Step 6: Commit documentation and package contract**

```bash
git add README.md CHANGELOG.md tests/package.test.ts
git commit -m "docs(sidebar): document resizable split view"
```

- [ ] **Step 7: Record final evidence**

Run:

```bash
git status --short
git log --oneline -5
```

Expected: working tree is clean and the five implementation commits are visible in order:

```text
docs(sidebar): document resizable split view
feat(sidebar): wire resize shortcut and cleanup
refactor(sidebar): compose resizable split presentation
feat(sidebar): add temporary resize mode
feat(sidebar): reserve width for split layout
```
