# Issue 69: subagent cost graph — manual verification

This checklist supersedes the earlier table, subtotal and character-only graph designs. No TUI unit or end-to-end tests were added. Automated new coverage is limited to metadata accounting and native event projection.

## Launch

Load the updated worktree and pi-subagents explicitly, disabling discovery of the installed Atelier:

```sh
pi --session-dir "$(mktemp -d)" --no-extensions \
  -e /Users/michael/pi-atelier-issue-69/extensions/index.ts \
  -e /Users/michael/.pi/agent/npm/node_modules/pi-subagents/index.js
```

Use Kitty or Ghostty for smooth native graphics. Keep temporary sessions for reload/resume checks. Metadata must be enabled in pi-subagents. Child runtimes have their own extension configuration.

## Test prompt

```text
使用 pi-subagents 启动一个后台并行 workflow，包含 3 个只读子代理：
1. readme-scout：阅读 README.md，然后再阅读 docs/usage.md，整理功能说明。
2. package-scout：阅读 package.json，然后再阅读 tsconfig.json，整理开发命令和配置。
3. usage-scout：阅读 src/subagent-cost-history.ts，然后再阅读 src/subagent-usage.ts，整理费用数据来源。
每个代理分两次工具调用读取文件，最后各输出约 300 字总结。不要修改文件，不要通过 sleep 拖延时间。启动后告诉我 workflow ID。
```

## TODO: visual checks

- [x] In an isolated Pi 0.87.1 PTY session (macOS arm64, 120 columns × 36 rows), `/atelier` → Subagent usage opened the bordered empty state; Escape returned to Control Center. `/atelier usage` opened the same empty state; Escape and exit completed normally. Only this checkout extension was loaded, with session-only trust and no model request.
- [ ] Repeat with populated histories and F6; check untrusted/disabled/session-switch paths.

- [ ] Sidebar and `/atelier usage` contain only a graph, matching numbered color legends and essential status text. No token table, per-agent cost list or saved-total block remains.
- [ ] In Kitty/Ghostty, curves are thin continuous smooth lines, with small dots at actual observations. There are no Braille gaps, box-character stairs or rungs joining different agents.
- [ ] Select a child, then press `[` / `]` through every actual observation. Verify the highlighted marker and time/cumulative-cost/reply-cost readout against native events, including the first/last point, one-reply children, zero-cost replies, different history lengths and text fallback. Synthetic zero is not counted as a reply.
- [ ] With 13 or more children, cycle Left/Right through every child, including the earliest one. Its legend page follows focus, while Up/Down changes only the legend page and preserves all curves.
- [ ] The usage dialog has four complete borders and padding. Left/Right dims other curves; A restores them; Escape closes and returns input to the editor.
- [ ] Resize wide/narrow/tall/short. Curves and legends remain inside their frame; tiny windows show a resize hint. An optional sidebar graph disappears as a whole if it cannot fit.
- [ ] Open the usage view, Settings and other capturing dialogs while a sidebar graph is visible. The background plot becomes reserved blank space with a close-dialog hint, never character stairs; title, legend and panel height remain stable. No sidebar image paints over the dialog. Closing restores the original graph without ghosts. Repeat in regular/fullscreen and non-image terminals.
- [ ] Close/reopen usage, reload, disable/re-enable Atelier and switch sessions. No old image remains. Check both regular and fullscreen layouts.
- [ ] In fullscreen mode, drag across multiple transcript rows containing colored tool results, including a drag ending in the sidebar. Only the transcript highlights; the sidebar keeps its original background and colors. Paste the selection elsewhere and confirm no sidebar text is included. Repeat after resize and reload, and with the usage dialog open/closed.
- [ ] In a terminal without Kitty graphics, confirm the character fallback. Check Nerd Font off and NO_COLOR, including single-agent keyboard focus.

## TODO: accounting and lifecycle

- [ ] Run the prompt above. Three separate children of the same `scout` type remain distinct by number and color. Curves appear on completed model replies and refresh while the parent is idle.
- [ ] Run a second batch. All readable child histories are plotted, including more than six. The title shows the total curve count. A bounded sidebar legend shows its visible range; open the expanded view and use Up/Down to see every legend entry. Colors and numbers stay stable as known children produce their first reply.
- [ ] Compare completed curve endpoints with the children's `_meta.json` costs. Repeated `bg_wait`, refresh and reload must not duplicate cost.
- [ ] Main USAGE/footer remain separate. A long-running local tool without model replies does not fabricate extra spend.
- [ ] Missing/disabled/expired metadata, unknown costs, oversized or mismatched histories produce partial/unavailable status. Foreground runs without native background events do not get invented curves.
- [ ] Switch sessions or disable Atelier while work is active. Old sessions do not leak histories into the new one, and retired runtimes stop refreshing.

## Evidence

- Original three-scout workflow replayed from existing native artifacts: 3 curves with 2, 2 and 3 charged replies; final costs $0.0254056, $0.0205456 and $0.0283936.
- Owner validation accepts pi-subagents' session-file identity and Pi's session UUID. Workflow roots are resolved to their child and continuation run IDs rather than charged as children themselves.
- Numeric projections discard event content and tool arguments. Accounting coverage includes duplicate events/sources, same-named steps, partial appends, unknown cost, read bounds/cancellation, ownership and final-metadata reconciliation.
- The native PNG renderer was previewed with the real three-child history. Interactive terminal placement, cleanup and resizing remain manual checks above.

## Review environment and observed evidence

- macOS arm64, repository SDK/Pi baseline 0.84.0; actual interactive host version and terminal cell dimensions were not recorded. The user's 2026-09-25 23:19 screenshot is 1952 × 1275 pixels.
- That screenshot confirms native sidebar curves, point markers and color legends rendered in the user's terminal. It predates removal of the six-curve cap and point inspection; populated-graph checks remain pending above. Control Center and direct-command navigation were subsequently exercised in the isolated 120 × 36 PTY session.
- The screenshot is local conversation evidence, not published in the repository. Native PNG rendering was also previewed against the original three-child history. Automated checks do not establish interactive placement/cleanup correctness.

![Native renderer preview with three real child histories](images/subagent-cost-preview.png)

This 1000 × 480 PNG is a renderer artifact, not an interactive terminal screenshot.

## Final review fixes

Accounting regressions now cover distinct replies sharing the same millisecond (including the origin), receipt-only continuation histories, and 40 small histories without the former 32-source cutoff. Per-file and per-refresh byte limits remain in effect; unavailable or limited graph data is explicitly marked partial. Raster blending visits touched pixels only, avoiding a full image scan per child.

## Background graph rendering fix

The user's 2026-09-26 screenshot shows smooth curves in the usage dialog but character stairs in the visible part of the sidebar. The sidebar had represented overlay occlusion by removing its image owner; the chart interpreted that as a reason to draw the text fallback. A separate `suspendPlot` state now reserves exactly the same plot/axis rows without drawing either native graphics or character curves. The stable image owner remains available for restoration. This is a TUI-only change; the screenshot is the failure evidence and the open/close checklist above is the manual regression scenario. No new TUI tests were added.

## Selection background fix

The maintainer confirmed that copying excluded sidebar text correctly; only its background changed. A diagnostic replay through Pi 0.84.0 and 0.87.1's actual selection renderer reproduced the problem without any image: slicing the unselected suffix replayed the transcript's background after the pane reset. The fullscreen adapter now keeps Pi's highlighted main pane and recomposites it over the original row, preserving the sidebar's original styling. Copy bounds are unchanged, capturing dialogs retain Pi's own selection rendering, and disposal restores the original renderer method. The same replay confirmed the corrected sidebar styling on both versions. No new TUI tests were added; the interactive drag/copy scenario above remains a manual check.
