# @paged-media/client

The programmable Paged SDK. One class, `CanvasClient`, over the
engine's workspace package `@paged-media/canvas-wasm` (on npm:
[`@paged-media/paged`](https://www.npmjs.com/package/@paged-media/paged)): load a document, mutate it, read it back, render it, export it —
across a Web Worker, over the same typed wire the Paged editor itself
speaks.

There is no second engine here and no second vocabulary. This package is
the editor's own client. It is a private workspace package, not on npm
([PM-0008](../../../../docs/adr/PM-0008-npm-packages-and-release.md)): the
public write surface is the engine itself, `@paged-media/paged`.

## Which SDK is which

Paged ships two, and they are different on purpose.

|              | `@paged-media/viewer` | `@paged-media/client` (this one)                       |
| ------------ | --------------------- | ------------------------------------------------------ |
| what it does | shows a document      | **changes** a document                                 |
| engine deps  | renderer-core only    | the full canvas engine                                 |
| writes       | none, structurally    | all 117 mutations                                      |
| runs in      | any page with WebGPU  | a page with cross-origin isolation (SharedArrayBuffer) |

The viewer is read-only by design — "sibling, not a shrunk app" — and
growing it into a write surface would undo that decision. If you want to
display an IDML, use the viewer. If you want to author one, use this.

## Install

Inside this repository, depend on it through the workspace
(`"@paged-media/client": "workspace:*"`); `@paged-media/canvas-wasm` comes the
same way. Outside it, use `@paged-media/paged` from npm (`npm install @paged-media/paged`).

The package constructs a `Worker` and reads a `SharedArrayBuffer`, so the
serving page must be cross-origin isolated (`Cross-Origin-Opener-Policy:
same-origin`, `Cross-Origin-Embedder-Policy: require-corp`). Emitted
imports are extensionless ESM: every consumer of this package is a
browser bundle, and already runs a bundler.

## Use

```ts
import { CanvasClient } from "@paged-media/client";

const client = new CanvasClient({
  workerFactory: () =>
    new Worker(new URL("./canvas.worker.ts", import.meta.url), {
      type: "module",
    }),
});

await client.loadDocument(idmlBytes);

// Read: any of the document's 26 collections, generic over the shape
// you expect back.
const pages = await client.collection<{ selfId: string }>("pages");
const meta = await client.documentMeta();

// Write: one door, every operation. A Mutation is `{ op, args }`.
const reply = await client.mutate({
  op: "insertTextFrame",
  args: { pageId: pages[0].selfId, bounds: [72, 72, 720, 540] },
});
// reply.kind === "mutationApplied" — `minted` carries the ids the
// engine just created, which is how you address what you made.

// Out: IDML, .paged, or PDF. An IDML export answers the package and what
// it could not carry (`lost`, one LossEntry per kind).
const { bytes, lost } = await client.exportIdml();
```

`mutate()` takes the engine's `Mutation` type rather than offering a
method per operation, which is why an operation added to the engine is
reachable from here as soon as the types are re-vendored. The typed
helpers (`setSelection`, `registerFont`, `beginGesture`, …) exist where a
call needs shaping; `send()` reaches anything they do not.

## Gestures hold the document

Since protocol 79 (engine ADR 1300) a gesture (`beginGesture` …
`commitGesture` / `cancelGesture`) holds the document: while it is active
the engine refuses every write, undo, redo and script from another door,
whole, with a `mutationFailed` whose error is `gestureInProgress`.

- A write this client sends while a gesture **it** began is live waits for
  that gesture to settle (at most 30 s), so it lands after the gesture.
- `client.gestureActive` says whether one of its gestures is live;
  `await client.whenGestureIdle({ signal, timeoutMs })` waits for none to be
  (`true` when idle, `false` on timeout or abort) — the door for a script
  runner or an interaction coordinator.
- `gestureInProgressOf(reply)` reads the refusal off a reply;
  `executeScript` throws `GestureInProgressError` when the engine refuses.

`beginGesture(nodes, gesture, anchor, modifiers?)` takes the modifiers held
at the press, and an Alt-drag previews the copy its commit makes (engine
ADR 193, amendment 1). `marqueeHits(pageId, rect, { mode, scope })` takes a
`contain` or `intersect` mode and a `document` or `group` scope, with a
rectangle that may cross pages and start on the pasteboard (engine ADR
1011, amendment 1). Snap lines carry `targetKind` (engine ADR 125,
amendment 2).

## Presses, scopes, coalesced writes and losses (protocol 80)

- **A press in one round trip** (engine ADR 1303).
  `beginGestureAt({ pageId, point, modifiers, select, target, scope,
gesture, cameraScale })` hit-tests the press point (page-local pt), changes
  the selection (`select`: `replace` keeps a selection the press lands in,
  `toggle` adds, `keep` moves the selection whatever was hit), and begins
  the gesture on the selection, anchored at the point. `target` picks what a
  press on a group member takes (`outermost`, `leaf`, `inGroup`). The answer
  is `{ hit, target, selection, selectionChanged, handle, marquee,
outOfScope, refused }`: `marquee` when nothing was hit, `outOfScope` when
  the hit lies outside `scope`, `refused` (a `GestureFailure`) when the
  press took an item but no gesture began (a lock, a copy refused). Moves
  are deltas from the press point, so a drag that starts before the answer
  starts where the pointer went down.
- **The edit scope** (engine ADR 1301). `scopeContains(root, ids)` answers
  whether each id lies in `root`'s subtree: a group's members, a
  container's pasted-in children, a text frame's story and the objects
  anchored in it, recursively. `editScope(root)` answers the whole scope
  with a synchronous `contains(id)`, cached per root until the document
  changes.
- **Coalesced writes** (engine ADR 1304). `mutate(mutation, { coalesce })`
  joins consecutive writes with one key into one undo step (an inspector
  scrub: one key per scrub); `endCoalesce(key?)` ends the run, as a write
  with another key or none, a gesture, an undo or a redo does.
- **Duplicates are all or nothing** (engine ADR 1302). An Alt-drag across
  spreads copies each spread's items onto that spread. A selection that
  cannot be copied whole is refused at the press with
  `GestureFailure` `duplicateRefused { id, reason }`; Alt pressed during the
  drag keeps it a move, and the update (or the `gestureSnapLines`
  notification on the shared-memory path) carries `duplicateRefused`.
- **Losses** (`UXI-FIL-002`). `exportIdml({ linkBase? })` answers
  `{ bytes, lost, links }`: `lost` is one `LossEntry` per kind of thing the
  package does not carry (engine ADR 1097). `loadDocument` answers a
  `DocumentHandle` whose `losses` lists what the opened IDML does not carry
  or show as its source did (engine ADR 1305: `idml.import.<what>` codes —
  frames left out, substituted fonts, missing or undecodable links,
  content drawn from a preview or not at all, clipping paths not applied,
  page numbers from a fallback rule), with the items and pages each stood
  on. Other formats report through their own doors: a PSD's layers through
  `requestPsdLayersPlace` (`PsdPlacePlan.losses`), an SVG through
  `svgImportPlan` (`report.losses`), DOCX, PPTX and PDF through their
  modules' import results.

## Editing aids and proofs (protocol 81)

- **Hidden characters** (engine ADR 1306). `hiddenCharacters(pageIds)`
  answers, per page asked for (the pages in view), per composed line, where
  its invisibles stand: each mark's `kind` (`space`, `nonBreakingSpace`,
  `fixedSpace`, `tab`, `forcedLineBreak`, `discretionaryLineBreak`,
  `anchoredObject`, `paragraphEnd`, the break characters `columnBreak` …
  `evenPageBreak`, `storyEnd`) and its `x` and `width` on the line, with
  the line's `baseline`, text `size` and `turn` (the affine a turned frame
  or a vertical story applies; absent when upright). Draw them over the
  page; they are never in the page's raster.
- **A frame's own baseline grid**. `frameBaselineGrids(pageIds?)` answers
  every text frame that uses a grid of its own, with its box and transform
  (as `elementGeometry`), the first line below the frame's top edge
  (`start`), the `increment` and what it is measured from (`relativeTo`).
- **Proofs and nonprinting items**. `setViewSettings` takes
  `hideNonprinting` (the screen leaves nonprinting items out, as print
  does, and nothing hits them) and `proof` (no page edge, no degraded-asset
  markers). Both rebuild the pages: the `viewSettingsApplied` reply says
  `rebuilt`. Neither changes the document.
- **Facing pages** (engine ADR 1307). `newBlankDocument(width, height,
font?, { pages, facingPages })` makes that many pages, as facing spreads
  when asked: page 1 alone as a right-hand page, then left/right pairs.
- **Relink** (engine ADR 1308). `mutate({ op: "relinkImage", args: {
elementId, uri, bytes? } })` — or `mutateWithBytes` with `bytes: []` and
  the file's bytes — points a picture at a new source in one undo step,
  keeping the frame, its fitting and the picture's size on the page.
- **One screen extent**. The wasm `renderTilePng` draws a page's screen
  extent (its trim grown to its bleed and pasteboard artwork) on a
  transparent ground; `screenExtent(pageId)` says where the tile goes, the
  rect the GPU lane clips to.

## The catalog

`api-catalog.json`, shipped in this package, is the machine-readable
surface: every public member with its signature and summary, plus
`wireKinds` — which of the engine's message kinds this client reaches.
It is **generated** from the source (`scripts/client-api-catalog.mjs` in
the editor repo), so it cannot drift from the code, and a public method
without a doc comment fails the build rather than shipping undocumented.

Read it to answer "can the SDK do X" without reading the source:

```ts
import catalog from "@paged-media/client/api-catalog.json";
catalog.wireKinds.includes("exportPdfBegin"); // true
```

## Versioning

`0.<protocol>.<patch>` — the same scheme as `@paged-media/canvas-wasm`.
The minor is the wire protocol version this client speaks, so a client
and an engine that share a minor are compatible by construction.

## License

AGPL-3.0-only OR the Paged Media Enterprise License (PMEL). See
`LICENSE.md` in the repository root.
