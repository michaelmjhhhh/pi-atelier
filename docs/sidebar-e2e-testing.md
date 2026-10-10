# End-to-end functional testing — the Sidebar under omp (patched host)

**Goal:** verify, on the real host through the real UI, the four behaviors landed in
`pi-atelier/src/split-pane.ts` — structural regular-renderer detection (F1), memoized
adapter resolution (F2), regular-mode selection clipping (F3), and host-modal yielding
(F4) — plus the CortexKit contributed panels (`cortexkit:aft`, `cortexkit:magic-context`).

Unit tests cannot cover this: under the isolated no-auth test home the sidebar never
fully engages, so below is a manual checklist that exercises each behavior. Total time
≈ 15 minutes. Do everything in a real terminal (Windows Terminal works; a ConPTY host —
not a pipe or an IDE-embedded console).

## 0. Environment checks (one time)

```bash
cd D:/Coding/_tools/_omp/omp-sidepanel-bridge-aft-mc

# 1. Preflight will self-heal the native addon and the plugin symlinks:
bun scripts/preflight.ts --verbose

# 2. The plugins must point at THIS tree (edit → reload is direct):
readlink -f ~/.omp/plugins/node_modules/pi-atelier
#   must print D:/Coding/_tools/_omp/omp-sidepanel-bridge-aft-mc/pi-atelier
readlink -f ~/.omp/plugins/node_modules/@cortexkit/pi-magic-context 2>/dev/null || echo "MC not linked (optional for F1–F4)"

# 3. If anything relinks or a command goes missing after a launch:
omp install ./pi-atelier
#   and confirm the commands come back after the next start:
```

## 1. Launch the patched omp

```bash
./omp-patched.sh
```

Expect: a session UI opens, no `Failed to load extension` on stderr. Confirm the
extensions loaded — start typing `/` and check that `atelier`, `aft-status`, `ctx-status`
and `statusrows` appear in the command list.

**If keyboard input is dead** (frame renders but typing does nothing): this is the
known overlay-input issue on non-Pi hosts, *not* one of the four features. Run
`omp plugin disable pi-atelier` and retest input; report per
`docs/upstream-pi-atelier-overlay-input.md`. All sidebar checks below assume a session
where input works.

## 2. Show the sidebar in regular mode (covers F1 + F2)

`omp's TUI carries no `mode` property, so F1's structural detection is what lets the
regular-mode layout adapter engage at all.

```
/atelier enable
/atelier sidebar on
```

Expected:
- A sidebar column appears on the **right** side of the regular transcript (NOT as a
  floating overlay — the main pane's text must wrap one column-set narrower with the
  sidebar shown).
- `/atelier sidebar off` → the transcript reflow restores full width.
- Type several multi-line messages while the sidebar is open. There must be **no
  flicker, no duplicate renders, and no progressive slowdown** — F2's memoized prototype
  resolution means the renderer is re-walked zero times after the adapter installs.

## 3. Width adaptation (regression check)

With a prompt producing long output lines:

1. `/atelier sidebar manual` (per-line warning: Manual avoids mid-window resize churn)
2. Narrow and widen the terminal window.
3. Expected: the sidebar keeps its preferred width until the terminal gets tight, then
   collapses; the transcript reflows both ways. In Auto mode the same happens without
   the manual step.

## 4. Text-selection clipping (covers F3)

This is regular-mode selection through the host's own selection machinery:

1. Show the sidebar (`/atelier sidebar on`).
2. Drag-select a portion of a **long transcript line** that extends well beyond the
   main pane's column budget (into where the sidebar sits).
3. Expected: the highlighted region clips at the main pane's right edge — the selected
   text **never bleeds into the sidebar's columns**, and the sidebar keeps rendering.
4. Copy the selection (Ctrl+Shift+C / Enter, depending on terminal) and paste in a
   text editor. Expected: only the visible main-pane characters, no sidebar text
   appended, and no ANSI garbage.
5. `/atelier sidebar off` and drag-select the same line. Expected: full-line selection
   behaves normally (unchanged from before — F3 passes selection through untouched when
   the sidebar is hidden).

## 5. Host-modal yielding (covers F4)

While the sidebar is shown, trigger any host dialog that captures input — for example
a model picker, a theme picker, or any pop-up menu whose open state puts a modal
overlay on the screen. This is exercised by opening omp's own dialog:

1. `/atelier sidebar on`
2. Open any dialog that overlays the right-hand side (e.g. a model chooser or the
   `/atelier` settings workspace itself).
3. Expected: the sidebar visually **steps aside** (does not paint over or beside the
   dialog's frame); once the dialog closes (Esc), the sidebar **returns** within one
   frame — no reload or re-show command needed.

This behavior is stateless (rechecked per frame), so open/close the dialog repeatedly —
it must re-yield and re-return every time, with no desync.

## 6. CortexKit contributed panels

These need a producing bridge; without Magic Context/AFT publishing, the panels show
but stay empty/unavailable:

1. `/atelier` (or F6) → Display Settings workspace.
2. Expected: a `cortexkit:aft` (title `AFT`) and a `cortexkit:magic-context` row in the
   panel layout. With no snapshots published they may be marked unavailable — that is
   correct and matches the bridge design (panels appear only after authoritative data
   arrives).
3. Run some activity through the AFT pipeline (or send `/ctx-status` if Magic Context is
   linked and built). Expected: the corresponding panel rows populate with live values
   (search status, semantic index counters, code-health categories per the row list in
   `docs/handoff-omp-sidepanel-irt.md`).

## 7. What to capture if something fails

- The command you ran and the omp terminal contents at the moment of failure.
- Whether it reproduces after `omp plugin disable pi-atelier` (which isolates Atelier
  vs the host).
- For selection clipping (§4): paste the clipboard result — before/after screenshots
  are equally useful. `bun scripts/tty-probe.ts` is the fallback for anything that looks
  like an input or rendering fault, separating terminal from runtime issues.

## Cross-check

For maximum signal, repeat steps 2–5 in plain Pi (`pi`), where the sidebar has always
worked. The omp result should match the Pi result in every step except where omp's own
dialogs/panels differ.
