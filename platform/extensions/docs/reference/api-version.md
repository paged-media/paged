# The plugin API version

How an extension and a host tell whether they fit. The decision is
[ADR 304](../adr/304-bundle-lifecycle.md), amendment 2026-11-28.

## Two numbers

| Number                                       | Where                                                | What it says                                                                           |
| -------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------- |
| The package version, `0.<protocol>.<patch>`  | `@paged-media/plugin-sdk` on npm                     | Which release this is. The minor is the engine's wire protocol; a release tag sets it. |
| The API version, `0.<generation>.<revision>` | `API_VERSION`, exported by `@paged-media/plugin-sdk` | Which contract the host implements. A manifest's `apiVersion` is a range over it.      |

Only the API version decides whether a bundle loads.

## How it moves

- The **revision** rises with every change to the contract's sources, additions and
  documentation included. A higher revision never takes anything away.
- The **generation** rises, and the revision returns to 0, when a change breaks an extension
  written against the generation: a member removed or renamed, a signature narrowed, a
  meaning changed.

In the repository, `platform/extensions/scripts/assert-contract-bumped.mjs` refuses a
contract change that does not raise `API_VERSION`.

## What to write in a manifest

```json
{ "apiVersion": "^0.2.557" }
```

| Range      | Accepts                                           |
| ---------- | ------------------------------------------------- |
| `^0.2`     | Every host of generation 0.2.                     |
| `^0.2.557` | Hosts of generation 0.2 at revision 557 or later. |
| `0.2.557`  | That revision only. Rarely what you want.         |
| `*`        | Every host. For tools, not for extensions.        |

Name the revision of the SDK you built against when the extension cannot run without
surface that revision added: an older host then refuses the bundle at load, with a message
that says the host is behind, where it would otherwise fail later on a missing member. To
keep working on older hosts, leave the floor low and probe the doors you use with
`host.supports("area.member@major")`.

## What the host does

`loadBundle` and the headless host (`createHeadlessHost().loadBundle`) throw when the range
does not accept the host's `API_VERSION`. The message names the bundle, its range, and the
side that has to move:

- the extension needs a later revision: update the host;
- the extension was built for a newer generation: update the host;
- the extension was built for an older generation: rebuild it against the current SDK and
  move its `apiVersion`.

`satisfiesApiVersion(range, version?)` is the check and `explainApiMismatch(range, version?)`
the message; `API_GENERATION_RANGE` is the range that accepts every revision of the host's
own generation.
