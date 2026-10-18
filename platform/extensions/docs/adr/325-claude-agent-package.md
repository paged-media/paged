# ADR 325 — Claude for paged is one package: prompt, tools, loop and proxy

- **Status:** Accepted, 2026-10-11. Amended 2026-10-16: the CLI command is `paged-node ai`
  (see the amendment below).
- **Scope:** `packages/ai` (`@paged-media/ai`, entries `.`, `./proxy`, `./catalog`); the `ai` verb
  and the `paged.ai.complete` registration in `packages/cli`; `HeadlessHost.newBlank` in
  `packages/plugin-sdk/src/harness.ts`.

## Context

paged's scripting surface (`paged.*` in Boa) and its capability catalog were built so that a
model could drive the engine: the catalog's constraints are written for one. Nothing called a
model yet. Three consumers need to: the editor (in a browser, without a key), the Node CLI (with
the caller's own key) and the editor's same-origin proxy (on a server, with the platform key).
If each wrote its own prompt, tools and loop, they would drift, and the proxy could not check
what the browser asks for.

## Decision

**One package, `@paged-media/ai`, holds everything that is the same in all three:**

- the model (`claude-haiku-5-5`) and a per-mode table (`script`, `assist`, `complete`,
  `document`) of effort, output cap, tools and turn limit. Effort is set explicitly; Haiku 5.5
  defaults to `medium`, and nobody chose that default;
- the system prompt: an authoring guide (how a paged document works, how to script it, two
  worked examples that a test runs against the real engine) followed by the engine catalog,
  marked as a cache breakpoint because it is byte-stable;
- the tools: `run_script`, `lookup_api` (a catalog lookup, so the ~35k-token property schemas
  stay out of the prompt) and `render_page` (a PNG of a page for visual checks);
- the loop: run the script, report its error, budget trip, output and the stories left overset,
  let the model correct, stop on the summary, a refusal, a truncated tool call, repeated invalid
  tool input or the turn cap. Assistant turns go back unmodified, thinking blocks included;
- two transports behind one interface: direct (an Anthropic client) and proxy (the editor's
  same-origin route, sending only the mode and the conversation);
- the proxy's server half (`./proxy`): a Fetch-API handler that rebuilds the request from the
  mode, refuses everything else, passes the stream through and meters usage for a spend cap;
- the engine catalog (`./catalog`): plugin-api's vendored copy, which CI already holds in
  lockstep with the wire version. A consumer does not install `@paged-media/introspect-wasm`
  (11.5 MB of wasm) to read 140 KB of JSON;
- `paged.ai.complete`, a typed object-model command a host registers so scripts can ask
  Claude for text through the protocol-71 host bridge, with a per-minute call limit.

The package knows no engine. A host supplies a `ScriptEngine` (run a script, optionally render a
page): the editor's over `CanvasClient`, the CLI's over the headless host.

**The CLI gains `paged ai <doc> <brief>`** and `paged ai --new <size> <brief> -o out.paged`. The
latter needs a blank document, so `HeadlessHost` gains `newBlank(widthPt, heightPt)` over the
engine's existing `newBlankDocument` message. The CLI bundles `@paged-media/ai` like it bundles
the SDK. Every CLI session registers `paged.ai.complete`, answered with the caller's
credential; the client is built on the first call, so a run that never asks needs no key.

**No engine change.** Scripts reach Claude through `paged.invoke`, which protocol 71 already
routes to the host's registry; the `paged.ai.complete` command needs no new host function and
no protocol bump.

## Consequences

- `@paged-media/ai` publishes on the canary pipeline before `@paged-media/cli`, which bundles
  it.
- `@paged-media/plugin-sdk` moves to `0.2.49-canary.0` for `newBlank`.
- The authoring guide is part of the cache prefix: edit it deliberately, because every edit
  rewrites the cache for every user.
- Tests replace the model with canned turns and run everything else for real, the engine
  included. A live run needs a credential and is a manual smoke test.

## Amendment — 2026-10-16: the command is `paged-node ai`

The Node CLI's bin is renamed from `paged` to `paged-node`, because core's Rust CLI also installs
a `paged` ([ADR 324](324-node-cli-over-the-headless-host.md), amendment of the same date). The
verb is unchanged: `paged ai <doc> <brief>` above is now `paged-node ai <doc> <brief>`, and
`paged ai --new <size> <brief> -o out.paged` is `paged-node ai --new <size> <brief> -o
out.paged`. `paged.ai.complete` is a typed command inside a script, not a command line, and
keeps its name.
