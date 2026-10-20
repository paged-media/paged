# ADR 199 — The IDML writer spells a changed number as the f32 it is

- **Status:** Accepted 2026-10-20.
- **Scope:** `format_f32` and `format_matrix` (`crates/idml-export/src/rewrite.rs`), every
  attribute the writer emits for a value that changed (transforms, bounds, anchors, weights,
  effect values).

## Context

The writer rounded every number it wrote to 4 decimals (the rule of `paged-gen`'s
`format_f32`). The model holds `f32`, which below about 1,678 pt resolves far finer than a
ten-thousandth, so a turned frame's transform (`0.8660254 0.5 -0.5 0.8660254 …`) came back
as `0.866 …` and its corners moved by up to ~1e-4 × its coordinates on every save → load
(finding GF-4, `platform/shared/test-kit/test/engine-gestures.test.ts`). InDesign's own IDML
writes transforms and path points at full precision (`-0.9659258262890683 0.25881904510252074`).

## Decision

`format_f32` prints the shortest decimal that parses back to the same `f32` (Rust's `Display`
for `f32`, which never uses an exponent), with `-0` as `0`. Integers stay bare, short values
stay short, a value with more digits keeps them. A save → load gives back the model that was
saved.

An untouched value still saves as the bytes it arrived as (`TransformPlan`,
`preserving_f32_patch`); this rule is the spelling of a value that changed.

## Consequences

- GF-4 closes: a rotated frame survives IDML save → load exactly.
- Mutated values in a saved IDML can be longer (`0.7086614` where it was `0.7087`). The
  byte-identity of an unmutated save is unchanged.
- `tests/it/format_f32_precision.rs` now asserts the round trip at every magnitude; its record
  of the old f32 rounding defect stays.
