# ADR 195 — The state hash covers the whole model

- **Status:** Accepted 2026-10-19.
- **Scope:** `crates/paged-scene/src/lib.rs` (`Document::canonical_hash`),
  `crates/paged-scene/src/canonical.rs`. It backs `CanvasModel::initial_state_hash` /
  `current_state_hash`, `paged digest`'s `stateHash` and `paged script`'s "not saved"
  warning. No wire change.

## Context

`canonical_hash` (v2) hashed a hand-picked subset: story text, paragraph style names, run
fonts and sizes, cell text, text-frame and rectangle bounds and transforms, and the anchor
table. `paged digest` documents `stateHash` as "a second and independent equality signal",
yet an oval's fill, any oval or polygon, a swatch or a style definition left it unchanged
(finding CLI-6), and `paged script` decides from it whether a script changed the document.

## Decision

1. **Every serialized field.** The hash (v3) streams the document's serde form, the model a
   `.paged` save writes, into BLAKE3 through a hashing `Serializer`: no JSON copy, an embedded
   image hashed as its bytes, every value behind a tag byte and every variable-length item
   behind its length. The `#[serde(skip)]` caches stay out.
2. **Maps are order-independent.** Several model maps are `HashMap`s, whose iteration order
   differs between two loads of the same bytes. Each entry is hashed on its own and the map
   folds the sorted entry digests, so the same document hashes alike across loads.
3. **Cost.** Small writes are buffered and reach the hasher in 64 KiB blocks. On the largest
   generated fixtures the hash takes 0.6 to 1.1 ms (release), against 4 to 10 ms to import
   the same bytes; v2 took 0.01 to 0.09 ms. It runs once per load and per digest.

## Consequences

- CLI-6 closes (`digest_state_hash_follows_a_fill_change`).
- The hash is stricter: an undo that leaves any field different (split runs, an empty
  fitting option) no longer hashes equal. The undo gates that compare hashes stay green on
  the current suite; a future one that fails has found an R5 bug, not a hash bug.
