# ADR 1014 — Bindings live in labels, and the engine reads and applies them

- **Status:** Accepted 2026-10-24.
- **Scope:** `paged-data-*` (moved from `modules/data`, PM-0015 step 3); `paged-data-session`
  (`DataSession`, moved from `data-js`; `labels.rs`; `refresh_queries`); `paged-data-store`
  (`guard.rs`); `paged-wire` (`selector.rs`: escapes in quoted values); `paged-cli`
  (`data.rs`, `paged data bindings`, `paged data apply`). Decided by
  [PM-0015](../../../../docs/adr/PM-0015-data-and-actions-are-platform-layers.md) (record
  "core 1014"); follows [ADR 1000](1000-a-template-policy-lives-in-labels.md), which put the
  template policy in labels for the same reason.

## Context

paged.data binds page items, text variables and object properties to data. Since data ADR 559 it
writes each binding whose target is one page item into that item's label
(`x-paged:media.paged.data`: the binding with its target relative to the item, the queries it
reads, the source descriptors), and the whole recipe into the document label. Labels are what
InDesign keeps through an open and a save; the container part paged.data also writes is dropped
there, and every `Self` is renumbered.

Only the data module read those labels. A document's bindings were inert anywhere the module was
not loaded: on the command line, on the server, in another host. PM-0015 makes data a platform
layer, with bindings part of the document model (L1) and the binding engine an engine crate (L2).

## Decision

**The label is the model's form of a binding.** No second representation is added to
`paged-model`: a binding stays where the document already carries it, in labels that IDML, the
`.paged` model part and undo all keep. What changes is who can read them. The binding engine is in
the engine (`engine/core/crates/paged-data-*`, moved with their history), and the session that joins
it (`paged-data-session`'s `DataSession`) with it; `modules/data/data-js` is the wasm shim over
that session.

**One reader.** `data_session::labels::restore_from_labels` rebuilds the recipe from a document's
labels. It is the Rust form of the bundle's `restoreFromLabels`:

- the document label's recipe first, then every element label;
- an element's copy of a binding wins, because its target is the element as it is today;
- InDesign's `<?AID xxxx?>` escapes are decoded.

Both readers replay `modules/data/conformance/labels/cases.json`, whose answers are recorded from
the bundle's reader, so a document reads to the same recipe in the editor and on the command line.

**One guard.** A query in a document is code the document carries (data spec §11). Before the
store runs it, it passes `data_store::guard::check_query`, the Rust form of the bundle's lexer
guard:

- one SELECT over the source tables;
- no statement word;
- no table function that reads a file or a URL.

Both guards replay `modules/data/conformance/query-guard/cases.json` (41 refusals, 9 admitted
queries with their rows). `DataSession::refresh_queries` runs the session's queries as the
bundle's refresh does: each one is guarded, and a refused or failed query is reported while the
others still run.

**The engine applies them.** `paged data bindings DOC` lists the bindings the labels carry, the
object each one writes, and the files the recipe's sources ask for. `paged data apply DOC
--source ID=FILE … --record N -o OUT` works in four steps:

1. Import each file into the store under its source id.
2. Run the queries through the guard.
3. Resolve the bindings at record `N`.
4. Write the values with `Mutation::Set`, the door the editor and `paged set` use. Property
   bindings are written on the objects their selectors name; variable bindings on their text
   variables (`paged:<key>`, `textVariableContents`).

What the headless lane cannot write yet is listed per binding as `notHeadless`, never skipped. That
covered images, tables, barcodes, record flows, rules, and a colour no swatch has (these need the
module's lowering writers or a swatch mint). Amendment 3 writes all of them but record flows and
two image references; amendment 4 writes record flows; amendment 5 writes a remote image whose
origin the run lists; amendment 6 writes a document asset id whose bytes a `.paged` carries.

**One selector grammar.** The durable selector of a labelled page item is
`frame[label.x-paged:media.paged.data*="\"oid\":\"pd-…\""]`, a quoted value holding its own quotes.
The SDK's parser reads a backslash in a quoted value as an escape. The engine's did not: it refused
the selector, and the SDK fell back to its own evaluation. The engine's parser now reads `\x` as `x`
too. A selector with a backslash in a quoted value therefore means the same in both. Before, such a
selector meant a literal backslash in the engine, or was refused there.

## Consequences

- A bound document can be filled from CI, the server or a script with no module loaded, and
  `paged` answers what a document binds and which files it needs.
- The command line refuses the same queries the editor refuses, for the same reasons.
- The engine workspace builds Turso and the data crates; the `paged` binary links them. The
  published wasm packages (`canvas-wasm`, the viewer) do not depend on them.
- serde_json's `float_roundtrip`, which the data crates use, unifies across a `--workspace` build of
  the engine. The engine's suite passes with it.
- The `paged` binary is the one engine artifact with a network client (amendment 5): an optional,
  default-on `fetch` feature of `paged-cli`, reached by no crate a wasm package builds.
- Still to come: a `data@1` door over the same session (extensions ADR 343), and the bundle calling the
  engine's reader and guard instead of keeping its own (one implementation instead of two, held
  together by the shared cases until then).

## Amendment (2026-10-24): `paged.data.*` in the interpreter

PM-0015 ("One script interpreter") gives the engine's Boa interpreter `paged.data.*` next to
`paged.actions.*` ([ADR 1015](1015-paged-action-the-action-registry.md)). The interpreter holds no
data. Its embedder implements `paged_script::ScriptData` and attaches it for one run with
`paged_script::with_data(&mut data, || run)` (`paged-script/src/data.rs`). The door sits in a
thread-local for the length of that call and is removed when it returns, so it never reaches the
next run. A script calls:

- `paged.data.tables()`: what the run can read.
- `paged.data.records(table, { offset?, limit? })`: a window of a table.
- `paged.data.query(sql)`: the rows of one SELECT.
- `paged.data.evaluate(query, expr, record)`: a binding expression's `{ display, value, error? }`
  at a record, as the bind popover previews it.

Record sets have the provider shape `{ schema: { fields: [{ name, ty }] }, columns, rowCount }`
(`record_set_json`). An error the door reports becomes an `Error` the script can catch. With no
door attached, every call throws a TypeError that says no data is attached to this run. That was
the editor's worker until amendment 2. A script never gets an empty answer that looks like data.

`paged script DOC SCRIPT --source ID=FILE …` attaches one. `script_data` (`paged-cli/src/data.rs`)
builds a `DataSession` from the document's binding labels as `paged data apply` does: it imports
each file under its source id and runs the recipe's queries through the guard. A `--source` the
recipe does not declare is imported by its file's extension, so a script can read a file into a
document that binds nothing yet. The door answers as follows:

- `tables` gives `{ sources: [{ id, imported }], queries: [{ id, sql, rowCount, error? }],
  tables }`.
- `records` reads `store_records`.
- `query` runs `data_store::guard::check_query` first, then `store_query_records`. A script's SQL
  is refused for the same reasons a document's queries are.
- `evaluate` calls `evaluate_at`.

With no label and no `--source`, nothing is attached.

## Amendment 2 (2026-10-25): the editor attaches a door

The editor runs scripts in its canvas worker; the data lives on the main thread, behind the async
data service paged.data serves (the one the Data panel reads). `ScriptData` is synchronous, so the
worker bridges the two over shared memory:

- `paged-canvas-wasm` exports `CanvasWorker.setScriptDataBridge(bridge?)`. `bridge(method,
  argsJson)` returns an envelope, `{ "ok": value }` or `{ "error": message }` (a bare value would
  be ambiguous: `evaluate`'s answer has an `error` field of its own). `BridgeData`
  (`src/script_data.rs`) is the `ScriptData` over it. The arguments are positional: `tables []`,
  `records [table, { offset, limit? }]`, `query [sql]`, `evaluate [query, expr, record]`.
  `WorkerCore` dispatches every message inside `with_data` while a door is set, so a script that
  resumes after a host-objects round still reads it. The door is a plain export, not a message
  of the channel: the protocol does not change. `undefined` removes it.
- The worker's `bridge` posts `{ kind: "dataCall", id, method, args }` and blocks on
  `Atomics.wait` over a SharedArrayBuffer until the main thread writes the answer and notifies
  (`@paged-media/client`'s `sab/data-bridge.ts`). An answer larger than the buffer comes in
  chunks, each asked for with `dataMore`. No answer within 30 s is the call's error; the late
  answer is dropped. The main thread answers from the data service serving the document now;
  with none, the call fails with "no data is attached".
- `CanvasClient.setScriptData(answer)` installs it; the editor does so when its data backend is
  there. Without cross-origin isolation there is no SharedArrayBuffer, nothing is installed, and
  the interpreter's own refusal stands.

The CLI's door is unchanged, and so is the refusal of a run with none.

## Amendment 3 (2026-10-28): the lowered kinds headless

`paged data apply` now writes the binding kinds the engine lowers (`paged-data-lower`), not only
property and variable bindings. The engine resolves and lowers each binding at record `N`, as the
editor's session does. `paged-cli/src/data.rs` then sends the mutations the module's writers send
(`data-bundle/src/lower.ts`), through the same `Session::send`. Each binding still reports one
outcome: `written`, `kept` (a pinned or overridden binding, a missing policy that writes nothing),
`failed` (with the engine's or the writer's reason) or `notHeadless`.

What is written now:

- **Visibility.** It was already written, without being listed: `resolve_properties_at` resolves
  a visibility binding as the `elementVisible` property it is (data ADR 558 §4). It is now tested
  and documented. The `Leave` missing policy writes nothing (`kept`).
- **Tables.** A native table goes into the story of the text frame whose label carries the
  binding. One batch holds `insertTable`, `bindCreated` and one cell `insertText` per non-empty
  cell. The new table's id is kept in that frame's label, under `extra.<binding>.tableId`. The
  next apply deletes that table (`deleteTable`) in the batch that inserts its replacement, so
  applying again replaces the table instead of adding a second one. The frame stays as the user
  left it. A table binding that no text frame carries is `notHeadless`: placing a fresh frame
  stays with the module.
- **Images.** A local `path` is read next to the `--source` files (relative), or as given
  (absolute; a `file://` prefix is dropped). Inline `bytes` are used as they are. Either kind
  goes into the bound frame through `ReplaceImageBytes`, the lane `paged place` uses: a
  `placeImage` link would resolve against a resolver this door never populates. Then the fit is
  set (the label's fit, else the engine's `ImgFit` mapped as `idmlFit` maps it), together with
  the fitted inner transform `paged place --fit` writes. Bytes the engine cannot decode are
  `failed`.
- **Barcodes.** The engine encodes the symbol and scales it into the frame's box, read through
  `RequestElementGeometry`. Each dark module becomes a closed `insertPath`, taken through the
  frame's own transform, with the lowering's paint triples (`Color/Black` fill, `Swatch/None`
  stroke). Every module is stamped `{ kind: "barcode", binding }`. The next apply deletes the
  stamped modules after drawing the new ones, in the same batch: core refuses inserts that
  follow deletes of the same spread's items. The module's writer stamps only a symbol's last
  module (one label op per symbol, not per module: the module's W4 count budget holds), and
  since 2026-10-28 that stamp also carries the symbol's module count (`modules`). The headless
  writer takes the unlabelled polygons painted just before such a stamp, up to that count, with
  it. The module's re-lower already found every stamped module, and now skips a label that
  carries `bind` as the headless writer does. Both writers replace each other's symbols whole;
  a symbol drawn by the module before 2026-10-28 carries no count, so the headless writer
  removes only its stamped module (the module's own re-lower removes it whole).
- **Rules.** The rule's label records the query it is evaluated over and its target
  (`extra.<binding>`: a table column, a story range, or the paragraphs of a story, written by
  the bundle's `property-session.ts`). `evaluate_rule` decides which records fire. A table rule
  sets `appliedCellStyle` on the fired rows' cells; the cell style is created first when the
  document has none by that name, and the styles are read before anything is created. A
  paragraph or character rule sends one `applyStyle` per range (the story's paragraph ranges
  come from `RequestStoryContent`). Rules run after the other kinds, because they style a table
  this apply may just have replaced. A rule fires over all records, so `--record` does not apply
  to it. A rule whose label records no target is `notHeadless`.
- **A colour no swatch has.** The document's swatches are searched as `findSwatch` searches
  them: by `Self`, by name, then as `Color/<name>`. When none matches and the value is a literal
  colour, the swatch is minted (`CreateSwatch`, under InDesign's unnamed-colour name) before the
  property is set. Because the swatches are read first, a second apply finds the one the first
  minted. A swatch name the document lacks, with no literal colour behind it, is `failed`.

What stays `notHeadless`, and why (record flows are written since amendment 4, remote images of
a listed origin since amendment 5, document asset ids a `.paged` carries since amendment 6):

- **A remote image uri whose origin the run does not list.** The editor fetches it on the
  user's consent; the command line on `--allow-origin` (amendment 5). The row's reason names the
  flag with the uri's origin. A binary built without the `fetch` feature has no client and says
  so.
- **A document asset id the input does not carry.** An IDML input has no container parts, and a
  `.paged` may lack the asset index, the id or the part; the reason names which (amendment 6).

One gap this left open was closed on 2026-10-28: the IDML export wrote `AppliedCellStyle` on cells
but no cell style definitions, so a cell style a table rule created was kept in a `.paged` file but
not in an IDML one. The export now writes every cell style the document holds that its
`Resources/Styles.xml` lacks into the part's last `<RootCellStyleGroup>` (gaining the group when the
part has none), with each field the model keeps (name, fill and tint, the four edge strokes,
vertical justification, rotation, the first-baseline policy) and its parent as the typed `BasedOn`
child; a source cell style that was edited is rewritten in place, and an untouched part keeps its
bytes (`idml-export` `cell_style_roundtrip`). An apply on an IDML file finds the style it created.

## Amendment 4 (2026-10-28): record flows headless; what the two image references still need

`paged data apply` now writes record flows. `apply_record_flow` (`paged-cli/src/data.rs`) is the
headless twin of the module's flow writer (`data-bundle/src/flow-writer.ts` `commitRecordFlow`),
with the re-lower plan of `relower.ts` (`planRelower`):

- **Pagination is the engine's.** The flow is paginated over margin-box frames, one per page, as
  `paginateOverPages` does. A first pass over one unbounded frame counts the blocks; the second
  pass gets a chain of that many frames, each the start page's margin-box height, with the
  binding's own header options (`DataSession::flow_layout`). Each frame holds exactly the blocks
  the paginator put there. It shows one paragraph per header, record field line and footer, and a
  re-emitted header is marked "(continued)". The frames are not threaded: a thread would let the
  layout break the text again, which the module's writer avoids too.
- **The start page.** It is the page of the frame whose label carries the binding. The editor
  uses its active page; the command line has none. With no such frame on a page, the flow starts
  on the first page. The second and later frames go on pages added after the start page (one batch
  of `insertPage`). One batch places the frames: `insertTextFrame` on the margin box, then
  `bindCreated`, the frame's text, and its stamp.
- **The stamps.** Every frame is stamped as the module stamps it: `{ kind: "recordFlow",
  binding, frame, records }`, with `createdPage` on the frames on added pages. Either writer
  therefore finds the other's flow. The next apply deletes the stamped frames, and the added pages
  that hold nothing else once those frames are gone. These deletes ride the frames' batch, after
  the inserts, because core refuses inserts that follow deletes of the same spread's items.
  Sometimes the frame that carried the binding (`bind`, after the editor synced its labels) is one
  of those deleted. Its persistence keys (`oid`, `bind`, `queries`, `sources`, `extra`) then move to
  the new first frame, so the binding stays in the document.
- **Overset.** The paginator measures with the template's line height. After the frames are
  placed, the engine's own layout is read for each frame (`RequestFrameChain`, the read behind the
  editor's overset issue). The row reports the frames whose text oversets (`value.overset`). It
  also reports the frames, the pages, how many pages were added, and how many records were placed
  of how many.
- **`--record` does not apply.** A flow places every record of its query, as a rule fires over
  every record. A flow with no records removes the previous flow; when there is none, it is
  `kept`.

The two image references stay `notHeadless` (since amendment 5, a remote uri of a listed origin is
placed):

- **A remote image uri.** The editor fetches it only for an origin the user consented to (editor
  ADR 218; data spec §11). The engine workspace has no HTTP client and no TLS stack, so the command
  line still never reaches the network. A per-origin opt-in on `paged data apply`
  (`--allow-origin ORIGIN`, exact `scheme://host[:port]`, HTTPS except for localhost, with a size
  cap and a timeout) needs that dependency. It is added only together with its licence review
  (`cargo deny check`).
- **A document asset id** (`asset:<id>`; placed from a `.paged` since amendment 6). No document
  keeps an asset id's bytes. The `.paged`
  container's data parts hold source files and applied values (`persist.ts`), not pictures. An
  asset column's fetched bytes live in the module's per-user blob store (`host.blob`), outside the
  document. The reason in the row says so. (Since 2026-10-28 the editor places an asset id the
  document carries, as the command line does.)

## Amendment 5 (2026-10-28): remote images on consent

`paged data apply` fetches the image a remote uri names (`http://…`, `https://…`) when the run lists
its origin, and places the bytes exactly as it places a local `path` image: the decode check
(`failed` on bytes the engine cannot decode), `ReplaceImageBytes`, the fit and the fitted inner
transform. The policy is `paged-cli/src/fetch.rs`.

- **The flag.** `--allow-origin ORIGIN`, repeatable. ORIGIN is `scheme://host[:port]` (a lone
  trailing `/` is accepted; a path, a query or user info is an error). Origins compare exactly
  after normalising: scheme and host lowercased, and the default port (443 for https, 80 for
  http) the same whether written or implied. `https://example.com` is not
  `https://images.example.com`, `http://example.com` or `https://example.com:8443`.
- **No flag, no fetch.** A uri whose origin no flag lists is `notHeadless`, and nothing is sent to
  it. The reason names the flag with that origin (`--allow-origin https://example.com`).
- **Redirects.** None is followed by the client itself. The policy follows at most 3, each only to a
  listed origin, checked before the request; a `Location` is resolved against the URL that
  answered. A redirect to an unlisted origin is `failed`, naming that origin, and that origin is
  never asked. A fourth redirect is `failed`.
- **http for localhost only.** https for any listed origin; plain http only for `localhost`,
  `127.0.0.1` and `[::1]`. Any other http origin, listed or redirected to, is `failed` ("plain
  http is refused except for localhost").
- **Limits.** At most 50 MiB of body: the read stops at the cap and the binding is `failed`. 30 s
  for the whole fetch, redirects included. `User-Agent: paged/<version>`.
- **Nothing ambient.** No cookie store (ureq's `cookies` feature is off). No credentials: a URL with
  user info is refused, and no `Authorization` header is sent. No proxy: ureq's default reads
  `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` from the environment, and the agent sets the proxy to
  none, because a proxy is a host the run did not list. No content encoding is asked for (ureq's
  `gzip` feature is off), so the cap counts the bytes on the wire.
- **The client.** `ureq` 3 (MIT OR Apache-2.0), blocking, on `rustls` 0.23 with the `ring` crypto
  provider. Not aws-lc-rs: it needs cmake and a C toolchain beyond the `cc` build ring has. The
  roots are the platform's trust store, read through `rustls-native-certs` (Apache-2.0 OR ISC OR
  MIT; the system keychain on macOS, the OS bundle elsewhere, or `SSL_CERT_FILE` / `SSL_CERT_DIR`),
  loaded only for an https fetch. A machine therefore trusts on the command line what its browser
  trusts, enterprise roots included, and no bundled root set goes stale with the binary. It also
  keeps the licence allow-list as it is. `webpki-roots` and `rustls-platform-verifier` (which
  pulls `webpki-root-certs` on some targets) are CDLA-Permissive-2.0, which `deny.toml` does not
  list. Every crate the client adds (ureq, ureq-proto, rustls, rustls-webpki, rustls-pki-types,
  rustls-native-certs, ring, untrusted, zeroize, http, httparse, percent-encoding, utf8-zero, and
  per platform security-framework, core-foundation, openssl-probe or schannel) is MIT, Apache-2.0
  or ISC, and `cargo deny check` passes.
- **Native only.** The client is an optional dependency of `paged-cli` behind its default-on
  feature `fetch`. A `--no-default-features` build has no network client: a remote image stays
  `notHeadless`, and its reason says the build has no client. No crate a wasm package builds
  reaches it (`cargo tree -p paged-canvas-wasm --target wasm32-unknown-unknown` holds none of them).
- **One rule.** The editor fetches a remote source or image only for an origin the user consented
  to, and only for one its build lists (editor ADR 218; data spec §11). `--allow-origin` is the same
  rule expressed per run: the person who runs the command consents by naming the origin, for that
  run only. Nothing is remembered, and a document never widens it. A document's bindings still
  never fetch on open.

`PAGED_FETCH_MAX_BYTES` lowers the cap for one run (the tests reach it without serving 50 MiB); it
cannot raise it. The tests serve from a listener on `127.0.0.1` inside the test, with no other
network: an unlisted origin (not asked), a listed one (placed, in the saved document, with the user
agent and no cookie or authorization header), a redirect to an unlisted origin (failed, not asked),
a redirect loop (failed after three), and a body past the cap (failed).

## Amendment 6 (2026-10-28): document asset ids from the `.paged` container

A saved `.paged` carries the bytes of its asset columns' pictures (data
[ADR 563](../../../../modules/data/docs/adr/563-asset-columns.md), amended the same day): one part
per content hash, `paged/media.paged.data/assets/<sha256>`, and the index
`paged/media.paged.data/assets.json` (`{ v: 1, refs: { <reference>: { hash, columns } }, assets:
{ <hash>: { mediaType, bytes } } }`). `paged data apply` resolves an `asset:<id>` image reference
from them: the id is looked up as a reference the index lists, else as a content hash it lists;
the part is read through the session's container-part door (`ReadPagedPart`, as `paged parts read`
reads it). The bytes are placed exactly as a local `path` image's: the decode check,
`ReplaceImageBytes`, the fit and the fitted inner transform. The index is read once per apply. The
row's value names the part (`asset:<id> (paged/media.paged.data/assets/<hash>)`).

What stays `notHeadless`, each with its own reason:

- **An IDML input** (`.idml`): an IDML package carries no container parts; its pictures are links.
- **A `.paged` without the index**, or with an index that is not JSON.
- **An id the index does not list.**
- **A part the index names but the container lacks.**

Nothing is fetched for an asset id, and no consent is asked: the bytes are the document's own. The
CLI checks a part's bytes against the SHA-256 its name gives, as the editor does when it reads
one back: other bytes under that name are `notHeadless`. A remote image reference the index lists
is placed from its part the same way, with no `--allow-origin` and no request; one it does not list
goes to the consented fetch of amendment 5. Tests: `data_cli.rs`
(`data_apply_places_a_document_asset_id_from_the_paged_container`,
`data_apply_refuses_an_asset_part_whose_bytes_do_not_match_its_name`,
`data_apply_places_a_remote_image_the_document_carries_without_fetching_it`,
`data_apply_says_which_part_an_asset_id_misses`,
`data_apply_leaves_an_asset_id_of_an_idml_input_unwritten`,
`data_apply_leaves_a_document_asset_id_unwritten_and_says_why`).
