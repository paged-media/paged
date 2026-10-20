# ADR 263 — Ruler labels thin as you zoom out

- **Status:** Accepted 2026-10-20.
- **Scope:** `packages/shell/src/cockpit/canvas-frame/ruler-marks.ts` and `Rulers.tsx`.

## Context

UX audit F-31: at low zoom the ruler numbers overlapped into an unreadable band, and the
leftmost label dropped its minus sign ("300" for −300). The step between labelled marks came
from a fixed list ending at 5,000 and only aimed for 60 px between marks, without regard to how
wide the numbers are. InDesign thins its ruler numbers as you zoom out so they never touch.

## Decision

- The labelled step is the smallest number in the 1-2-5 progression (1, 2, 5, 10, 20, 50, …,
  without an upper end) whose marks leave room for the widest label in view (9 px monospace at
  0.6 em per character) plus a 12 px gap, and are at least 48 px apart.
- A negative label is written with a real minus sign (U+2212).
- A mark whose label would start before the ruler's left edge keeps its tick but shows no
  label, instead of a number cut to its last digits.

## Consequences

- F-31 closes (`packages/shell/test/chrome/rulers.test.ts`, `rulers.dom.test.tsx`,
  `apps/canvas/tests/e2e/ux-audit-open.spec.ts`).
- Minor (unlabelled) ticks between the labelled ones are not drawn yet.
