# Issue #69: agent usage attribution and pi-subagents integration

Status: original full-scope proposal, superseded for the first implementation by the user's simpler metadata-only scope.

**Implemented scope (after user revisions):** graph-only per-child cumulative cost history from owner-validated native pi-subagents accounting events, reconciled against saved metadata. All readable histories are plotted with colored legends, smooth native images where supported, keyboard point inspection and Control Center/direct-command entry points. Token/model/reasoning tables and saved-total summaries are intentionally omitted. No upstream changes or combined main/child ledger. Missing histories remain unavailable. The broader contract and implementation gates below are retained as future research, not requirements for this version. See `docs/usage.md` and `docs/issue-69-manual-verification.md`.

Worktree: `/Users/michael/pi-atelier-issue-69`
Branch: `plan/69-agent-usage-breakdown`
Baseline: `main` at `e56e7209fbe0c0b9a1e2b608d4515cfa61a2d81b` (Atelier 0.11.2).
Reviewed: 2026-09-25.

## Objective and scope

[Issue #69](https://github.com/michaelmjhhhh/pi-atelier/issues/69) requires session usage to be attributable to main-agent work and individual subagent runs, with model and reasoning-level groupings, proportional diagrams, and totals that reconcile. The integration target is `nicobailon/pi-subagents`, including synchronous and asynchronous execution.

This is an accounting change before it is a rendering change. Implementing bars directly over the existing aggregate would preserve missing usage and introduce ambiguous attribution. Build a single usage ledger, adapt the actual producer records into it, then derive both existing totals and new views from that ledger.

The proposal is independent of `feat/76-responsive-sidebar`. If #76 lands first, rebase the implementation and recheck sidebar composition; do not copy its branch changes into this worktree.

## Verified Atelier and Pi behavior

- `src/state.ts:refreshUsage()` currently scans all session entries but selects only assistant messages. `src/metrics.ts:aggregateMetrics()` discards identity and sums input, output, cache read/write and recorded cost. This explains both missing subagent spend and missing groupings.
- Pi 0.84.0, the development dependency and minimum supported version here, includes assistant usage, nested `toolResult.usage`, and compaction/branch-summary usage in its session totals. It uses **all entries**, not only the active branch. [Pi session statistics](https://github.com/earendil-works/pi/blob/a5f43bf8aff3c55752432655f7334e3dafd1e256/packages/coding-agent/src/core/agent-session.ts#L3117-L3178)
- Each entry has an `id` and `parentId`; model and thinking changes are session entries. The effective reasoning level for a message must be resolved along its ancestors. Chronological carry-forward across the entire file is wrong when the user returns to an earlier branch. [Pi session entry definitions](https://github.com/earendil-works/pi/blob/a5f43bf8aff3c55752432655f7334e3dafd1e256/packages/coding-agent/src/core/session-manager.ts#L46-L94)
- Assistant messages carry provider/model and usage, but no reasoning-level field. Tool usage has totals but does not itself identify a child run/model/level. [Pi message definitions](https://github.com/earendil-works/pi/blob/a5f43bf8aff3c55752432655f7334e3dafd1e256/packages/ai/src/types.ts#L412-L447)
- Pi invokes extension `message_end` handlers **before** appending that message to the session manager. Reading entries synchronously inside that handler misses the new record. [Pi event/persistence order](https://github.com/earendil-works/pi/blob/a5f43bf8aff3c55752432655f7334e3dafd1e256/packages/coding-agent/src/core/agent-session.ts#L610-L660)
- Atelier's current sidebar composition has height-based group removal. Its usage panel does not currently branch on density. The new panel must explicitly implement density and a bounded height policy; merely adding more rows is insufficient.
- The existing sidebar contribution event protocol carries rendered rows. It is unsuitable as a usage/accounting protocol: it lacks usage identity, persistence, provenance, and reconciliation semantics.

Pi 0.87.0 additionally has standalone `usage` entries carrying kind/provider/model/usage, for work such as cache warming. The adapter must structurally recognize these while still compiling against 0.84.0; do not silently omit them on the Pi version used by current upstream. Attribute their agent category to Pi auxiliary work and reasoning to unknown unless explicitly recorded. [Entry shape](https://github.com/earendil-works/pi/blob/16787ad5b2dc748047f314ca1bfe7708f30f54f3/packages/coding-agent/src/core/session-manager.ts#L80-L90), [aggregation](https://github.com/earendil-works/pi/blob/16787ad5b2dc748047f314ca1bfe7708f30f54f3/packages/coding-agent/src/core/agent-session.ts#L3804-L3843).

Documentation was checked with Context7 and then against pinned Pi source. CLI isolation flags were also checked directly in installed Pi 0.84.0 CLI/resource-loader source.

## pi-subagents: supported evidence and actual gaps

Investigation target: commit `2e9c51bada2da6a9ba73b6973e1545a9afa0d057`, repository package version 0.71.0. This is a source pin, not a claim that an npm release has the same contents. See [the detailed source research](../issue-69-subagents-research.md).

| Surface | What exists now | Integration decision |
| --- | --- | --- |
| Foreground result | `Details.runId`, child `index`, reported model/thinking, direct usage, session/artifact references | Adapt persisted details. Identify an execution by invocation plus child coordinates, not agent name or session path. |
| Workflow / slash result | Workflow rows retain `workflowKey`; slash custom messages wrap `{requestId, result}` and persist initial/final snapshots | Workflow root plus index can collide because independent children each use index 0: use workflow child-run evidence. Collapse slash snapshots by request/run identity. |
| Native tool usage | `subagent` projects the sum of direct result usage onto the Pi tool result | Count once; use details to partition this same sum. |
| Async completion | `subagent:async-complete` carries full results, model/thinking/usage and ownership | Consume passively; validate originating session/run; persist a bounded accounting-only projection for future reloads. |
| `bg_wait` / replay | Child usage/model/run references survive, but thinking/index are omitted by the projection | Reconcile with richer data by proven identity; retain unknown fields when unavailable. Repeated waits are observations, not new spend. |
| Durable notification | `subagent-notify` currently persists formatted content and display, without structured accounting details | Never parse notification text to reconstruct spend. This needs producer-side preservation for reliable independent replay. |
| Public RPC `cost` v1 | Active-branch parent/child/total report, no per-model/effort buckets, narrower identity/deduplication | Do not use as canonical ledger or add its total. At most use capability discovery and a scoped diagnostic comparison. |
| Nested children / summary work | Direct `result.usage` excludes nested tool and compaction usage; `totalCost` can include nested cost but lacks full cache attribution | These are different scopes. Do not substitute or add `totalCost` as a full usage vector. Mark missing coverage until the producer supplies a disjoint accounting projection. |

Source anchors: [foreground metadata and assistant usage](https://github.com/nicobailon/pi-subagents/blob/2e9c51bada2da6a9ba73b6973e1545a9afa0d057/src/runs/foreground/execution.ts#L460-L474), [direct tool-usage projection](https://github.com/nicobailon/pi-subagents/blob/2e9c51bada2da6a9ba73b6973e1545a9afa0d057/src/runs/foreground/subagent-executor.ts#L3073-L3087), [compaction of result payloads and nested cost scope](https://github.com/nicobailon/pi-subagents/blob/2e9c51bada2da6a9ba73b6973e1545a9afa0d057/src/shared/utils.ts#L366-L410), [cost collector](https://github.com/nicobailon/pi-subagents/blob/2e9c51bada2da6a9ba73b6973e1545a9afa0d057/src/slash/subagent-cost.ts#L152-L216), [notification persistence](https://github.com/nicobailon/pi-subagents/blob/2e9c51bada2da6a9ba73b6973e1545a9afa0d057/src/runs/background/notify.ts#L593-L606).

The reported foreground model starts from the resolved launch model and is not a persisted per-response breakdown. Completed foreground results remove their message list. Model/thinking labels are therefore useful for ordinary fixed-configuration runs, but do not prove that every response used that configuration. Do not claim exact per-response attribution after fallback/model/effort changes unless richer evidence exists. A missing provider must remain unknown if the producer reports only an unqualified model name. [Initialization](https://github.com/nicobailon/pi-subagents/blob/2e9c51bada2da6a9ba73b6973e1545a9afa0d057/src/runs/foreground/execution.ts#L460-L474), [message accounting/model handling](https://github.com/nicobailon/pi-subagents/blob/2e9c51bada2da6a9ba73b6973e1545a9afa0d057/src/runs/foreground/execution.ts#L1072-L1105).

### Recommended cooperation with upstream

Use existing event/result surfaces; do not invent a parallel RPC framework, take over tool registration, change tool output, or intercept execution. Ask upstream to preserve a **versioned accounting projection** consistently through foreground details, async terminal payloads, notification details, wait results and durable replay. Proposed fields (a new additive projection, not fields claimed to exist today):

- Origin session ID; invocation ID; child/step ID; attempt/execution ID; parent-child relation. A continuation in the same child session is another execution, with its own usage interval.
- Monotonic snapshot revision and finality; explicit `direct` versus `inclusive` coverage. Prefer disjoint direct execution records so descendants can be summed once.
- Buckets of actual provider/model/effective reasoning level and full numeric usage, with an explicit unknown bucket where unavailable. Include consumed failed attempts and auxiliary work; identify incomplete reporting.
- The same accounting identity and revision wherever work is observed. Tool-level aggregate usage declares which child records it covers. This lets Atelier correlate event, tool result, wait result and persisted replay without heuristics.
- Persist this projection before announcing completion. Retain it independently of TTL-bound prompt/output artifacts. If a result belongs to an inactive session, retain it under that origin and replay when the origin becomes active; never append it to the current unrelated session.

The smallest upstream first step is to preserve existing owner/run/child identity, model/thinking and usage in notification/replay/wait metadata. Per-response buckets and complete nested/auxiliary coverage are the next part required for the strongest acceptance guarantee. Prefer implementing that projection once near execution accounting and reusing it in all transports.

Atelier can preserve its own normalized projection from live events in `pi.appendEntry("pi-atelier:usage-v1", ...)`, after checking the active session's identity and deduplicating the work/revision. Those entries are accounting metadata only and do not enter LLM context. This supports sessions observed by Atelier, including reload. It cannot recover an event missed while Atelier was absent/disabled or data already deleted by upstream. Re-enable must replay durable source records; unavailable coverage stays explicit. Document this metadata persistence in Privacy.

Do **not** make global async-directory scans or raw child-transcript import the default fallback. Child sessions may include copied parent history or multiple executions; summing the whole file would double-count both. If a later compatibility reader is needed, require an explicit producer-owned artifact reference, verified session/run ownership, a known execution interval, bounded regular-file reads and cancellation; never import inherited history. Missing/expired files produce partial coverage. This is less reliable and more coupled than the small producer change, so it is excluded from the first implementation.

### Version policy

- Preserve Atelier's Pi >=0.84.0 base support for native accounting.
- Verify combined integration on Pi 0.87.0, the upstream development pin. Current upstream declares optional `pi-ai >=0.86.1`; do not advertise its current source as compatible with a Pi 0.84.0 installation. [Upstream package requirements](https://github.com/nicobailon/pi-subagents/blob/2e9c51bada2da6a9ba73b6973e1545a9afa0d057/package.json#L63-L103)
- Detect payload/capability versions at the adapter. No mandatory runtime dependency on `pi-subagents`. Legacy/unknown shapes degrade to native totals and explicit unavailable attribution.
- Record supported source/package versions in documentation and use real producer-derived fixtures. Do not claim support for every historical `pi-subagents` version based on structural guesses.
- Historical records that never persisted attribution cannot be made exact retroactively. Full issue completion requires the new producer projection for new work; the current-source compatibility mode must be labelled partial where evidence is missing.

## Accounting decisions

1. **Scope is the current session file's retained history.** Preserve existing `getEntries()` semantics, including other branches and entries summarized by compaction. Navigating the tree must not remove already-recorded usage. A forked session counts its own copied history, matching Pi; it is not a cross-session billing report.
2. **Main means direct main-agent work.** Child work belongs to individual subagent runs, never both their own row and a rolled-up Main row. The session total is Main + child runs + other nested tools + Pi auxiliary work (including summaries). Represent auxiliary work and unknown tool attribution explicitly so reconciliation is possible.
3. **Existing total displays become complete recorded totals.** Both USAGE and the footer use the ledger total. Preserve the old assistant-only amount as the Main subtotal. This intentionally increases the total when previously omitted work is discovered; document the change. Do not keep the old number and claim child groups sum to it.
4. **Model identity is provider plus model.** Identical model names from two providers stay separate. Use the assistant message's actual identity; model-change entries are contextual fallback only. Do not resolve historical aliases through today's model registry or assign the current model to old messages.
5. **Reasoning level is a configuration attribution, not a new token count.** Resolve main-message levels through the parent chain, using memoized ancestry. Preserve explicit `off`; missing evidence is `unknown`. Pi's reasoning-token count, if present, is already part of output and must not be added again. Child reasoning cannot inherit the parent's level.
6. **Cache remains two counters.** Preserve cacheRead and cacheWrite in the ledger; a compact `C` value means their sum, with both values visible in details. Preserve the current last-main-response cache-hit calculation separately from cumulative spend and from the live context-window gauge.
7. **Recorded cost is authoritative only for its recorded coverage.** Do not reprice old usage with current catalog prices or infer billing from the current OAuth provider. Missing cost is unknown, not free. A partially priced group shows a known subtotal and a partial marker. Currency rounding occurs only at display time; arithmetic reconciliation is before rounding.
8. **Every breakdown is a partition of the same records.** Agent, model and reasoning views are alternative projections, not three amounts to add together. Unknown and Other buckets participate in sums. Keep uncertainty per dimension and numeric coverage separately: exact token totals can coexist with unknown reasoning.
9. **Failures may still spend tokens.** Include valid recorded usage from aborted, failed and retried attempts. Validate each external counter as finite and nonnegative; do not coerce malformed/missing counters into an apparently complete zero result.

## Proposed module and runtime seam

Add one accounting module, tentatively `src/usage-ledger.ts`, with a small interface: reconcile persisted session entries and optional producer snapshots; return an immutable usage snapshot. It owns attribution, source precedence, deduplication, coverage and group projections. Keep `pi-subagents` shape validation in an internal adapter (`src/usage-sources/pi-subagents.ts`) so upstream changes do not spread into runtime or renderers. Do not import the upstream extension's private implementation.

A normalized record needs a stable source/work identity, originating parent session, agent run identity and display name, optional provider/model/reasoning, input/output/cacheRead/cacheWrite/cost with availability, revision/finality, and provenance. Preserve invocation, chain-step and parallel-member identity separately from the human-readable agent name. Store only usage metadata; no prompts or response content.

For native Pi records, persisted entry ID is the usage identity. For recognized child producer records, explicit invocation/run/attempt IDs identify the underlying work; native tool entries are containers representing that work, not additional executions. Legacy identities must be derived from the persisted invocation/tool-call identity plus stable child coordinates. A child session path alone is insufficient because follow-up executions can reuse it. When an async payload drops child coordinates and two children cannot be distinguished, retain a run-level unattributed subtotal rather than guessing from result order or names.

Reconciliation rules:

- Treat aggregate tool usage and its detailed child records as two representations of the same work. Select one canonical numeric source per covered work unit; never add both.
- Use detailed records to partition a matching authoritative aggregate. If aggregate coverage is known and details cover only part, retain the positive residual as unattributed work. If they conflict, preserve authoritative totals, mark the attribution conflict and avoid manufacturing negative residuals or scaling child costs.
- Do not match records by task text, agent name, timestamps alone, cost equality, or file basenames. Do not subtract cumulative snapshots unless they have the same identity and a declared compatible scope.
- Progress snapshots **replace** the prior snapshot for the same work unit. A final snapshot replaces provisional progress. A repeated final result, status query, replay or completion event must be idempotent.
- A reader can return a known subtotal with incomplete coverage; it must never imply that unavailable async work cost zero.
- For legacy payloads without revisions, final persisted results outrank transient progress; correlate mirrored sources only where identity is proven. Do not use maximum counter values as an ordering algorithm: a valid final reconciliation may correct an earlier observation downward.

Runtime integration belongs in `src/state.ts` and `extensions/index.ts`:

- Reconstruct from persisted data at session start, resume/reload, fork/session replacement and re-enable. Reset all session-owned caches and pending work on replacement/shutdown using the existing lifecycle generation guard.
- Refresh at existing reliable post-persistence points (`turn_end`, `session_compact`, etc.) and on `session_tree`; the latter changes ancestry context even though accumulated session spend remains stable.
- A `message_end` event marks accounting dirty; it must not synchronously assume the record is persisted. For idle async completion, require a producer notification after its durable usage record is written, or run one coalesced reconciliation task that checks for the expected record before publishing. Do not rely on a microtask as a persistence guarantee. Failure to observe the record leaves coverage pending and is retried on the next lifecycle refresh.
- For new main requests, capture the Pi thinking level at dispatch (`before_provider_request`) and correlate it with the eventual persisted assistant entry, retaining an accounting-only attribution record if needed. A settings change during streaming must not relabel the in-flight response. Ancestry windows are the historical fallback; if a request association is ambiguous, use unknown rather than the latest setting. “Reasoning level” means the Pi configuration associated with the request, not a claim about a provider's hidden reasoning budget.
- Subscribe to upstream observer events early enough for either extension load order; buffer only bounded metadata while Atelier initializes, then accept it only if owner/session generation still match. Detach/foreground-to-background handoff, workflow child completion and workflow root completion may describe overlapping work: correlate their explicit identities. A local metadata-persistence failure must leave durability marked incomplete rather than imply successful replay.
- Add live usage only where the producer supplies a stable snapshot identity. Throttle/coalesce updates and keep them explicitly provisional until canonical completion. Do not turn every text-stream delta into a full-history scan.
- Keep session scans and any integration I/O out of `render()`. Incrementally process immutable entry IDs; rebuild on session replacement or detected history mismatch. Memoize parent attribution; bound raw adapter payload sizes and visible rows without silently dropping accounted spend.
- Suspending Atelier stops its producers/listeners/timers; re-enable reconstructs from durable data. The adapter is optional: absence of `pi-subagents` leaves ordinary Pi usage fully functional.

## Sidebar and full-view behavior

Add built-in `usage-breakdown` immediately after `usage` in the product default order; wire the ID into `src/types.ts`, `src/sidebar-panels.ts`, normalizers, Settings and documentation. Respect saved relative ordering and visibility. Older layouts append the new panel using the existing normalization convention; hidden `usage` does not implicitly hide an independently configured breakdown panel.

The sidebar shows one selected grouping, default **By agent**, with a label stating **bars = output tokens**. Use output consistently even when price is unavailable; do not silently change the bar metric by group. All-zero output produces empty bars, not a divide-by-zero or fabricated share. Sort by output descending with stable identity as a tie-breaker.

- Compact: name/bar followed by one counter line (`I`, `O`, `C`, `$`); comfortable: name, bar, and counters on separate lines. Use the existing token-formatting conventions, currency precision and palette roles. Bars and labels work in Plain-text, Nerd Font and `NO_COLOR` modes.
- Limit the sidebar to three named groups plus an exact `Other (N)` roll-up; shrink the named-group budget on short terminals. The roll-up preserves totals. Show a concise partial/unknown indicator where relevant.
- Extend `/atelier` with `/atelier usage`, opening a read-only, scrollable breakdown view. Provide Agent / Model / Reasoning selectors, all groups, and agent drill-down to model/level leaves. Choosing a grouping updates the sidebar for the current session; no new persistent preference is required for v1. A menu entry makes the view discoverable.
- Keep the full view available when the sidebar is hidden or too narrow. Reuse existing overlay lifecycle/focus handling. Long names are display-width truncated and control characters sanitized; full identities can be shown in details.
- Breakdown detail rows drop before essential Agent/Activity/Context rows and before the existing USAGE total. Preserve a summary row when space permits; at extreme heights follow the sidebar's existing omission policy. Do not make the new panel an unbounded required group.

Tentative UI files: `src/sidebar.ts`, a focused `src/usage-view.ts`, `src/menu.ts`, `extensions/index.ts`; state fields in `src/types.ts`. The renderer consumes the ledger snapshot and never parses upstream results itself.

## Verification policy

Automated tests are for the non-TUI accounting/adapter behavior only. Per AGENTS.md, do not add unit, snapshot or end-to-end tests for the sidebar, full-view rendering, keyboard handling or other TUI changes. Verify those manually with the TODO list below. Existing repository checks still run.

Accounting acceptance cases:

- Main-only history matches the old assistant subtotal; every grouping reconciles before display rounding.
- Mixed providers/models and reasoning changes, including changes on sibling branches, missing ancestors, explicit off, missing levels, compaction and branch-summary usage.
- Repeated agent names, parallel siblings, repeated chain steps, follow-up invocations reusing a child session, and failed/aborted/retried work remain distinct.
- Workflow children each numbered index 0, slash initial/final snapshots, awaited child plus workflow-root completion, and foreground-to-background detach do not collide or double-count. A main thinking-level change during streaming affects the next request, not the in-flight record.
- Aggregate plus details, repeated progress, repeated completion, status queries, stale revisions and reload do not add the same work twice.
- Missing prices and missing identity dimensions remain visibly incomplete; valid zero stays zero; malformed numbers and oversized shapes fail without crashing the host.
- Late async completion from session A cannot alter session B. Disable/re-enable and replay reconstruct the same final snapshot.
- Fixture replay at the accounting seam covers each supported upstream mode and producer version. Include unavailable/incompatible producer shapes and exact source-precedence conflicts.
- Workload probe with many entries and updates confirms no history parsing or file access during rendering and no accumulating listeners/timers.

Run `npm run typecheck`, relevant non-TUI accounting tests, formatting checks and package verification; run the existing suite as a regression check without adding TUI cases. Compare native coverage with Pi's `/session` statistics (or `getSessionStats()` in a non-TUI harness); explain any adapter-only supplementation rather than expecting Pi's unmodified totals to know about legacy private details.

Manual TUI TODO after implementation:

- [ ] Verify both densities, Plain-text/Nerd Font, light/dark themes and `NO_COLOR`; long Unicode names and small/large/zero values.
- [ ] Reorder/hide/show the panel in Settings, save/reload, and load a pre-feature layout.
- [ ] Change grouping, inspect every repeated run and model/level leaf in the full view, scroll and close it; editor focus and existing overlays recover correctly.
- [ ] Resize short/narrow and tall/wide terminals in regular/fullscreen modes. Confirm Other counts, row removal order and total visibility; recheck after #76 merges.
- [ ] Run synchronous single/parallel/chain tasks and asynchronous tasks with both extensions loaded in either order. Check upstream tool output/widgets/commands still behave normally.
- [ ] Exercise abort/error/retry, model/thinking changes, compaction, tree navigation, fork, `/reload`, disable/re-enable and session switching during an async run.
- [ ] Compare visible totals with raw supported usage records, including cache writes and unknown/partial cost; verify the absence of new network requests by Atelier.

Atelier-only temporary session (after implementing and installing dependencies in this worktree):

```sh
pi --no-session --no-extensions -e /Users/michael/pi-atelier-issue-69/extensions/index.ts
```

`--no-extensions` disables automatic extension discovery while retaining explicit `-e` paths, so the globally installed Atelier is excluded. This is a future verification command; no TUI changes have been made in this planning worktree.

Integration QA on compatible Pi, after preparing a dependency-installed clone at the reviewed upstream pin (or the projection-supporting revision):

```sh
ATELIER_QA_SESSIONS=$(mktemp -d)
pi --session-dir "$ATELIER_QA_SESSIONS" --no-extensions \
  -e /Users/michael/pi-atelier-issue-69/extensions/index.ts \
  -e /absolute/path/to/pinned-pi-subagents/index.ts
```

The second explicit extension is required for cooperation testing; no globally installed Atelier is loaded. Reverse the two `-e` options for the load-order check. Use explicit simple local agent definitions and disable sharing in the QA configuration; no real project changes are needed to exercise usage. Parent CLI extension isolation does not automatically configure child runtimes: configure child extension loading separately and verify it so children do not accidentally load an installed Atelier copy. Record the temporary session file for resume/reload tests. Do not delete its directory until verification is complete.

## Implementation sequence and completion gates

| Step | Deliverable | Gate before proceeding |
| --- | --- | --- |
| 1. Pin and replay evidence | Source-derived minimal fixtures for main Pi 0.84/0.87, foreground single/parallel/sequential workflow, async completion, repeated wait, continuation and nested work. Fixtures contain only accounting fields. | Demonstrate which source represents each work unit; reproduce the known replay/coverage gaps. |
| 2. Agree/preserve producer projection | Additive upstream accounting projection across existing result/event/persistence paths; document ownership, scope and revision rules. Separate upstream change proposal; no upstream write was made during this investigation. | A run completed with Atelier absent can be reconstructed after reload; model/effort and repeated-child identity survive; a stopped run retains consumed usage. |
| 3. Build native ledger | Normalize assistant/tool/summary/standalone usage, parent-chain thinking attribution, unknown coverage and projections. Integrate existing totals. | Non-TUI numeric invariants pass at both Pi baselines, including branch history and auxiliary usage. |
| 4. Integrate producer adapter | Current-source fallback plus projection-aware support, async accounting-entry persistence, precedence, replacement, replay and lifecycle cleanup. | No double-count across tool aggregate/details/events/waits; no cross-session contamination; exact support only where projection evidence is complete. |
| 5. Add presentation | Bounded `usage-breakdown`, full view, Settings/order/density/palette, command/menu entry and documentation. | Manual TODO list passes; essential panels and upstream UI behavior remain usable. |
| 6. Compatibility closeout | Run checks, pin compatibility matrix and document unavailable history, recorded-cost semantics, metadata persistence and intentional total increase. | Every issue criterion has evidence; no outstanding producer gap is hidden behind an “exact” label. |

Steps 2 and 3 can progress independently. Step 4's compatibility mode can be built against current upstream while the producer change is pending; full reliable attribution remains gated on its durable contract. This should be multiple focused changes, with the ledger first and rendering last. Do not close #69 on the basis of a main-only diagram or a live demo that cannot survive reload.

## Acceptance mapping

| Issue criterion | Planned evidence |
| --- | --- |
| Sidebar ordering/visibility | Built-in ID and migration path; manual Settings, save/reload and old-config checks. |
| Correct agent/model/reasoning | Non-TUI source fixtures, invocation identity, parent-chain attribution, preserved producer buckets and explicit unknown handling. |
| Cost reconciliation | One canonical record set; Main subtotal preserved; all projections plus Unknown/Other reconcile with the updated footer/USAGE total. Native-only coverage also matches the relevant Pi statistics. |
| Density and truncation | Manual compact/comfortable and width/height/Unicode matrix. |
| Plain-text/Nerd Font and palette | Manual font/theme/NO_COLOR matrix; no icon-dependent meaning. |
| No external requests | Local session data and existing in-process events only; no pricing lookup, telemetry, output sharing or extra provider calls by Atelier. |

## Decisions still requiring implementation evidence

These are explicit engineering gates, not unanswered product preferences: upstream must accept or otherwise provide the additive projection; fixtures must confirm effective per-response bucket coverage and child identities through every supported mode; combined QA must run on compatible Pi. If the producer change is unavailable, ship only the honestly labelled compatibility subset under a narrower scope and keep the full #69 acceptance gate open. Historical missing data remains unavailable under either approach.
