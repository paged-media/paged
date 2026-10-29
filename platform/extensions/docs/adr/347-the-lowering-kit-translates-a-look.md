# ADR 347 — The lowering kit translates a look, once

- **Status:** Accepted 2026-10-29.
- **Scope:** `packages/plugin-sdk/src/lowering.ts` (`NativeFx` and its parts, `nativeFxOps`,
  `nativeFxColors`, `nativeGradientId`, `nativeGradientMintOps`), `object-registry.ts`
  (`escapeLabelValue` from U+007F), `index.ts`; `platform/shared/helpers` (`asciiEscape`
  re-exported). Adopted by paged.sheet (sheet ADR 527: `chartFxOps`, `chartGradientId`,
  `gradientMintOps`, the table pictures) and paged.doc (doc ADR 619). Engine side: engine ADR
  1045. Plan Phase 11 C2, narrowed by the 2026-10-29 scope decision to the look translator and
  the label escape.

## Context

The built-in modules that lower a foreign format onto native page items decide an item's look
in Rust — DrawingML through the shared mapper (`platform/shared/dml-native`, slide ADR 722),
whose wire form is `dml_native::native::NativeFx` — and place the item from TypeScript through
mutations. paged.sheet translated `NativeFx` into `setElementProperty` writes in its own
`nativeFxOps`; paged.doc carried the same look and applied nothing, because the anchored frames
it places pictures in held no look until engine ADR 1045; the next module would have written a
third copy. The audit (Phase 11, C2) also found the label escape twice, drifting: the SDK
escaped from U+0080, `@paged-media/helpers` from U+007F.

## Decision

- **One translator, in the public SDK.** `nativeFxOps(fx, { target, color, gradient?, origin?,
  filled? })` returns the ops that give one item its look: the fill (a solid colour, or the
  gradient swatch the module names) and the gradient's angle, length and start, the outline
  (colour, weight, type, dash, cap, join, miter limit), the opacity, the drop and inner shadow,
  the outer glow, the soft edge and the gradient feather — in that order, on the free frames'
  own paths, which since engine ADR 1045 reach an anchored frame too. It is pure and
  deterministic. What is the module's own stays the module's: `color` names the swatch a
  `#RRGGBB` paints with, `gradient` the gradient swatch (without it the module paints the fill
  itself and only the placement is written), `origin` where the item's box starts in the
  coordinates the engine reads its gradient start in (the spread for a page item, `[0, 0]` for
  an anchored frame), `filled: false` drops the gradient and the gradient feather (a line).
- **`NativeFx` is the SDK's type**, the serialised form of dml-native's struct, so a module's IR
  carries it from Rust to here unchanged; the modules re-export it instead of declaring a twin.
- **Swatches.** `nativeFxColors` lists what a look paints with (the module mints those);
  `nativeGradientId(prefix, g)` is a content-addressed gradient swatch id (kind and stops: one
  swatch per ramp however often it is used or lowered — the id paged.sheet already used);
  `nativeGradientMintOps` creates the ones the document lacks under the read-first ruling every
  mint follows (a duplicate create fails the whole batch; a failed read, `known: null`, mints
  nothing).
- **One label escape.** `escapeLabelValue` escapes every character from U+007F up (DEL is a
  control character XML discourages; a surrogate pair is two escapes); `@paged-media/helpers`'
  `asciiEscape` is that function, re-exported, so a plugin and a built-in write a label's bytes
  alike.

The additions are additive: no wire change, no protocol bump. The contract version moves
(`0.74.3-canary.45`, contract-guard).

## Consequences

- paged.sheet's chart items and table pictures and paged.doc's pictures write their looks
  through one function; sheet's own translation is gone (`chartFxOps` is its call with the
  chart's swatch mapping), and a new lowering (slide's TS, web, a community format plugin) takes
  the same door.
- The rest of C2 — a batch builder, `$h:` handle and `minted` helpers, the page origin, the label
  envelope codec in the SDK — is not in this record (scope decision 2026-10-29); the envelope
  codec stays in helpers, on the one escape.
- `NativeFx` carries what dml-native lowers; a DrawingML blur, reflection or fill overlay is
  still the mapper's reported loss, though ADR 1008's stack could hold them (plan C10).
