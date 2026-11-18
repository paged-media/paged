# ADR 1315 — A value outside an enum is refused, and the refusal says what the path takes

- **Status:** Accepted 2026-11-18.
- **Scope:** `paged-introspect` (`schema.rs`: the vocabularies; `catalog.rs` and
  `virtual_paths.rs`: which enum rows are open), `paged-script` (`paged.set`,
  `paged.setStyleProperty`, the core half of an object `paged.batch`), `paged-mutate` (the apply
  arms that parse a token into a closed model type; `refuse_unauthorable_value`), `paged-model`
  (`ContourOptionType`). The catalog's `propertySchemas` and the plugin contract's vendored copy
  change with it. Amends [ADR 132](132-typed-property-schemas-and-virtual-paths.md).

## Context

ADR 132 typed every settable value. An enum row lists its members and is either closed (coercion
refuses a value outside them) or open (`open: true`: "the members are the known values, the
engine stores any string"). Thirty-six rows were open, and most of them for no reason the code
bore out.

`paged.set(frame, 'frameCornerOptionTopLeft', 'Rounded')` answered `true`. The corner rows were
open, so the script bridge passed `"Rounded"` to the apply layer; the apply arm parsed it with
`CornerOption::from_idml`, which knows `RoundedCorner` and not `Rounded`, and stored no option at
all. The write reported success and the frame kept square corners. The same happened, with
different losses, on the other rows whose model type is closed: a text wrap mode or a contour
type the model does not know became `Other` and read back as `None` / `SameAsClipping`, a section
numbering style became Arabic, an object style's corner option kept its string and cleared all
four corners. Where the model kept the string (a stroke join, a blend mode, a bevel technique), a
misspelling was stored and drawn as the default. And when a write was refused, the script was told
only `false`: nothing said which values the path takes.

The gate also found members the engine cannot take: the composer row listed `Adobe Paragraph
Composer`, a name InDesign shows but never writes (it writes `HL Composer`), which the authoring
door refused; the contour row listed `BoundingBox` and `UserModifiedPath`, which the model turned
into `SameAsClipping`.

## Decision

**An enum is closed unless its vocabulary is open in fact.** A row stays open only where the
document itself may name values beyond the list and the engine keeps them as given:

| Open row | Why |
|---|---|
| `frameStrokeType` | a document defines its own stroke styles and references them the same way |
| `characterKerningMethod` | IDML spells the methods with `$ID/` (`$ID/Optical`), and InDesign has more than the three listed |
| `textVariableType` | InDesign has variable types (metadata captions) beyond the listed ones |
| `doc` `rgbPolicy` | carried, not interpreted, and its spellings are not settled: IDML writes `PreserveEmbeddedProfiles` / `ColorPolicyOff`, which `setColorSettings` passes through |

Every other enum row is closed: the corner options (frame and object style), the text wrap mode
and contour type, the fitting type and reference point, the drop shadow mode, the stroke join and
alignment, the 27 blend modes (engine ADR 1034 defines them once), the bevel, feather and
anchored-object vocabularies, a run's case, position and underline kind, the paragraph composer
and a section's numbering style.

**The members are what the engine takes.** A closed row's members are exactly the tokens the
model holds and reads back: the composer row lists the seven spellings `Composer` knows
(`HL Composer`, `HL Single`, `HL Composer Optyca`, `HL Single Optyca`, `HL Composer J`,
`HL Single J`, `Word First-fit`); the fitting row adds `ContentAwareFit`, which InDesign writes
and the renderer fits; `ContourOptionType` gains `BoundingBox` and `UserModifiedPath`, so a
contour type InDesign writes is no longer turned into another on import, on a set, or on export.

**The refusal says why.** `paged.set` still answers `false` (the surface's convention for a value
it does not take, catalog constraint 3), and prints a warning that names the path and what it
takes, from the schema's own words:

```
[warn] paged.set — frameCornerOptionTopLeft: "Rounded" is not one of None | RoundedCorner | InverseRoundedCorner | InsetCorner | BeveledCorner | FancyCorner; returning false
```

`paged.setStyleProperty` warns the same way, and an object `paged.batch` carries the reason in
its typed result (`{ ok: false, code: "invalidValue", reason }`). `paged.setStyleProperty` also
takes a style family's own paths (`objectStyleCornerOption`, `objectStyleCornerRadius`,
`objectStyleStrokeTint`, the table style's paths), which it answered `false` for although `Set`
on the style's address took them. A number outside a row's range
is reported the same way. A target or path that does not resolve still answers `false` without a
warning.

**A raw write cannot lose a value either.** A wire client may send `SetElementProperty` or
`SetStyleProperty` without the schema. The apply arms that parse a token into a closed model type
(the corner options, the text wrap mode and contour type, a text frame's vertical justification,
auto-sizing and first baseline) refuse a token they have no value for with `InvalidValue`, as the
arrowhead arm already did (`apply::helpers::closed_token`); the object style's corner option, whose string
the style keeps for its round trip, is refused at the authoring door
(`refuse_unauthorable_value`, beside the composer). An arm that keeps the string keeps it: there
the raw write is stored and read back as given.

## Evidence

- `crates/paged-canvas/tests/it/virtual_paths.rs`
  (`every_enum_row_refuses_a_stranger_and_keeps_its_members`): every enum row of the catalog,
  element, style and virtual, on every probe target it applies to: each member lands through
  `Set` and reads back; a stranger is refused by a closed row and read back as given by an open
  one; the raw `SetElementProperty` / `SetStyleProperty` either refuses it or keeps it.
- `crates/paged-script/tests/it/enum_values.rs`: the lab's case end to end (`false`, the warning
  with the six corner options, the document untouched; the member lands and reads back), the
  batch's reason, the object style's corner option through `setStyleProperty` and through the
  style's address, the frame proxy's throw, and no closed path converting a stranger.
- `crates/paged-introspect/src/schema.rs` unit tests: the coercion rules themselves.

## Consequences

- A script, a `Set`, a plugin's object write, a data binding or the command line that sent a
  misspelt token to one of these rows is refused where it was stored or lost. The editor's panels
  send the raw ops and are unchanged.
- The catalog's `propertySchemas` lose `open` on the closed rows and gain the corrected members;
  `objectSchemas` (which never carried `open`) change only in the members. The plugin contract's
  vendored `catalog.json` follows, which moves plugin-sdk's canary.
- A section's numbering style is a virtual row: `Set` refuses a stranger, but the raw
  `editSection` op still reads an unknown style as Arabic, as the IDML importer does for an
  edition's styles this one does not offer.
- The four anchored-object reference and alignment rows are typed `text`, not `enum`, and are
  unchanged: the renderer reads more spellings than one list would name (`ColumnEdge` and
  `Column`, `LineXHeight`). Typing them is a later amendment that settles the spelling first.
