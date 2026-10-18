# ADR 953 — The headless engine lane

- **Status:** Accepted 2026-10-18. The container image is not yet built or deployed.
- **Scope:** `server/crates/paged-server/src/engine_object.rs`, the `commit-file` repository
  route, the MCP host's engine branch; `server/engine/Dockerfile`; core's `paged engine-serve`.

## Context

Engine tools (open, run a script, render a page, save) first ran only in a person's open
editor tab (ADR 952). With no tab open, a model could read and write parts but could not
run the engine. The engine is about 27 MiB of wasm and does not fit in the Worker.

## Decision

1. **The engine runs as a stateless service**: `paged engine-serve` (core). Each `POST /run`
   brings the working document and takes back the script's output, a rendered page and the
   exported `.paged`. Any instance can answer any call, so it scales and restarts freely.
2. **One `EngineObject` per MCP run** holds that run's working document in R2, sealed under
   a per-run key, and only the run's person may drive it.
3. **The lanes are chosen in order**: a tab the model names, else the person's connected
   tab, else the headless engine when the deployment has one. Without one, engine tools say
   so.
4. **Saving is the agent's version**. `save_document` commits the working copy on
   `agent/<run>/headless` through the kernel, with provenance; `main` moves only by a
   person's merge.
5. **In production the service is a Cloudflare Container** attached to `EngineObject`
   (`state.container()`, `PAGED_ENGINE_CONTAINER=1`). Locally it is the same binary on a
   port (`PAGED_ENGINE_URL`).

## Consequences

- A model can do everything the tab offers with nobody watching. Its results still reach
  people only as proposals on its own branch.
- The container is the server's only component that is not Worker or storage. It holds no
  state, so losing it loses nothing.
