# Image and panel compositing: manual verification

## Behavior

- The Sidebar keeps its text and borders on image-command rows, in regular and fullscreen mode.
- Visible transcript images are temporarily hidden while a capturing overlay (including Atelier Control Center and Display settings) is visible. Their reserved rows stay in place; closing the last visible dialog restores the images. This is a portable occlusion policy, not terminal-specific image z-ordering.
- Sidebar-only operation does not hide images. Image data sent to the model and saved in the session is unchanged.
- Fullscreen retains Pi's existing iTerm2 text-image fallback. Kitty/Ghostty fullscreen images remain supported.

## Isolated temporary session

From the repository root:

```bash
pi --no-session --no-extensions -e "$PWD/extensions/index.ts" --tui-mode regular
```

`--no-extensions` disables discovered/installed extensions; `-e` loads only this checkout's Atelier. `--no-session` avoids saving the session. Authentication and user settings still come from the usual Pi configuration. Avoid Save in Display settings unless you intend to update user defaults.

Repeat with `--tui-mode fullscreen` in a Kitty-compatible terminal. In iTerm2, check inline images in regular mode and text fallbacks in fullscreen mode.

## Maintainer verification

The maintainer confirmed that the Sidebar issue is fixed and that images disappear while settings are open, then return normally when settings close. The temporary hiding behavior is accepted. Tracked in [#53](https://github.com/michaelmjhhhh/pi-atelier/issues/53).

Terminal emulator, dimensions, Pi version, and post-fix screenshots were not supplied with that confirmation. The broader cross-terminal checklist below remains available for follow-up verification.

## TODO: visual checks

- [ ] Enable the Sidebar with `/atelier sidebar on`. Ask Pi to read a tall portrait image, then a wide image. Check that images stay inside the transcript pane and every adjacent Sidebar row/border remains visible.
- [ ] With a tall image visible, open `/atelier`. The whole menu, including its left edge and keyboard hints, must be readable. Visible transcript images should disappear without collapsing their reserved space.
- [ ] Navigate between Control Center panels, including tool settings and session rename. No image or cursor-motion residue should cover any panel.
- [ ] Open `/atelier display` directly. Repeat with `/atelier sidebar off` to check settings protection independently of the split pane.
- [ ] Close the dialogs with Escape. Images should return in their original positions, with no duplication, stale pixels, lost Sidebar rows, or displaced cursor.
- [ ] Read several images while output is streaming. Open and close settings during streaming; newly arriving images must not paint over the dialog.
- [ ] Resize the terminal and Sidebar with an image visible. Check narrow-terminal auto-hide, restoration after widening, and both Resize confirm/cancel paths.
- [ ] In fullscreen, scroll so an image is partially clipped at the top and bottom. Open/close settings. Check image cropping, wheel scrolling, and transcript selection/copy; copied text must not contain Sidebar content.
- [ ] Switch regular/fullscreen mode, then repeat image read and settings open/close. Run `/reload` and `/new`; check that there is only one Sidebar and no stale dialog/image placement.

## Diagnosis and implementation boundary

Pi 0.84's `compositeTuiLine()` returns image-bearing base lines unchanged. That drops a regular Sidebar overlay row and a fullscreen HStack sibling row. Images also occupy multiple terminal rows although only one row contains their graphics command, so ordinary text overlay compositing cannot occlude them.

`src/image-compositor.ts` adapts the renderer instance's overlay-composition seam, separates graphics commands from text, repairs fullscreen Sidebar cells before overlays are composed, and restores image commands after text at their original columns. It preserves multipart Kitty commands and treats iTerm2's cursor-up prefix as part of the image. When images are suppressed, Pi deletes Kitty placements through its existing diff path; all occupied iTerm2 rows are dirtied so Pi erases the entire image rather than just its command row.

The footer and split pane share a reference-counted adapter. The base method comes from a property descriptor rather than Pi's forwarding Proxy getter, avoiding recursive dispatch. Teardown restores the captured concrete renderer, even if Pi has since switched modes. No global prototype, terminal writer, tool output, or model input is modified.

Validation performed: in-memory probes against Pi's actual regular/fullscreen renderers, including its stable forwarding reference, checked Sidebar text, modal image suppression, restoration, Kitty deletion, iTerm2 row invalidation, and adapter cleanup. `npm run check` passes. These probes do not establish terminal pixel correctness. The maintainer verified the two reported symptoms as noted above; the broader TODO matrix has not been fully verified. No TUI unit or end-to-end tests were added.
