# Random Working Phrases Design

## Goal

Keep the footer's `READY` label unchanged. Whenever Pi Atelier enters a new working cycle, replace the fixed `WORKING` label with one randomly selected English activity phrase from the supplied reference image.

## Phrase pool

The fixed pool contains all 36 English phrases from the reference image:

- Kitchen: `KNEADING`, `PERCOLATING`, `MARINATING`, `CARAMELIZING`, `JULIENNING`, `FLAMBÉING`
- Dance floor: `CHOREOGRAPHING`, `MOONWALKING`, `JITTERBUGGING`, `SOCK-HOPPING`, `BOOGIEING`, `SHIMMYING`
- Nature: `EBBING`, `UNDULATING`, `PROPAGATING`, `PHOTOSYNTHESIZING`, `GERMINATING`, `POLLINATING`
- Thinking: `PONDERING`, `RUMINATING`, `COGITATING`, `CEREBRATING`, `DELIBERATING`, `MUSING`
- Nonsense: `FROLICKING`, `LOLLYGAGGING`, `DILLY-DALLYING`, `BOONDOGGLING`, `SHENANIGANING`, `RAZZLE-DAZZLING`
- Easter eggs: `CLAUDING`, `GITIFYING`, `RETICULATING`, `HYPERSPACING`, `QUANTUMIZING`, `COMBOBULATING`

The labels are displayed in uppercase to preserve the existing footer's visual language.

## Runtime behavior

`AtelierState` will carry the selected working label. `AtelierRuntime` will choose a phrase when activity transitions from any non-working state into `working`. The selected phrase remains stable while the runtime stays in `working`, including across usage refreshes and footer redraws.

After activity leaves `working`, the next transition into `working` performs a fresh random selection. Consecutive cycles may select the same phrase naturally; no history or forced de-duplication is required.

`ready`, `warning`, and `error` continue to render as `READY`, `WARNING`, and `ERROR` respectively. Compact layouts continue to show only the colored activity dot, so their behavior does not change.

## Module boundaries

- `src/state.ts` owns work-cycle transitions and random selection because the runtime, rather than the renderer, knows when a cycle begins.
- A small exported phrase pool or selection helper provides one authoritative list and permits focused tests.
- `src/footer.ts` remains deterministic: it reads the selected label from state and paints it with the existing `working` palette role.
- `src/types.ts` adds the state field needed to carry the selected label.

Randomness should be injectable at the runtime boundary with `Math.random` as the production default, allowing tests to make exact assertions without mocking global state.

## Error and boundary handling

The phrase pool is a non-empty internal constant. Selection clamps the computed index to a valid entry so an injected random source returning a boundary value cannot produce an undefined label. If state lacks a working label for compatibility with a manually constructed or older state object, the renderer falls back to `WORKING` rather than showing blank or undefined output.

## Testing

Tests will verify that:

1. Entering `working` selects a member of the approved phrase pool.
2. The selected phrase remains stable through repeated renders and refreshes in the same work cycle.
3. Leaving and re-entering `working` invokes selection for a new cycle.
4. `READY`, `WARNING`, and `ERROR` remain unchanged.
5. The footer still obeys responsive width limits with the longest phrase.

README preview and palette wording will be updated to describe randomized working phrases without implying that the literal `WORKING` label is normally displayed.

## Out of scope

- User-configurable phrase lists
- Phrase category weighting
- Avoiding repeats across cycles
- Randomized ready, warning, or error labels
- Chinese translations from the reference image
