# ADR 249 — A control is offered only where it applies: the command's `when`, the field's kind

- **Status:** Accepted 2026-10-19.
- **Scope:** `packages/shell/src/registries/types.ts` (`entryApplies`), `chrome/MenuBar.tsx`,
  plugin-sdk's `contribute.menu`, `apps/canvas/src/object-commands.ts`,
  `catalog/object-model.tsx` and `object-field.tsx` (not applicable), `catalog/leaves.tsx` and
  `@paged-media/ui` `NumberInput.unsetText` (an unset length), and the panels with stale seams.

## Context

The command registry refuses a command whose `when` is false, silently. A menu entry asked
only its own `when`, so it was offered where its click would be refused: the Object verbs with
nothing selected (SH-8, UX F-14), a bundle's workbook verbs with no workbook (MNU-1, the SDK
built an entry's `when` from its scope only), an entry onto a command the bundle never
registered (HOST-7), the workbook verbs after a failed import (SHT-3), New colour group with no
document (PN-157). Fields did the same: core's "this kind has no such entry" showed as mixed
and the field stayed live, sending a write the engine refused (PN-3, PN-200, PN-253, PN-257);
an unset length showed as 0 (auto leading 0 pt, an untouched opacity 0 %, an untinted swatch
0 %: PN-21, PN-250, PN-164). Panels kept seams for reads and writes the engine had gained
(PN-23, PN-101, PN-111, PN-258, PN-302). InDesign greys what does not apply and names Auto.

## Decision

- An entry applies when its own `when` holds, its command is registered, and the command's
  `when` holds (`entryApplies`); the menu greys it otherwise. The SDK refuses a menu entry onto
  a command the bundle has not registered and folds the command's `when` into the entry's.
  Each Object verb's `when` asks for a selection; a sheet verb's for an open workbook (an
  engine and an active sheet, what its handler asks).
- A field whose every target answers `absent` (the kind carries no such entry) reads as not
  applicable and has no commit, so it sends nothing. A list row is the exception: there
  `absent` is the empty list, which can grow.
- An unset length reads as the property's schema default (the catalog's `default`: opacity,
  scale, tint and alpha 100 %), else as 0, the InDesign default of most lengths; a field whose
  unset state has a name says it (`unsetText: "Auto"` on leading) and stays editable.
- A seam is removed when the engine has the read or the write it waited for.

## Consequences

SH-8, MNU-1, HOST-7, SHT-3, PN-157, PN-3, PN-200, PN-253, PN-257, PN-21, PN-164, PN-250, PN-23,
PN-101, PN-111, PN-258 and PN-302 close. A bundle that registers a menu entry before its
command now fails at activation in enforce mode; every built-in bundle registers its commands
first. A mixed selection (a rectangle and an oval) stays live; a write that reaches the oval is
refused as one batch and said in words (PN-4).
