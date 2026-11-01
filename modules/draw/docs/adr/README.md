# Architecture decision records

An ADR records one load-bearing decision that has already been made: what was decided, what
in the code shows it, and what it obliges other code to do. It is a record, not a proposal.
When the code stops matching a record, the body is left as it is and a dated amendment is
added at the end.

ADR numbers are unique across the paged-media repositories, so a number names the same
record wherever it is cited. New records in this repository use 350–399. Lower numbers
belong to other repositories or predate that scheme; none of them lives here. Records
350–357 were written on 2026-10-02 from the code as it stood, for decisions made earlier;
their status says so.

| ADR | Title | Status |
|---|---|---|
| [350](350-three-typescript-layers.md) | Three TypeScript layers: geometry, host-agnostic tool machines, host-bound bundle | Accepted, recorded retroactively 2026-10-02 |
| [351](351-shapes-are-native-page-items.md) | Drawn shapes are native page items; the plugin owns no content type | Accepted, recorded retroactively 2026-10-02 |
| [352](352-basic-operations-belong-to-the-host.md) | Basic object operations belong to the host | Accepted, recorded retroactively 2026-10-02 |
| [353](353-path-algebra-runs-in-the-engine.md) | Path algebra that changes a document path runs in the engine | Accepted, recorded retroactively 2026-10-02 |
| [354](354-multi-paint-bakes-to-a-group.md) | A multi-paint appearance bakes to a group of single-paint items | Accepted, recorded retroactively 2026-10-02 (partially superseded 2026-10-24 by 361; the metadata lane since 367) |
| [355](355-libraries-in-container-parts.md) | Document-level libraries and recipes live in container parts | Accepted, recorded retroactively 2026-10-02 |
| [356](356-live-constructs-are-recipes.md) | Live constructs are a stored recipe plus artwork that can be regenerated | Accepted, recorded retroactively 2026-10-02 (partially superseded 2026-10-24 by 361) |
| [357](357-image-trace-rust-lane.md) | Image Trace is the one Rust lane | Accepted, recorded retroactively 2026-10-02 |
| [358](358-one-snapper-the-engine-resolves.md) | One snapper for the point-placing tools; the engine resolves | Accepted 2026-10-19 |
| [359](359-the-host-owns-the-pencil.md) | The host owns the Pencil; it runs this repo's PencilMachine | Accepted 2026-10-19 |
| [360](360-records-name-no-minted-ids.md) | A bake or trace record names no id its own batch mints | Accepted 2026-10-20 |
| [361](361-visual-live-constructs-move-to-the-engine.md) | Visual live constructs move to the engine; recipes remain for generators | Accepted 2026-10-24 (partially supersedes 354, 356) |
| [362](362-retrace-recolour-blend-matching.md) | A trace keeps its options and re-traces in one step; blends match structure; recolouring re-points | Accepted 2026-10-24 |
| [363](363-distortion-tools.md) | The distortion tools rewrite paths; their maths is pure warp geometry; the grid is a view setting | Accepted 2026-10-24 |
| [364](364-interchange-rides-the-engines-doors.md) | Interchange rides the engine's doors: one SVG reader and writer, DXF through SVG, AI and EPS through the host | Accepted 2026-10-28 (amends 357) |
| [365](365-live-symbols-on-the-engine-node.md) | Live symbols run on the engine's instance node; the Symbolism tools change what an instance carries | Accepted 2026-10-29 |
| [367](367-envelopes-and-graphic-styles-on-native-appearance.md) | Draw's appearance runs on the engine: the host panel, envelopes as stack entries, graphic styles on native appearance | Accepted 2026-10-31 (amends 354, 355) |

Decisions made in other repositories that this plugin's code rests on are listed in
[`../README.md`](../README.md).
