# PM-0010 — The monorepo was assembled from twelve repositories, with their history

- **Status:** Accepted 2026-10-18.
- **Scope:** `tooling/import/` (`assemble.py`, `verify.py`, `manifest.yaml`, `mailmap`,
  `import-lock.json`, `commit-maps/`), the root commit, and every component's history.

## Context

Paged was developed in twelve repositories: the engine, eight modules, the extension SDK, the
editor and its server. They depended on each other through git revisions and npm canaries, so one
change across them meant a publish and a re-pin in each. One repository removes that, but only if
the history moves with the code: blame, bisect and the commit SHAs that documents quote all have
to keep working.

## Decision

- **One scripted import, re-runnable.** `tooling/import/assemble.py` mirrors each repository from
  GitHub, never from a local checkout, so untracked files, symlinks and local assets cannot leak
  in. It rewrites each one with `git filter-repo`:
  - path rules from `manifest.yaml`;
  - the directory prefix;
  - `mailmap`;
  - `#N` in commit messages → `paged-media/<repo>#N`, so old pull-request links still resolve.

  It then merges the results under one root commit in a fixed order. With the same sources, two
  runs produce the same commit.
- **Layout:**

  | Former repository | Directory |
  |---|---|
  | core | `engine/core` |
  | plugin-publish, plugin-image, plugin-draw, plugin-sheets, plugin-data, plugin-doc, plugin-slide, plugin-web | `modules/{publish,image,draw,sheet,data,doc,slide,web}` |
  | plugin-sdk | `platform/extensions` |
  | editor | `apps/editor` |
  | editor-server (`server/`, `docs/` and licence files only) | `apps/server` |

- **What was imported:**
  - each repository's `main`;
  - the engine's 56 release tags `v0.N.P`, with unchanged trees.
- **What was not imported:**
  - other branches; they stay in the former repositories;
  - from the editor:
    - the showcase build checkpoints (about 1 GB, unreferenced; archived separately);
    - blobs over 5 MB that only history holds (old showcase PDFs and documents, committed wasm builds);
  - from plugin-image: the history-only builds of `glue/wasm` and `manifest/wasm`.

  Every strip is by blob id, so the current version of each file is kept.
- **Author identities** are normalised by `mailmap`: one address per person. The rewrite happens
  once, at the import; nothing is force-pushed later.
- **Gates** (`verify.py`; the import fails if any fails):
  - each directory's tree equals its source's tree, minus the manifest's strips;
  - each tag's tree equals the original tag's;
  - no excluded identity in any author, committer or tagger;
  - no forbidden files: colour profiles, local fonts, corpus payloads;
  - a full-history secret scan (gitleaks).
- **Records:**
  - `import-lock.json` holds each source SHA and the rewritten tip;
  - `commit-maps/<repo>.tsv` maps every original commit to its new SHA, for following SHAs quoted in documents and pins.
- **Cutover:**
  1. Freeze the former repositories.
  2. Run the final assembly from their frozen tips.
  3. Re-run the gates.
  4. Push `main` and the tags.
  5. Each former repository's README now points here. They are archived once this repository's
     CI covers what theirs did.

## Consequences

- One revision covers the engine, the modules, the SDK and the editor. A change across them is
  one pull request.
- SHAs in the former repositories differ from the SHAs here. Old references are translated with
  the commit maps.
- Until the former repositories are archived, unfreezing them is the rollback. The manifest and
  lock name the exact SHAs.
