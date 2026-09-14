# Provider Usage Sidebar Integration Design

**Date:** 2026-09-15  
**Repositories:** `michaelmjhhhh/pi-atelier`, `fgrehm/pi-ollama-cloud`, `monotykamary/pi-hypercharm-provider`

## Summary

Pi Atelier will host structured usage panels contributed by Ollama Cloud and HyperCharm through its existing `pi.events` sidebar seam. The seam will gain capability-negotiated default visibility and placement so supporting providers can appear immediately after Atelier's built-in **Usage** panel without hard-coded vendor knowledge.

Both providers will make `sidebar` their default usage-display mode. If a compatible Atelier host is not loaded, Ollama Cloud will fall back to its footer status and HyperCharm will fall back to its below-editor widget. Existing explicit settings continue to win.

## Goals

- Show one usage panel for the active Ollama Cloud or HyperCharm provider.
- Keep the provider panels structured, theme-aware, compact, and configurable through Atelier.
- Preserve useful output when Atelier is absent or too old to support default placement.
- Avoid direct package dependencies between the three extensions.
- Preserve existing polling, authentication, cancellation, and provider-state behavior.
- Keep the sidebar protocol generic enough for future contributors.

## Non-goals

- Parsing or capturing arbitrary `setStatus` or `setWidget` output.
- Adding provider-specific conditionals to Pi Atelier.
- Creating a shared npm package for the event protocol.
- Changing usage APIs, polling frequency, pricing, or account semantics.
- Showing inactive-provider or stale last-known usage.
- Publishing releases or opening upstream pull requests as part of the design phase.

## Terms and Ownership

- **Sidebar host:** Pi Atelier, which discovers, validates, stores, configures, and renders contributions.
- **Provider adapter:** provider-owned code that maps existing usage state to the sidebar wire format and manages fallback UI.
- **Contribution:** presentation-only panel data sent over `pi.events`.
- **Compatible host:** an Atelier instance whose discovery event advertises the default-placement capability.

Atelier owns framing, sanitization, truncation, layout, and theme roles. Providers own data fetching, domain formatting, visibility eligibility, and update timing.

## Sidebar Protocol Extension

The event channel remains:

```text
pi-atelier:sidebar-panels
```

The current protocol remains valid. Discovery gains an optional capabilities list, and contributions gain optional defaults:

```ts
interface SidebarPanelDiscoveryEvent {
  version: 1;
  type: "discover";
  requestId: string;
  capabilities?: readonly string[];
}

interface SidebarPanelContribution {
  id: `${string}:${string}`;
  title: string;
  rows: readonly (string | SidebarPanelRow)[];
  role?: SidebarPanelRole;
  defaults?: {
    visible: boolean;
    after?: BuiltinSidebarPanelId;
  };
}
```

Pi Atelier will advertise the exported capability `SIDEBAR_PANEL_DEFAULTS_CAPABILITY = "panel-defaults-v1"`. Providers must see that exact value before suppressing fallback UI or sending default-placement metadata. Restricting `after` to built-in panel IDs avoids contributor ordering cycles.

The additive shape preserves existing contributors:

- Existing contributors may ignore discovery capabilities and continue publishing ordinary panels.
- Existing contributions without `defaults` remain hidden until users enable them, matching current behavior.
- New providers do not consider an older Atelier compatible because its discovery event lacks the capability; legacy UI remains visible.
- Invalid default metadata is ignored while otherwise valid panel content remains registerable and hidden by default.

No provider imports Pi Atelier. Each repository keeps a small local adapter for the wire contract.

## Default Layout Semantics

A contribution with:

```ts
defaults: { visible: true, after: "usage" }
```

is inserted into Atelier's effective sidebar layout immediately after the built-in **Usage** panel when its ID is absent from saved configuration.

Rules:

1. An explicit saved entry for the panel ID always controls visibility and order.
2. A default-visible contribution missing from saved layout is inserted only into the effective runtime layout; discovery alone does not rewrite configuration.
3. Atelier's settings UI shows that effective entry as visible and allows the user to hide or reorder it. Saving settings creates an explicit entry.
4. Contributions targeting the same anchor are ordered deterministically by panel ID.
5. If the requested anchor is unavailable, the contribution is placed at the end.
6. Unavailable saved contributions remain in settings as they do today.

The provider panels are optional under height pressure and use the existing contributed-panel drop behavior.

## Provider Adapter Lifecycle

Provider adapters subscribe to sidebar discovery during extension factory initialization, before `session_start`. Pi completes extension factory initialization before dispatching session lifecycle events, so discovery remains load-order independent.

For a provider configured with `sidebar` display:

1. Compatible discovery marks the host available and clears legacy fallback output.
2. Valid data for the active provider emits a register event using a stable panel ID and default placement after `usage`.
3. New data emits an update with the next source revision.
4. Provider deactivation, unavailable data, display-mode changes, or shutdown emits unregister and clears legacy output.
5. If compatible discovery is not observed, the adapter renders the provider's legacy fallback.
6. Later compatible discovery replaces fallback with the sidebar contribution without requiring a restart.

The adapters must not publish panels or start display-only work in non-TUI modes.

## Ollama Cloud

### Configuration

Add:

```ts
type UsageDisplay = "sidebar" | "statusbar" | "off";
```

Resolution precedence:

1. Explicit `usageDisplay`.
2. Explicit legacy `usageStatus: true` maps to `statusbar`; `false` maps to `off`.
3. No explicit setting defaults to `sidebar`.

`/ollama-usage-status` accepts `sidebar`, `statusbar`, and `off` while retaining existing `on`, `off`, `enable`, `disable`, and no-argument toggle forms. Enabling or toggling on selects the new default `sidebar` mode; `statusbar` remains explicitly selectable.

When `sidebar` is selected without a compatible host, the effective fallback is `statusbar`. There must never be simultaneous sidebar and statusbar output.

### Presentation

- **ID:** `ollama-cloud:usage`
- **Title:** `Ollama Cloud`
- **Placement:** visible by default after `usage`
- **Rows:** one row for every bucket present in the API response, preserving API order: `5h`, `7d`, and/or `30d`
- **Row form:** `5h  ▕████░░░░░░▏ 40%`
- **Roles:** success below 60%, warning from 60%, error from 80%

The existing fetch cadence, throttling, response-shape support, API-key resolution, and quiet transient-error behavior remain unchanged. Missing credentials or failed usage fetches withdraw the panel.

## HyperCharm

### Configuration

Extend:

```ts
type DisplayMode = "sidebar" | "widget" | "statusbar" | "off";
```

Both `session` and `account` default to `sidebar`. Existing explicit `widget`, `statusbar`, and `off` settings remain authoritative. `/hypercharm-status session sidebar` and `/hypercharm-status account sidebar` select the new mode.

Each part remains independently targetable. A part explicitly configured for widget or statusbar continues using that destination. A sidebar-targeted part falls back to the widget when no compatible host exists. The same metric must not appear in two destinations.

Sidebar contributions are always limited to the active HyperCharm provider, regardless of the legacy `hideOnOtherProvider` option. Legacy display modes retain their current setting behavior.

### Presentation

- **ID:** `hypercharm:usage`
- **Title:** `HyperCharm`
- **Placement:** visible by default after `usage`
- **Rows (layout C):**
  1. Session spend and request count: `⚡ 1.24 hc · 7 req`
  2. Balance: `◆ 249 hc`
  3. Available hourly/daily limits and OAuth days remaining: `996/1k/h · 8.2k/10k/d · 29d`

Missing account atoms are omitted rather than replaced with placeholders. The panel is hidden until HyperCharm activity produces valid display data. The team name is never included in the sidebar contribution; legacy widget/statusbar formatting is otherwise unchanged.

Session rows use a subdued semantic role. Balance and account rows retain the configured low-balance warning threshold. Existing optimistic balance updates, response usage capture, account refresh, stale-context handling, abort behavior, and out-of-credits notification remain unchanged.

## Failure and Compatibility Behavior

- No compatible Atelier: render the configured provider fallback.
- Older provider with new Atelier: retain the provider's existing UI behavior.
- Usage/auth/network failure: silently withdraw or omit the panel.
- Provider switch: unregister the old provider panel immediately.
- Malformed, oversized, stale-revision, or source-conflicting contribution: Atelier ignores it.
- Sidebar disabled or a panel explicitly hidden: do not activate provider fallback; compatible Atelier is still present and the user's choice is authoritative.
- Session replacement and reload: dispose listeners, timers, publishers, and UI state through each extension's existing lifecycle protections.

## Verification

### Pi Atelier

Tests will cover:

- Existing version-1 contributors and discovery replay.
- Capability advertisement and validation of optional defaults.
- Default insertion immediately after `usage`.
- Explicit hidden and reordered saved entries overriding defaults.
- Deterministic ordering for multiple contributions sharing an anchor.
- Settings visibility and persistence of an effective default panel.
- Registration, update, unregister, stale revision, malformed input, and teardown.
- Semantic row rendering and narrow-sidebar truncation.

### Ollama Cloud

Tests will cover:

- New mode parsing and legacy boolean migration.
- Command aliases and mode transitions.
- Compatible discovery versus statusbar fallback.
- Every supported bucket combination and semantic threshold.
- Active-provider gating, failed fetch withdrawal, updates, and cleanup.
- Mutual exclusion of panel and footer status output.

### HyperCharm

Tests will cover:

- Four display modes and legacy configuration values.
- Compatible discovery versus widget fallback.
- Independent session/account destination combinations.
- Layout C, omission of unavailable atoms, and absence of team name.
- Active-provider gating, low-balance role, updates, and cleanup.
- Mutual exclusion for each metric across panel, widget, and statusbar.

Each repository will use a fake `pi.events` bus to test its side of the wire contract. Atelier fixtures will consume representative provider payloads. After targeted suites and each repository's full check command pass, a local TUI smoke test will load all three development checkouts and verify provider switching, fallback suppression, ordering, and settings behavior.

## Repository and Delivery Workflow

Forks under `sekhnat`:

- `sekhnat/pi-atelier`, upstream `michaelmjhhhh/pi-atelier`
- `sekhnat/pi-ollama-cloud`, upstream `fgrehm/pi-ollama-cloud`
- `sekhnat/pi-hypercharm-provider`, upstream `monotykamary/pi-hypercharm-provider`

Development checkouts live under `/home/caan9/Projects/`; installed npm/git package directories are not edited.

Branches:

- Pi Atelier: `design/provider-usage-sidebar` for this specification, followed by a focused implementation branch selected by the implementation plan.
- Both providers: `feat/pi-atelier-sidebar`.

The implementation plan will order work protocol-first: Atelier contract and tests, then Ollama adapter, then HyperCharm adapter, then cross-repository smoke verification. Release publication and upstream pull requests require separate approval after implementation review.
