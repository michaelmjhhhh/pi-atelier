# Sidebar hierarchy prototype

Branch: `prototype/sidebar-hierarchy`. Throwaway exploration; no winning design has been selected for main.

Question: how can the contents become easier to scan while retaining the original separate, colorful, rounded panels?

User feedback rejected removing borders and colors. The context meter uses a background behind its fractional fill so low usage does not appear detached from the remaining track. All current variants reuse the original panel renderer, including colored titles, jewels, rounded borders, padding, and separate panel identities.

| Variant | Internal organization | Tradeoff |
| --- | --- | --- |
| A — Labeled metrics (default) | Explicit labels, aligned values, no duplicate Ready | More rows, less interpretation |
| B — Internal groups | The same panels with internal separation for configuration, Git changes, and session details | Clearer internal grouping; more vertical space |
| C — Compact metrics | The same panels with condensed metadata and timing when they fit | Higher density; timing abbreviations require familiarity |
| original | Existing contents and renderer | Baseline for comparison |

Common changes: one Ready status; explicit Thinking and Billing labels; named Git fields instead of `?5`; semantic metric colors; a fractional-block context meter with a continuous background track, right-aligned bold percentage, and muted token counts; no misleading tool disclosure arrow. Empty response metrics use a muted dash. Values keep units, with narrow layouts using separate rows when needed.

Existing panel visibility, saved order, contribution data, tool-name setting, and overflow removal priorities remain in use. Panels stay separate. Very short terminals still omit lower-priority content; they do not add scrolling. Long names truncate with an ellipsis. No settings schema or persistent variant preference is introduced.

## Compare in a browser

```sh
npm run prototype:sidebar
```

Open <http://127.0.0.1:4319/?variant=A>. Use the bottom switcher or Left/Right arrows; the URL keeps the selected design, fixture state, and dimensions. Ready, Low context (1.3%), Working, and Warnings fixtures are available. Preview text comes from the actual TUI renderer; the surrounding conversation is a static mockup. Stop the server with Ctrl-C.

## Try with live data

From the repository root:

```sh
npm run prototype:sidebar -- --live A
```

Equivalent explicit command:

```sh
PI_ATELIER_SIDEBAR_DESIGN=A ./node_modules/.bin/pi --no-session --no-extensions -e ./extensions/index.ts
```

This opens an ephemeral Pi session and disables automatic extension discovery, loading only this checkout's extension. Existing model authentication remains available. Use `/atelier-design A`, `/atelier-design B`, `/atelier-design C`, or `/atelier-design original` to switch in the same session. The command shows the sidebar when Atelier is enabled; if disabled, use `/atelier enable` first. Variant selection stays in memory for this process.

## Verification

Type checking, formatting of changed code, JavaScript syntax, and whitespace checks pass. Manually inspected renderer text for ready, working, warnings, and narrow/short layouts. Browser automation was unavailable; browser appearance and live Pi interactions are not visually verified. No TUI unit or e2e tests were added.

Manual TODO:

- [ ] Compare A/B/C/original with `/atelier-design` in the ephemeral session.
- [ ] Send a prompt and inspect working status, first-token latency, output speed, and tool activity.
- [ ] Resize the sidebar and terminal; check long model/branch names, context percentage, units, and omitted low-priority rows.
- [ ] Check the context meter at zero, 1.3%, and high usage, including fractional block rendering in your terminal font.
- [ ] Check high context, Git conflicts, alerts, and unavailable metrics in the browser fixtures or live data.
- [ ] Toggle tool names and reorder/hide panels; check contributed panels if used.
- [ ] Check light/dark terminal themes and no-color readability.

Design constraint confirmed: keep the existing colorful, rounded panels. The first exploration changed the wrong aspect of the design and was rejected. Evaluation of the revised internal organization is pending.
