# ADR 950 — paged.server is one Rust Worker, Durable Objects and R2

- **Status:** Accepted 2026-10-18.
- **Scope:** `server/` — the `paged-server` crate (workers-rs) and its `wrangler.jsonc`; the
  `paged-sync` client. Replaces the TypeScript server in this repository.

## Context

The editor is complete without a server (editor ADR 211, ADR 225): a document is a
repository in the browser (core ADR 180), and a file is a projection of it. A server adds
four things: sync, sharing and multi-user governance, a reachable MCP endpoint, and a relay
to an open editor tab. It must store as little as possible, hold no format logic of its
own, and be governable.

## Decision

1. **One Worker in Rust** (`worker` 0.8, wasm32; 0.3 MB of wasm gzipped). The repository
   format and its governance are core's `paged-repo` crate, the same code the browser and
   the CLI run. The server adds storage and transport, never format logic.
2. **One Durable Object per repository** (`RepoObject`, SQLite): refs, evidence, commits,
   trees, chunk lists, small blobs, change requests. It is the single writer of its refs,
   so a ref's compare-and-set is atomic without a lock. Each request builds a `Repo` over
   the object's store, and nothing else is kept between requests.
3. **R2 for blobs above 64 KiB**, written before their row, so a ref never reaches bytes that
   are not there. They are sealed under the repository's own key (AES-256-GCM, nonce from key
   and address), and every read is checked against its address. R2 is not trusted.
4. **The kernel is synchronous and R2 is not**: an operation that needs an R2 object fails
   with `Missing`, the object fetches it, and the operation runs again (`faulting`). Where
   a projection reads many, they are fetched in one pass first.
5. **Push is a negotiation**: `have` (the server answers what it lacks), `objects` (a pack,
   every record checked), `refs` (compare-and-set through the kernel). Pull is one pack
   (`fetch`), landed through the client's own kernel.
6. **Workspaces** (`WorkspaceObject`) hold the policy as governed data: a hash-chained log,
   compare-and-set on the version, owner only, validated before it can lock anyone out. A
   workspace repository that cannot read its policy refuses every write.
7. **Keeping**: collection of what no ref reaches (sparing the last hour's uploads, since a
   push uploads before it moves its ref), write-once backup snapshots of refs and evidence
   head, and erasure that destroys the key before the bytes (crypto-shredding).
8. **No KV, no D1, no queues.** Strongly consistent state lives in Durable Objects, and
   access tokens are signed so they need no store.

## Consequences

- Deleting a repository is one key and one prefix; dedup is per repository, so it leaks
  nothing across tenants.
- A repository is the unit of scale and of failure: one object, one writer, one backup line.
- The engine (about 27 MiB of wasm) is not in the Worker. Engine work happens in the
  person's tab (ADR 952) or, later, in a container (a proposal).
