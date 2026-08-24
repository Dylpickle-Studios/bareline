# Themes and accessibility

## Themes

Appearance settings support light, dark, or system mode, one restrained accent, a UI font, and a code
font. Values become CSS custom properties and remain readable when browser JavaScript fails. Plugins
may contribute deeper themes only with the relevant UI permission.

## Keyboard use

Use Ctrl+K or Cmd+K to open the command palette. Results include permitted repositories, files,
settings, documentation headings, plugin commands, branches, and tags. Dialog focus is trapped and
restored. All primary actions remain normal links or forms and work without optional enhancements.

## Screen readers and contrast

Pages use landmarks, headings, labels, tables only for tabular data, a skip link, visible focus, and
status text that does not rely on color. Diff additions and deletions retain textual signs. The image
comparison slider has a label and before/after alternatives. Report accessibility regressions using
the security/contact process when privacy is involved, or the normal issue tracker otherwise.

## Reduced motion and mobile layouts

Motion is disabled when the operating system requests reduced motion. Repository trees become
compact lists, settings navigation scrolls horizontally, image comparisons stack, and split diffs
retain both sides in a deliberate horizontal viewport rather than silently hiding content.
