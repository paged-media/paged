# The headless editor and cross-surface parity

Two test layers of the surface conformance programme
([surface-conformance.md](../../apps/editor/docs/reference/surface-conformance.md)):
the **headless editor** (layer 3), and **cross-surface parity** (layer 5),
which runs on it.

## The headless editor

The editor's shell, its client and the real engine under `bun test`, with no
browser. Tests live in `apps/editor/apps/canvas/tests/headless/**/*.test.ts`
and run with `bun run test:headless` (from `apps/editor/apps/canvas` or
`apps/editor`); CI runs them in the "headless editor" step of
`editor / tests`. They need the engine's wasm packages
(`moon run core:wasm-pkg`).

```ts
import {
  covers,
  gestureFixture,
  GESTURE_TARGETS as T,
} from "@paged-media/test-kit";
import { dumpDiff } from "@paged-media/test-kit/headless";
import { createHeadlessEditor } from "./harness";

const ed = await createHeadlessEditor({ idml: gestureFixture("targets") });
const before = await ed.dump();
await ed.select([T.frame.id]);
await ed.invoke("paged.object.delete");
covers("command:paged.object.delete");
expect(ed.problems()).toEqual([]);
await ed.invoke("paged.editor.undo");
await ed.idle();
expect(dumpDiff(before, await ed.dump())).toEqual([]);
await ed.dispose();
```

What is real, what stands in, what is off:

| Part                                                                                                                          | Headlessly                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Engine                                                                                                                        | Real: the editor's canvas-wasm, instantiated once per process (`@paged-media/test-kit/headless` `headlessEngineModule`), a fresh engine object per editor.                                                                                                                                                                                                                                                                                  |
| Render worker                                                                                                                 | In process: `createEngineWorker` mirrors `apps/canvas/src/worker/worker.ts` message for message (the JSON channel, the binary load and v66 doors, the measure shortcuts, the gesture SAB drain, the resolver). It paints nothing. Two deliberate differences: a load that throws answers `loadFailed`, and after an engine trap (a Rust panic) every request is refused at once (`ed.worker.poisoned`), so a test fails instead of hanging. |
| Client                                                                                                                        | Real `CanvasClient`, through its `workerFactory`.                                                                                                                                                                                                                                                                                                                                                                                           |
| Shell registries                                                                                                              | Real (`createShellRegistries`), with the app's command, menu and keybinding sets and their real runners, registered as `main.tsx` registers them (keep the two in step), plus the shell's exported file commands.                                                                                                                                                                                                                           |
| Object registry                                                                                                               | The app's own (`src/object-model.ts`), re-armed per editor.                                                                                                                                                                                                                                                                                                                                                                                 |
| Scripts                                                                                                                       | Boa `paged.*` through `ed.script(src)` (the host-object bridge armed); `editor.*` / `demo.*` through `ed.automation` and `ed.runDemo(src)`, over a `__canvas`-shaped handle (`ed.canvas`, also on `globalThis.__canvas` while the editor is live).                                                                                                                                                                                          |
| Plugin hosts                                                                                                                  | `ed.host(manifest?)` and `ed.loadBundle(bundle)` (`createBundleHost` / `loadBundle` over the headless `PagedEditor`).                                                                                                                                                                                                                                                                                                                       |
| Keyboard                                                                                                                      | `ed.press("cmd+z")`: the real keybinding registry resolves the key against the live editor and runs the winner.                                                                                                                                                                                                                                                                                                                             |
| Shell state (document, selection, camera, tool, content selection, tool settings, screen mode, overlay signals, edit context) | Stand-ins with the same members (`ed.state`); a test sets `ed.state.editContext` to be inside a plugin content type.                                                                                                                                                                                                                                                                                                                        |
| Rendering, panels, dialogs                                                                                                    | Off. A command that opens a dialog, a picker or the assistant records it in `ed.opened`.                                                                                                                                                                                                                                                                                                                                                    |

`ed.dump()` is the canonical model dump (`modelDump`): the document meta, the
scene tree, every element's properties and path anchors, the document
collections, every story's content, every object address the engine lists,
and optionally every listed object's object-model properties. Equal models
dump to equal JSON (`canonicalJson`); `dumpDiff(a, b)` says where two differ.

## Cross-surface parity

`apps/editor/apps/canvas/tests/headless/parity/` performs every capability it
has a case for through every surface that reaches it, from the same
precondition, and asserts identical model dumps.

- **Capabilities** are the catalog's operations
  (`engine/core/crates/paged-introspect/catalog.json` `operations`, the wire's
  `Mutation` variants). `cases.ts` holds a case per operation it performs:
  the wire arguments that apply it to the parity fixture (`fixture.ts`), the
  setup that makes it applicable, the Boa named-function call, and, where an
  editor command performs the same edit from a selection, that command.
- **The reference** is the wire: `client.mutate({ op, args })`.
- **Surfaces and their doors** (`doors.ts`). A door is _named_ (the surface
  names the operation), _typed_ (the surface's typed-command door, arguments
  checked against the operation's schema) or _generic_ (the surface's raw
  door for any mutation):

  | Surface       | named                                                                           | typed                                                                                                           | generic                |
  | ------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------- |
  | Editor UI     | a command run from a selection (`paged.object.group`)                           | the typed-command dialog submitting `core.<op>` (`paged.core.<op>` entries, the `paged.core.runCommand` picker) |                        |
  | Plugin API    |                                                                                 | `host.objects.invoke("core.<op>")`                                                                              | `host.document.mutate` |
  | Boa `paged.*` | `paged.<op>(…)`                                                                 | `paged.invoke("core.<op>")`                                                                                     | `paged.batch([…])`     |
  | `editor.*`    | `editor.runCommand(id)`                                                         | `editor.batch([{ op: "invoke" }])`                                                                              | `editor.mutate`        |
  | CLI `paged`   | `paged script` (the named function, natively)                                   | `paged invoke <doc> <op> <args>`                                                                                |                        |
  | MCP           | the `run_script` tool (not executed: the same native session as `paged script`) |                                                                                                                 |                        |
  | Viewer SDK    | none: it links no mutation crate                                                |                                                                                                                 |                        |

- **In process**, every door starts from the fixture plus the case's setup
  and is compared with the reference dump. **The CLI** runs the real `paged`
  binary on the precondition saved as `.paged`, and its saved result is
  compared with the reference saved and reloaded. Without a binary
  (`PAGED_CLI_BIN`, or `engine/core/target/{release,debug}/paged`, built with
  `cargo build -p paged-cli`), the CLI doors report
  `unavailable: paged-cli: …` (`PAGED_REQUIRE_PAGED_CLI=1` turns that into a
  failure); CI's editor job has no binary, so the CLI column is measured
  locally.
- **Findings.** A door that disagrees with the reference is a finding,
  recorded in `findings.ts` (`<case> <door>` → id, what happens, what should)
  and run as `test.failing`: it fails for the finding's reason today, and
  when the product is fixed the test passes, `test.failing` fails, and the
  entry is deleted with the fix. A disagreement not on record fails the
  suite.
- **Engine traps.** A case that makes the engine panic poisons its wasm
  instance; the suite records the trap and continues on a fresh editor.
- **Gaps** (a surface with no door to an operation) and operations with no
  case are rows of the matrix, never test failures.
- **Reads.** The catalog's read functions (`reads.ts`: the collections,
  `documentMeta`, `tree`, `inspect`, `query`, `get`, `schema`) are asked
  through Boa, the plugin API, `editor.*` and the CLI and compared with the
  wire's answer (`paged.schema`, which has no wire read, with the plugin
  API's). Two representations are the same value by design and are unwrapped
  first: a wire `Value` (`{ type, value }`) and an object-model read
  (`{ kind: "value", value }`); a Boa function's JSON text is parsed.
- **Fonts.** The suite's editor loads no default font and the CLI runs with
  `--no-default-font`: a font changes layout, never which surface reaches
  what, and the default faces cost memory on every load (findings PAR-1 and
  PAR-2, `tests/headless/engine-memory.test.ts`). Some 1,500 loads run in one
  process; the suite moves to a new wasm instance
  (`rebootHeadlessEngine`) before the 4 GB address space fills, and after
  an engine trap.

### The matrix

The run builds the matrix, operation × surface, and checks it against the
committed artifact: [surface-parity-matrix.json](surface-parity-matrix.json)
(what the check compares) and [surface-parity-matrix.md](surface-parity-matrix.md)
(what people read). A cell is the most specific door the surface has and what
the run measured through it:

| Symbol | Meaning                                                                  |
| ------ | ------------------------------------------------------------------------ |
| `=`    | parity: the model dump is identical to the wire reference's              |
| `≠`    | differs: a finding (its id beside it)                                    |
| `·`    | reachable but not run: no case for the operation yet, or (CLI) no binary |
| `–`    | no door: a gap                                                           |
| n t g  | the door kind measured: named, typed, generic                            |

A case marked `(no-op)` applied without changing the dump; its parity is weak
evidence. The summary table counts each surface's door kinds and statuses;
below it, the second axis: how many of the engine's message kinds the CLI
sends (the CLI's own gate, `paged-cli/tests/it/cli_surface.rs`).

Regenerate after a change that moves a cell:
`PARITY_WRITE=1 bun run test:headless` (from `apps/editor/apps/canvas`, with
the `paged` binary built, so the CLI column is measured). The check compares
everything else when the binary is missing.

### Adding a capability or a surface

- **A new catalog operation** appears as a row with no case (`·` on every
  surface that reaches it, `–` where none does) at the next regeneration, and
  the matrix check fails until the artifact is regenerated. Give it a case in
  `cases.ts`: wire args on the fixture (extend `fixture.ts` if it lacks the
  object), a `setup` when it needs one, and the `boa` call.
- **A new door** of an existing surface is an entry in `IN_PROCESS_DOORS` or
  `CLI_DOORS` (`doors.ts`) with its kind, `reaches` (derived from the
  surface's own list: the object registry's commands, the catalog's host
  functions, `paged ops --json`, the registered editor commands; never a hand
  list) and `run`; give it its `covers()` ids in `renderCovers` (`matrix.ts`).
- **covers()**: the gate reads string literals only, so the suite's ids are
  a GENERATED literal table, `parity/script-door.covers.generated.ts`,
  written with the matrix from the cases and doors the run executed
  (`PARITY_WRITE=1`). Regenerate it in the same commit as a case or a door.
- **A new surface** is a `SURFACES` entry (`matrix.ts`) and its doors.
