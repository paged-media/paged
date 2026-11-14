# ADR 1232 — Performance budgets

- **Status:** Accepted 2026-11-14 (plan task AP5 of
  [`interaction-plan.md`](../interaction-plan.md)).
- **Scope:** `apps/canvas/src/worker/render.ts` (the CPU path's schedule and tile budget),
  `apps/canvas/src/ui/typing-coalescer.ts` and `ui/useTextEditing.ts` (typing),
  `packages/client/src/journal/codes.ts` (`worker.paint.first`),
  `apps/canvas/tests/perf/budgets.perf.spec.ts` (the budgets and the stress suite),
  `.github/workflows/editor-perf-nightly.yml`, `docs/reference/performance.md` (the method and
  the numbers), the inventory's exception `EXC-003`.
- **Requirements:** `UXI-PRF-001` to `PRF-007` of the interaction specification (§20); UX
  audit F-53 (its rendering half), F-54, F-56; gate G3's performance budgets.

## Context

The October audit measured selection at 34–49 ms, typing at 49–51 ms (median) and 235 ms in
a burst (F-56), the first visible page of a 54 MB and a 105 MB real-world IDML template at
14.6 s and 21.5 s (F-53), and 1.7 to 3.6 GB of page and worker memory on those files (F-54).
The specification asks for those numbers to be measured again on the current build before
any threshold is set, for p95 and p99 rather than means, for the viewport's pages first with
stale requests dropped, and for explicit budgets and eviction for every cache. The editor
had a latency probe for its panels (`tests/perf`) and generous op ceilings in an e2e spec,
no budget run on a schedule, and no number for the first paint but a screenshot poll.

On the CPU path (the browsers and machines without WebGPU, and every headless run) the
worker rendered every visible page's tile in the same tick, synchronously, before anything
reached the screen, and kept every tile it ever decoded. Every typed character was its own
`insertText`, sent at once; in a burst they queued in the worker, one relayout each.

## Decision

1. **Measured, with the audit's methods**, by `tests/perf/budgets.perf.spec.ts` (the `perf`
   Playwright project): selection (a real click to the selection mirror to the next frame),
   typing (a keydown to the reply that carried its character to the next frame, at a normal
   pace and in a burst), the first visible paint (the worker's own `worker.paint.first`
   journal entry, and the audit's screenshot poll beside it), and memory
   (`measureUserAgentSpecificMemory`, page and workers). Every latency is reported as p50,
   p95, p99 and max. The method and the numbers, with the machine's load at the time, are in
   [`reference/performance.md`](../reference/performance.md).
2. **Budgets.** The spec's targets (§20.2) are the direction; what fails is a regression of
   several times, never jitter: selection p95 under 250 ms, typing p95 under 300 ms at a
   normal pace and 1 s in a burst, the generated 40-page document's first paint under 30 s
   and its memory under 3 GB (`BUDGETS`). The nightly workflow
   (`editor-perf-nightly.yml`, a schedule and `workflow_dispatch`, never a push) runs them on
   the production build, reports the JSON as an artifact and a summary, and fails only past
   those numbers.
3. **The stress suite.** A 40-page document of 48 frames and a story each is generated in the
   spec (no corpus); `PAGED_PERF_LARGE_IDML` adds any local files (a path that is not there
   reports `unavailable`, never a pass). The slow-worker hooks of fixture H (`?debug=chaos`)
   drive the late-answer cases the UXI specs already hold.
4. **The viewport first (UXI-PRF-001, PRF-005).** The CPU render renders one tile per tick:
   of the visible pages still without one, the page nearest the viewport's centre; each tick
   plans again from the camera it has, so a page that scrolled away before its turn is never
   rendered (nothing is queued that a camera move could make stale). With every visible page
   drawn, the two pages either side are rendered ahead, one per tick. The GPU path builds the
   visible pages' scenes before its first present and keeps an LRU of 200 page scenes (the
   engine's `scene_cache`); WS7's first-page fit keeps that first present to one page.
5. **Budgets for the caches (UXI-PRF-004).** The CPU tile cache holds at most 64 MB of decoded
   tiles; past it the tiles drawn longest ago go, never one on screen. The page thumbnails
   are one compressed PNG per page, dropped with their page. The undo log keeps at most its
   history depth (10,000 by default, the History panel's setting). Fonts live as long as their
   document. The engine's decoded-image cache has no budget yet: every rebuild composes every
   page, so an evicted image would be decoded again on the next edit; a budget that holds
   needs images decoded at the size they are shown and the visible pages composed first. It
   is the inventory's exception `EXC-003` (engine work, with an expiry), not a silent gap.
6. **Typing that outruns the engine is folded (F-56).** While one insert is in flight, the
   characters typed behind it at the advancing caret wait in one pending insert, sent as one
   mutation when the reply comes: one relayout per round trip however fast the keys come.
   Every other request of the text editor (a delete, a caret move, a style, an undo, a read)
   sends what is pending first, so the order is the user's. At a normal pace nothing is ever
   pending. An insert is one undo step as before; folded keys are one step together, as a
   held arrow's folded nudges are (ADR 251).

## Consequences

- The numbers of `reference/performance.md` replace the audit's as the baseline. F-56 is
  addressed (keys fold: 88 keys of a burst went as 58 to 72 inserts) but not yet proven faster
  on the shared development machine, and stays open until the nightly's numbers show the burst
  flat; F-54 is measured, and its decoded-image half stays open as `EXC-003`. The 105 MB
  template's first page shows 4.2 s after the file is chosen (21.5 s in the audit); the 54 MB
  one's first page costs 8.6 s of engine composition on the CPU path.
- A cache added later states its budget and its eviction in `reference/performance.md`.
- The nightly job needs no secret and no corpus.

## Amendment 2026-11-14: decoded pictures have a budget (engine ADR 1311)

The exception `EXC-003` is closed and removed from the interaction inventory. Placed pictures
are drawn from the engine's decoded-picture store
([engine ADR 1311](../../../../engine/core/docs/adr/1311-a-picture-is-decoded-at-the-size-it-is-shown.md)):
one store per worker, shared by the CPU tiles, the page thumbnails and the GPU page scenes, each
picture decoded at the level its draw needs (a JPEG at its DCT scale) and kept within a 256 MiB
budget, the pictures drawn longest ago evicted first; exports and fidelity renders still take
every pixel. Every journal drain records what the worker's caches hold (`worker.caches`: the
store, the CPU tiles, the GPU scenes), and the performance suite reports it with the memory. On
the 54 MB template the first visible page came 4.4 s after the layout instead of 6.3 s, 10.7 s
after the file was chosen instead of 17.0 s, with 36 MB of pictures held when opened and 62 MB
after use (`reference/performance.md`).

## Amendment 2026-11-14: a burst of typing is one change for the panels (F-56)

Measured with the engine's own time per insert and the requests sent while typing (both now in
the suite's report): the engine lays a typed insert out incrementally (engine ADR 027) in 1 ms
on fixture A and 7–10 ms on the 40-page stress document, and a burst was slow because every
insert's change made the panels re-read the document — some 210 requests per key on fixture A,
230 on the stress document — and the next insert waited behind them in the worker. The text
editor now sends a typed insert as `mutate(…, { typing: true })`: the client answers the caller
at once and holds the change's broadcast until the keys pause (`TYPING_SETTLE_MS`, 160 ms; at
least every `TYPING_HOLD_MAX_MS`, 600 ms), merging the held changes into one (every page they
changed, the last step); any other change of the document lets it out first, so subscribers
still see changes in order (extensions ADR 327 amended). The caret a typed key advanced reaches
the selection's listeners the same way. Typing in a burst on fixture A went from 197 / 374 / 490
and 106 / 254 / 388 ms (p50 / p95 / p99, two runs) to 94 / 181 / 243 and 94 / 235 / 323; on the
stress document from 208 / 702 / 868 and 147 / 349 / 437 to 69 / 304 / 431 and 89 / 266 / 594,
with 56 to 62 requests per key instead of 204 to 236. That the layout stays the whole
document's is a property test now: seeded bursts of folded inserts, paragraph breaks and
backspaces on six generated documents, each operation checked against a cold build
(`engine/core/crates/paged-canvas/tests/it/typing_bursts.rs`). F-56 is closed on these numbers;
the nightly keeps measuring.

## Amendment 2026-11-14: the first page is composed first (engine ADR 1314)

A file the editor opens is loaded progressively (`loadDocument(…, { firstPages: [0] })`): the
engine composes the spreads of the first page and answers a provisional document, and the worker
composes the pages in view, then the whole document, one step per task (`ComposeNext`), reading
the pages in view from its last draw, so a camera move between two steps changes what the next
composes. A page not composed yet is outlined on the canvas and never drawn blank; the loading
status says "Composing pages · 3 of 12 · provisional" in real counts (editor ADR 1208 amended),
and the thumbnails of pages 2 onward are taken once the composition is final. The final
composition is the whole document's build, and a test holds it equal page for page to a model
loaded whole and to a cold build (engine `tests/it/progressive_composition.rs`). On the 54 MB
template the first paint moved from 4.4 s to 3.7 s after the layout: the package's parse and
the first GPU present of a page of photographs, not the composition, are what remains
(`reference/performance.md`).
