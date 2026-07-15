# Pi Atelier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and package a robust Pi extension that replaces the default footer with a responsive editorial-luxe status/menu bar while preserving Pi's operational metrics.

**Architecture:** Pure modules calculate metrics, validate configuration, and render width-safe segments. A small runtime adapter subscribes to Pi events, installs the footer, probes git state, and opens native Pi overlay menus. The extension entry point owns registration and cleanup; no module reads prompts, responses, credentials, or network resources.

**Tech Stack:** TypeScript 5.9, Pi extension API 0.80.7+, `@earendil-works/pi-tui`, Vitest 4, Biome 2, Node.js 22.19+

## Global Constraints

- Package and display name: `pi-atelier` / **Pi Atelier**.
- Minimum Pi version: `0.80.7`; Node.js minimum: `22.19.0`.
- Rich footer and overlay UI run only in `ctx.mode === "tui"`.
- Preserve cumulative `↑`, `↓`, `R`, optional `W`, latest `CH`, cost/subscription, context, and auto-compaction metrics.
- Preserve all required metric categories at terminal widths of 56 columns or wider; never exceed the supplied width at any width.
- Default shortcut: `alt+a`; `/atelier` is always available.
- Configuration precedence: defaults → user → trusted project → session.
- No telemetry, network requests, prompt/response persistence, or credential access.
- Use Pi theme callbacks and ANSI-aware width utilities; do not hard-code ANSI colors.
- Only one custom footer can be active; document load-order conflicts and restore the built-in footer on disable/shutdown.
- Follow TDD for each behavior and commit each independently testable task.

---

## File Map

- `package.json` — npm metadata, Pi manifest, peer/dev dependencies, verification scripts.
- `tsconfig.json` — strict no-emit TypeScript configuration.
- `biome.json` — deterministic formatting and lint rules.
- `.gitignore` — dependencies, coverage, tarballs, logs, and temporary files.
- `extensions/index.ts` — Pi extension registration and lifecycle wiring only.
- `src/types.ts` — shared public-internal types and constants.
- `src/metrics.ts` — pure usage aggregation and number/cost/context formatting.
- `src/config.ts` — defaults, validation, merge precedence, trusted loading, and atomic user saves.
- `src/footer.ts` — pure segment construction plus the Pi footer component adapter.
- `src/state.ts` — runtime state, event-driven invalidation, settings lookup, and git dirty probe.
- `src/menu.ts` — reusable native overlay helpers and four menu sections.
- `tests/metrics.test.ts` — exact parity tests for Pi's default metrics.
- `tests/config.test.ts` — validation, precedence, trust, and atomic persistence tests.
- `tests/footer.test.ts` — responsive layout, ANSI width, priority, and failure isolation tests.
- `tests/state.test.ts` — lifecycle state transitions, git probe, and cleanup tests.
- `tests/menu.test.ts` — model/tool/display/session action tests with mocked Pi adapters.
- `tests/extension.test.ts` — registration and TUI/non-TUI integration tests.
- `README.md` — installation, UI anatomy, configuration, compatibility, privacy, and conflicts.
- `CHANGELOG.md` — `0.1.0` release notes.
- `LICENSE` — MIT license.

---

### Task 1: Scaffold the publishable package and verification harness

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `biome.json`
- Create: `.gitignore`
- Create: `src/types.ts`
- Create: `tests/package.test.ts`

**Interfaces:**
- Produces: `PresetName`, `ActivityState`, `SegmentId`, `AtelierConfig`, `AtelierMetrics`, `AtelierState`, `DEFAULT_CONFIG`, and npm scripts used by every later task.
- Consumes: no earlier implementation files.

- [ ] **Step 1: Write the failing package contract test**

Create `tests/package.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

describe("npm package contract", () => {
  it("publishes a Pi extension with compatible peers", () => {
    expect(pkg.name).toBe("pi-atelier");
    expect(pkg.version).toBe("0.1.0");
    expect(pkg.keywords).toContain("pi-package");
    expect(pkg.pi.extensions).toEqual(["./extensions/index.ts"]);
    expect(pkg.peerDependencies["@earendil-works/pi-coding-agent"]).toBe(">=0.80.7");
    expect(pkg.peerDependencies["@earendil-works/pi-tui"]).toBe(">=0.80.7");
    expect(pkg.engines.node).toBe(">=22.19.0");
    expect(pkg.files).toEqual(expect.arrayContaining(["extensions", "src", "README.md", "LICENSE"]));
  });
});
```

- [ ] **Step 2: Create the manifest and prove the test reaches the intended failure**

Create `package.json` with the scripts and dependencies below, run `npm install`, then run the test before adding the `pi` manifest.

```json
{
  "name": "pi-atelier",
  "version": "0.1.0",
  "description": "An elegant, information-rich status and menu bar for Pi",
  "type": "module",
  "license": "MIT",
  "keywords": ["pi-package", "pi", "extension", "tui", "status-bar"],
  "files": ["extensions", "src", "README.md", "CHANGELOG.md", "LICENSE"],
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "lint": "biome lint .",
    "format": "biome format --write .",
    "format:check": "biome format .",
    "check": "npm run typecheck && npm run lint && npm run format:check && npm test"
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": ">=0.80.7",
    "@earendil-works/pi-tui": ">=0.80.7"
  },
  "devDependencies": {
    "@biomejs/biome": "2.5.4",
    "@earendil-works/pi-coding-agent": "0.80.7",
    "@earendil-works/pi-tui": "0.80.7",
    "@types/node": "24.12.4",
    "typescript": "5.9.3",
    "vitest": "4.1.10"
  },
  "engines": { "node": ">=22.19.0" }
}
```

Run: `npm install && npm test -- tests/package.test.ts`

Expected: FAIL because `pkg.pi` is undefined.

- [ ] **Step 3: Complete the package/tooling configuration**

Add to `package.json`:

```json
"pi": { "extensions": ["./extensions/index.ts"] },
"repository": { "type": "git", "url": "git+https://github.com/michaelmjhhhh/pi-atelier.git" },
"bugs": { "url": "https://github.com/michaelmjhhhh/pi-atelier/issues" },
"homepage": "https://github.com/michaelmjhhhh/pi-atelier#readme"
```

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "types": ["node", "vitest/globals"]
  },
  "include": ["extensions/**/*.ts", "src/**/*.ts", "tests/**/*.ts"]
}
```

Create `biome.json`:

```json
{
  "$schema": "https://biomejs.dev/schemas/2.5.4/schema.json",
  "formatter": { "enabled": true, "indentStyle": "tab", "lineWidth": 110 },
  "linter": { "enabled": true, "rules": { "recommended": true } },
  "files": { "includes": ["**", "!node_modules", "!coverage", "!*.tgz"] }
}
```

Create `.gitignore`:

```gitignore
node_modules/
coverage/
*.tgz
*.log
.DS_Store
.tmp/
```

- [ ] **Step 4: Define stable shared types**

Create `src/types.ts` with these exact exported types and defaults:

```ts
export type PresetName = "editorial" | "minimal" | "classic";
export type ActivityState = "ready" | "working" | "warning" | "error";
export type SegmentId = "brand" | "activity" | "metrics" | "context" | "model" | "git" | "statuses" | "menu";
export type Density = "comfortable" | "compact";
export type Ornament = "none" | "restrained";

export interface AtelierConfig {
  preset: PresetName;
  shortcut: string;
  segments: SegmentId[];
  density: Density;
  ornament: Ornament;
  contextWarning: number;
  contextDanger: number;
  currencyDecimals: number;
  showExtensionStatuses: boolean;
  showSessionActions: boolean;
}

export interface AtelierMetrics {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheHitPercent?: number;
  cost: number;
  subscription: boolean;
  contextTokens: number | null;
  contextWindow: number;
  contextPercent: number | null;
  autoCompact: boolean;
}

export interface AtelierState {
  activity: ActivityState;
  modelId?: string;
  provider?: string;
  thinkingLevel?: string;
  branch?: string;
  dirty: boolean;
  metrics: AtelierMetrics;
  extensionStatuses: readonly string[];
}

export const DEFAULT_CONFIG: AtelierConfig = {
  preset: "editorial",
  shortcut: "alt+a",
  segments: ["brand", "activity", "metrics", "context", "model", "git", "statuses", "menu"],
  density: "comfortable",
  ornament: "restrained",
  contextWarning: 70,
  contextDanger: 90,
  currencyDecimals: 3,
  showExtensionStatuses: true,
  showSessionActions: true,
};
```

- [ ] **Step 5: Run the package checks**

Run: `npm run check`

Expected: package test passes; TypeScript, Biome lint, and formatting report zero errors.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json biome.json .gitignore src/types.ts tests/package.test.ts
git commit -m "chore: scaffold Pi Atelier package"
```

---

### Task 2: Implement Pi-compatible metric aggregation and formatting

**Files:**
- Create: `src/metrics.ts`
- Create: `tests/metrics.test.ts`

**Interfaces:**
- Consumes: `AtelierMetrics` from `src/types.ts`.
- Produces: `aggregateMetrics(messages, options): AtelierMetrics`, `formatTokens(number): string`, full `formatMetrics`/`formatContext`, and narrow-width `formatCompactMetrics`/`formatCompactContext`.

- [ ] **Step 1: Write failing parity tests**

Create `tests/metrics.test.ts` with fixtures shaped like Pi assistant usage:

```ts
import { describe, expect, it } from "vitest";
import { aggregateMetrics, formatContext, formatMetrics, formatTokens } from "../src/metrics.js";

const messages = [
  { usage: { input: 1_200, output: 500, cacheRead: 8_000, cacheWrite: 300, cost: { total: 0.125 } } },
  { usage: { input: 2_000, output: 700, cacheRead: 18_000, cacheWrite: 0, cost: { total: 0.375 } } },
];

describe("metrics", () => {
  it("matches Pi cumulative totals and latest cache-hit semantics", () => {
    const result = aggregateMetrics(messages, {
      subscription: true,
      context: { tokens: 100_000, contextWindow: 372_000, percent: 26.8817 },
      autoCompact: true,
    });
    expect(result).toMatchObject({ input: 3_200, output: 1_200, cacheRead: 26_000, cacheWrite: 300, cost: 0.5 });
    expect(result.cacheHitPercent).toBeCloseTo(90, 5);
    expect(formatMetrics(result, 3)).toBe("↑3.2k ↓1.2k R26k W300 CH90.0% $0.500 (sub)");
    expect(formatContext(result)).toBe("26.9%/372k (auto)");
  });

  it("handles missing and zero prompt usage without NaN", () => {
    const result = aggregateMetrics([{ usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } }], {
      subscription: false,
      context: { tokens: null, contextWindow: 128_000, percent: null },
      autoCompact: false,
    });
    expect(result.cacheHitPercent).toBeUndefined();
    expect(formatMetrics(result, 3)).toBe("↑0 ↓0 R0 $0.000");
    expect(formatContext(result)).toBe("?/128k");
  });

  it.each([[999, "999"], [1_200, "1.2k"], [12_400, "12k"], [1_500_000, "1.5M"]])("formats %d as %s", (value, expected) => {
    expect(formatTokens(value)).toBe(expected);
  });
});
```

- [ ] **Step 2: Run the tests to verify failure**

Run: `npm test -- tests/metrics.test.ts`

Expected: FAIL because `src/metrics.ts` does not exist.

- [ ] **Step 3: Implement pure metrics functions**

Create `src/metrics.ts`. Define a local `UsageMessage` interface, sum every message, calculate the latest hit rate as `cacheRead / (input + cacheRead + cacheWrite) * 100`, include `W` only when nonzero, and use Pi's exact token thresholds: `<1k`, `<10k`, `<1M`, `<10M`, then rounded millions. Do not inspect message content.

The exported signatures must be:

```ts
export interface AggregateOptions {
  subscription: boolean;
  context?: { tokens: number | null; contextWindow: number; percent: number | null };
  autoCompact: boolean;
}
export function aggregateMetrics(messages: readonly UsageMessage[], options: AggregateOptions): AtelierMetrics;
export function formatTokens(count: number): string;
export function formatMetrics(metrics: AtelierMetrics, currencyDecimals: number): string;
export function formatContext(metrics: AtelierMetrics): string;
export function formatCompactMetrics(metrics: AtelierMetrics, currencyDecimals: number): string;
export function formatCompactContext(metrics: AtelierMetrics): string;
```

`formatMetrics` always emits `↑`, `↓`, `R`, and cost; emits `W`, `CH`, and `(sub)` only when applicable. Compact formatting removes optional spaces, rounds `CH` to an integer, caps cost at two decimals, shortens `(sub)` to `s`, and shortens `(auto)` to `a`, so the sample required metrics and context fit within 56 columns. Clamp currency decimals to `0..6` and use finite-number guards.

- [ ] **Step 4: Verify metric behavior**

Run: `npm test -- tests/metrics.test.ts && npm run typecheck`

Expected: all metric tests pass and TypeScript reports zero errors.

- [ ] **Step 5: Commit**

```bash
git add src/metrics.ts tests/metrics.test.ts
git commit -m "feat(metrics): preserve Pi usage statistics"
```

---

### Task 3: Implement trusted, validated configuration

**Files:**
- Create: `src/config.ts`
- Create: `tests/config.test.ts`

**Interfaces:**
- Consumes: `AtelierConfig`, `DEFAULT_CONFIG`, `PresetName`, and `SegmentId`.
- Produces: `validateConfig`, `mergeConfig`, `loadConfig`, `saveUserConfig`, and `ConfigLoadResult`.

- [ ] **Step 1: Write failing validation and trust tests**

Create `tests/config.test.ts` using a temporary directory. Cover these exact cases:

```ts
it("merges defaults, user, trusted project, then session overrides", async () => {
  await writeJson(userPath, { preset: "classic", density: "compact" });
  await writeJson(projectPath, { preset: "minimal", contextWarning: 65 });
  const result = await loadConfig({ userPath, projectPath, projectTrusted: true, session: { ornament: "none" } });
  expect(result.config).toMatchObject({ preset: "minimal", density: "compact", contextWarning: 65, ornament: "none" });
});

it("does not read untrusted project configuration", async () => {
  await writeJson(projectPath, { preset: "minimal" });
  const result = await loadConfig({ userPath, projectPath, projectTrusted: false });
  expect(result.config.preset).toBe("editorial");
});

it("rejects invalid thresholds, duplicates, and unknown segments", () => {
  const result = validateConfig({ contextWarning: 95, contextDanger: 80, segments: ["metrics", "metrics", "unknown"] });
  expect(result.config.contextWarning).toBe(70);
  expect(result.config.contextDanger).toBe(90);
  expect(result.config.segments).toEqual(["metrics"]);
  expect(result.warnings).toHaveLength(3);
});
```

Also test malformed JSON warning deduplication and atomic save by asserting the final JSON parses and no temporary file remains.

- [ ] **Step 2: Verify tests fail**

Run: `npm test -- tests/config.test.ts`

Expected: FAIL because configuration functions are missing.

- [ ] **Step 3: Implement validation and merging**

Create `src/config.ts` with allowlists for every enum. Unknown keys are ignored. Invalid individual fields fall back to the prior layer. Thresholds are accepted only when `0 <= warning < danger <= 100`. Segments are deduplicated in first-seen order; unknown segment IDs generate warnings. The required `metrics` and `context` segments are reinserted when omitted.

Use these signatures:

```ts
export interface ConfigLoadResult { config: AtelierConfig; warnings: string[]; }
export interface LoadConfigOptions {
  userPath: string;
  projectPath: string;
  projectTrusted: boolean;
  session?: Partial<AtelierConfig>;
}
export function validateConfig(input: unknown, base?: AtelierConfig): ConfigLoadResult;
export function mergeConfig(...layers: unknown[]): ConfigLoadResult;
export async function loadConfig(options: LoadConfigOptions): Promise<ConfigLoadResult>;
export async function saveUserConfig(path: string, config: AtelierConfig): Promise<void>;
```

`saveUserConfig` creates the parent directory, writes `${path}.${process.pid}.tmp` with mode `0o600`, then renames it. A `finally` block removes the temporary path after failures.

- [ ] **Step 4: Verify configuration behavior**

Run: `npm test -- tests/config.test.ts && npm run typecheck`

Expected: all configuration tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat(config): add trusted layered settings"
```

---

### Task 4: Build the responsive editorial-luxe footer

**Files:**
- Create: `src/footer.ts`
- Create: `tests/footer.test.ts`

**Interfaces:**
- Consumes: `AtelierConfig`, `AtelierState`, `formatMetrics`, `formatContext`, Pi `Theme`, and TUI width utilities.
- Produces: `renderFooterLine(state, config, theme, width): string` and `createFooterComponent(options): Component & { dispose(): void }`.

- [ ] **Step 1: Write failing responsive-render tests**

Create `tests/footer.test.ts` with a no-ANSI fake theme and a complete state fixture. Assert:

```ts
it("renders the full editorial layout at wide widths", () => {
  const line = renderFooterLine(state, DEFAULT_CONFIG, plainTheme, 160);
  expect(line).toContain("◆ ATELIER");
  expect(line).toContain("↑324k ↓15k R5.9M CH98.8% $5.041 (sub)");
  expect(line).toContain("27.0%/372k (auto)");
  expect(line).toContain("gpt-5.6-sol · medium");
  expect(line).toContain("main ✦");
  expect(visibleWidth(line)).toBeLessThanOrEqual(160);
});

it.each([160, 100, 80, 56, 40, 12])("never exceeds width %d", (width) => {
  expect(visibleWidth(renderFooterLine(state, DEFAULT_CONFIG, plainTheme, width))).toBeLessThanOrEqual(width);
});

it("preserves metrics and context at the supported narrow boundary", () => {
  const line = renderFooterLine(state, DEFAULT_CONFIG, plainTheme, 56);
  expect(line).toContain("↑324k");
  expect(line).toContain("CH98.8%");
  expect(line).toContain("27.0%/372k");
  expect(line).not.toContain("ATELIER");
});
```

Add tests for warning/error context colors, hidden optional segments, sanitized extension statuses, branch dirty marker, missing model/git values, and one optional segment renderer throwing without removing metrics/context.

- [ ] **Step 2: Verify tests fail**

Run: `npm test -- tests/footer.test.ts`

Expected: FAIL because the footer renderer is missing.

- [ ] **Step 3: Implement deterministic segment composition**

Create `src/footer.ts` with internal `Segment` objects `{ id, priority, required, full, compact }`. Build required metrics and context first. Add optional activity, model, git, statuses, brand, and menu segments. Sanitize statuses by replacing control characters with spaces and collapsing whitespace.

Layout algorithm:

1. Build segments in configured order.
2. At widths `<120`, switch optional segments to compact text.
3. Remove optional segments from lowest to highest priority until required segments fit.
4. At widths `56..119`, call `formatCompactMetrics` and `formatCompactContext`, use compact separators, and retain metrics/context categories.
5. Below 56, join those compact metric/context strings first and call `truncateToWidth`.
6. Apply `truncateToWidth(..., width, "")` to the final line as an invariant.

Catch errors per optional segment and omit only that segment. Required segment failures render `—` placeholders.

- [ ] **Step 4: Implement the component adapter**

`createFooterComponent` accepts getters rather than owning runtime state:

```ts
export interface FooterComponentOptions {
  getState(): AtelierState;
  getConfig(): AtelierConfig;
  requestRender(): void;
  onBranchChange(callback: () => void): () => void;
  theme: Theme;
}
```

The returned component subscribes once, renders with `renderFooterLine`, invalidates cached width/text, and calls the unsubscribe function exactly once from `dispose()`.

- [ ] **Step 5: Verify footer behavior**

Run: `npm test -- tests/footer.test.ts && npm run typecheck`

Expected: all responsive and cleanup tests pass with no width violations.

- [ ] **Step 6: Commit**

```bash
git add src/footer.ts tests/footer.test.ts
git commit -m "feat(footer): add responsive editorial status bar"
```

---

### Task 5: Implement runtime state and lifecycle integration

**Files:**
- Create: `src/state.ts`
- Create: `tests/state.test.ts`
- Create: `extensions/index.ts`
- Create: `tests/extension.test.ts`

**Interfaces:**
- Consumes: metrics/config/footer APIs and Pi `ExtensionAPI`/`ExtensionContext`.
- Produces: `AtelierRuntime`, default extension registration, `/atelier disable`, and lifecycle cleanup.

- [ ] **Step 1: Write failing state and extension tests**

Use lightweight fakes that record `pi.on`, `registerCommand`, `registerShortcut`, `setFooter`, `exec`, and render requests. Assert:

- `session_start` in TUI mode loads configuration and installs exactly one footer.
- print, JSON, and RPC session starts never call `setFooter`.
- `agent_start` sets `working`; `agent_settled` sets `ready`.
- model/thinking/session/turn/compaction events request a render.
- git dirty probes call `pi.exec("git", ["status", "--porcelain", "--untracked-files=no"], ...)` without shell interpolation.
- failed git probes set `dirty: false` without throwing.
- shutdown calls every disposer and `setFooter(undefined)`.
- `/atelier disable` restores the built-in footer.

- [ ] **Step 2: Verify tests fail**

Run: `npm test -- tests/state.test.ts tests/extension.test.ts`

Expected: FAIL because runtime and entry point are missing.

- [ ] **Step 3: Implement `AtelierRuntime`**

`src/state.ts` owns only normalized state and dependencies. Constructor inputs must be injectable for tests:

```ts
export interface RuntimeDependencies {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  config: AtelierConfig;
  autoCompact: boolean;
  requestRender(): void;
}
export class AtelierRuntime {
  getState(): AtelierState;
  getConfig(): AtelierConfig;
  setConfig(config: AtelierConfig): void;
  setActivity(activity: ActivityState): void;
  refreshUsage(): void;
  refreshGitDirty(): Promise<void>;
  dispose(): void;
}
```

`refreshUsage` scans `ctx.sessionManager.getEntries()`, selects assistant messages only, calls `aggregateMetrics`, checks subscription with `ctx.modelRegistry.isUsingOAuth(ctx.model)`, and reads `ctx.getContextUsage()`. It never copies message content into state.

`refreshGitDirty` uses `pi.exec` with a 2-second timeout and no shell. Nonzero exit, timeout, or exception means `dirty = false`.

- [ ] **Step 4: Wire the extension lifecycle**

In `extensions/index.ts`:

- Register `/atelier` during factory execution.
- During TUI `session_start`, load user config from `join(getAgentDir(), "pi-atelier.json")` and trusted project config from `join(ctx.cwd, CONFIG_DIR_NAME, "pi-atelier.json")`.
- Read compaction with `SettingsManager.create(ctx.isProjectTrusted() ? ctx.cwd : getAgentDir()).getCompactionSettings().enabled`.
- Register the resolved shortcut once per extension instance.
- Install the footer and initialize runtime state.
- Subscribe to `agent_start`, `agent_settled`, `turn_end`, `model_select`, `thinking_level_select`, `session_compact`, `session_info_changed`, and `session_shutdown`.
- On shutdown, dispose runtime and restore the built-in footer.
- Deduplicate configuration warnings before calling `ctx.ui.notify`.

Keep command behavior behind a mutable `openMenu` function so Task 6 can replace the initial informational notification without changing lifecycle code.

- [ ] **Step 5: Verify lifecycle behavior**

Run: `npm test -- tests/state.test.ts tests/extension.test.ts && npm run typecheck`

Expected: all lifecycle tests pass; no footer is installed in non-TUI modes.

- [ ] **Step 6: Commit**

```bash
git add src/state.ts extensions/index.ts tests/state.test.ts tests/extension.test.ts
git commit -m "feat(runtime): integrate Atelier with Pi lifecycle"
```

---

### Task 6: Add the four-section keyboard menu

**Files:**
- Create: `src/menu.ts`
- Create: `tests/menu.test.ts`
- Modify: `extensions/index.ts`

**Interfaces:**
- Consumes: `AtelierRuntime`, config persistence, Pi model/tool/thinking/session APIs, and native `SelectList`/`SettingsList`.
- Produces: `openAtelierMenu(pi, ctx, runtime, paths): Promise<void>`.

- [ ] **Step 1: Write failing menu action tests**

Test pure action adapters separately from rendering. Required cases:

```ts
it("keeps the prior model when setModel fails", async () => {
  pi.setModel.mockResolvedValue(false);
  await actions.selectModel(candidate);
  expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("authentication"), "error");
  expect(runtime.requestRender).not.toHaveBeenCalled();
});

it("filters unknown tools before applying selection", () => {
  pi.getAllTools.mockReturnValue([{ name: "read" }, { name: "bash" }]);
  actions.setTools(["read", "missing"]);
  expect(pi.setActiveTools).toHaveBeenCalledWith(["read"]);
});

it("persists display changes only after explicit save", async () => {
  actions.setPreset("minimal");
  expect(saveUserConfig).not.toHaveBeenCalled();
  await actions.saveDisplayDefaults();
  expect(saveUserConfig).toHaveBeenCalledOnce();
});

it("renames a session only after non-empty input", async () => {
  ctx.ui.input.mockResolvedValue("  Release prep  ");
  await actions.renameSession();
  expect(pi.setSessionName).toHaveBeenCalledWith("Release prep");
});
```

Also test thinking-level updates, tool settings, display segment toggles, compact trigger, action failure notifications, Escape/back navigation, and non-TUI rejection.

- [ ] **Step 2: Verify tests fail**

Run: `npm test -- tests/menu.test.ts`

Expected: FAIL because menu actions and renderer are missing.

- [ ] **Step 3: Implement reusable menu primitives**

Create `showSelection(ctx, title, items)` using `DynamicBorder`, `SelectList`, and a centered responsive overlay with `width: "70%"`, `minWidth: 32`, `maxHeight: "80%"`, and margin `1`. Do not use `visible` to hide a focused overlay, because that can leave a command waiting on an invisible menu. Use `SettingsList` for tool and display toggles. Every component delegates input to the native component and calls `tui.requestRender()`.

The root selector contains exact values `model`, `tools`, `display`, `session`, and `close`. Closing a child reopens the root; Escape from the root closes the overlay flow.

- [ ] **Step 4: Implement safe action adapters**

Model actions use `ctx.modelRegistry.getAvailable()`, identify choices by `provider/id`, and call `await pi.setModel(model)`. Thinking choices are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`; Pi performs model capability clamping.

Tool actions derive names from `pi.getAllTools()`, apply only known names, and never leave the tool set empty without a confirmation prompt.

Display actions update session config immediately. The explicit `Save as user default` action calls `saveUserConfig`; project config is never written.

Session actions provide details, rename via `pi.setSessionName`, and trigger `ctx.compact()` after confirmation. They do not expose delete, arbitrary session-file selection, or shutdown in `0.1.0`.

Wrap each action in `try/catch`; notify on failure and preserve the prior runtime config/model/tool selection.

- [ ] **Step 5: Connect command and shortcut**

Modify `extensions/index.ts` so `/atelier` and the resolved shortcut call the same `openAtelierMenu`. If a configured shortcut is invalid, notify once and register `alt+a` instead. `/atelier disable` restores the built-in footer; `/atelier enable` reinstalls it; `/atelier` with no arguments opens the root menu.

- [ ] **Step 6: Verify all menu paths**

Run: `npm test -- tests/menu.test.ts tests/extension.test.ts && npm run typecheck`

Expected: all four menu sections and failure rollback cases pass.

- [ ] **Step 7: Commit**

```bash
git add src/menu.ts extensions/index.ts tests/menu.test.ts tests/extension.test.ts
git commit -m "feat(menu): add Atelier workspace controls"
```

---

### Task 7: Document, harden, and validate the release artifact

**Files:**
- Create: `README.md`
- Create: `CHANGELOG.md`
- Create: `LICENSE`
- Modify: `package.json`
- Modify: tests as required by discovered packaging issues

**Interfaces:**
- Consumes: the complete extension and npm manifest.
- Produces: a documented, inspectable `pi-atelier-0.1.0.tgz` release candidate.

- [ ] **Step 1: Write release documentation**

README sections must be: Preview, Features, Requirements, Install, Local Development, Footer Anatomy, Menu, Configuration, Presets, Responsive Behavior, Privacy and Security, Footer Conflicts, Troubleshooting, and Publishing.

Include these install commands:

```bash
pi install npm:pi-atelier
pi -e ./pi-atelier
```

Include a complete `pi-atelier.json` example using only supported keys, explain user/project paths and trust, state that only one custom footer can win by load order, and disclose that the extension executes local `git status` without networking.

Create `CHANGELOG.md` with a `0.1.0` section listing footer, metrics, menus, presets, configuration, privacy, and compatibility. Create an MIT `LICENSE` with copyright year 2026 and holder Michael.

- [ ] **Step 2: Run the complete deterministic check suite**

Run: `npm run check`

Expected: TypeScript, Biome lint, Biome format, and all Vitest tests pass with zero failures.

- [ ] **Step 3: Inspect package contents**

Run:

```bash
npm pack --dry-run --json > /tmp/pi-atelier-pack.json
node -e '
const report=require("/tmp/pi-atelier-pack.json")[0];
const names=report.files.map(f=>f.path);
for (const required of ["extensions/index.ts","src/metrics.ts","src/config.ts","src/footer.ts","src/state.ts","src/menu.ts","README.md","LICENSE"]) {
  if (!names.includes(required)) throw new Error(`missing ${required}`);
}
for (const forbidden of ["node_modules","tests/","docs/superpowers",".git/"]) {
  if (names.some(name=>name.startsWith(forbidden))) throw new Error(`forbidden package path: ${forbidden}`);
}
console.log("package contents verified");'
```

Expected: `package contents verified`.

- [ ] **Step 4: Build and smoke-test the actual tarball**

Run:

```bash
rm -f pi-atelier-0.1.0.tgz
npm pack
TMP_DIR=$(mktemp -d)
cd "$TMP_DIR"
npm init -y >/dev/null
npm install /Users/michael/pi-atelier/pi-atelier-0.1.0.tgz --ignore-scripts
node -e 'const p=require("./node_modules/pi-atelier/package.json"); if (p.pi.extensions[0] !== "./extensions/index.ts") process.exit(1); console.log("clean install verified")'
```

Expected: npm installation succeeds and prints `clean install verified`.

- [ ] **Step 5: Perform interactive Pi smoke tests**

From `/Users/michael/pi-atelier`, run `pi -e .` and verify manually:

1. Footer appears below the editor.
2. Operational metrics match the built-in footer after one turn.
3. Resize terminal through widths 160, 100, 80, 56, and 40; no line wraps or overflows.
4. `alt+a` and `/atelier` open the same menu.
5. Model, thinking, tools, display, rename, and compaction actions behave as documented.
6. `/reload` leaves one footer and one shortcut registration.
7. `/atelier disable` restores Pi's built-in footer.
8. Project config is ignored in an untrusted project and applied after trust.

Record any failure as a test before fixing it; rerun `npm run check` after each fix.

- [ ] **Step 6: Run security and repository hygiene checks**

Run:

```bash
git diff --check
git status --short
rg -n 'fetch\(|https?://|auth\.json|sessions/|run-history|BEGIN .*PRIVATE KEY|api[_-]?key|access[_-]?token' extensions src package.json README.md
```

Expected: no whitespace errors; only intentional documentation URLs appear; no credential/session paths or token handling exist in runtime source.

- [ ] **Step 7: Commit the release candidate**

```bash
git add README.md CHANGELOG.md LICENSE package.json package-lock.json extensions src tests
git commit -m "docs: prepare Pi Atelier 0.1.0"
```

- [ ] **Step 8: Final verification**

Run:

```bash
npm run check
git status --short --branch
git log --oneline --decorate -8
```

Expected: all checks pass, working tree is clean except the ignored tarball if retained, and the task commits are visible in order.
