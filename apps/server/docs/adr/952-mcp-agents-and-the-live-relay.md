# ADR 952 — MCP: one catalog, agents acting for a person, the live relay

- **Status:** Accepted 2026-10-18.
- **Scope:** `server/crates/paged-server/src/{mcp,session,session_object,view}.rs`; core's
  `paged-mcp` crate and `paged mcp`; the editor's live bridge (editor ADR 225 §9).

## Context

A model should be able to read paged documents, change them, and see the result. What it
writes must be attributable to it and must not reach what people rely on without a person
deciding.

## Decision

1. **One tool catalog** (core `paged-mcp`), two hosts.
   - paged.server's `/mcp`: Streamable HTTP, one JSON answer per POST, no stream.
   - `paged mcp`: stdio, the engine running natively, no server.
   - Both advertise the same tools and schemas. The official Rust SDK was spiked: it needs a
     runtime a Worker lacks, so the needed subset (initialize, ping, tools, resources) is
     written in core.
2. **Every call is an agent's.**
   - The actor is `agent:<client>`, acting for the signed-in person, in a run named by the
     MCP session.
   - Repositories check that person's role. The kernel confines the agent to
     `agent/<run>/…` refs at the default autonomy and records provenance on its versions.
   - A model reaches `main` through `propose_change` and a person's approval. The kernel
     refuses an agent's approval.
3. **Engine tools act in the person's open editor tab.**
   - The tab connects to a `SessionObject` with a one-minute ticket, over a hibernating
     WebSocket, and is listed in its owner's home directory.
   - A call waits up to two minutes for the tab's answer: the tab shows every call and, by
     default, asks before a change.
   - Only the owner's model may call a tab.
4. **The MCP Apps view** (`ui://paged/view`) draws describe, history, change-request and
   render results inside the model client. It never approves or merges: a call from the view
   is the model's.

## Consequences

- Nothing a model does is anonymous. Its versions name it, the person it acted for, and its
  run; its calls through the server are evidence.
- With no tab open and no `paged mcp`, a model can still read and write parts, but cannot
  run the engine (a headless lane is a proposal).
