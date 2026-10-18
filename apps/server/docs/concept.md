# paged.server — concept (draft, 2026-10-17)

Replaces the TypeScript `editor-server` in this same repository (`paged-media/editor-server`),
rewritten in Rust on Cloudflare (`server/`). AGPL-3.0 OR PMEL. Decision records: `docs/adr/`
(950–999).

## 1. What it is, and what it is not

paged.server is an **optional remote** for paged repositories (core ADR 180), plus an **MCP
endpoint** and a **relay** between Claude and an open editor tab.

- The browser is the complete system. With no server, a document is a repository in OPFS
  with history, branches, releases and evidence; files are projections of it.
- The server adds four things only: **sync** (push/pull of repositories), **sharing and
  multi-user governance** (workspaces, roles, change requests), **a reachable MCP endpoint**
  (a Claude connector over OAuth), and **the live relay** (Claude → open editor tab).
- It holds no format knowledge of its own: the repository format is the `paged-repo` crate
  in core, the same code the browser and the CLI run.
- It never runs the engine in v1 (the engine wasm is about 27 MiB). Engine work happens in
  the user's tab (live lane) or, later, in a container (headless lane).

## 2. Lineage

| From | Kept | Dropped |
|---|---|---|
| editor-server | problem+json errors, cursor paging, schema-first contracts, "bucket holds bytes, DB holds truth", GDPR export/erasure, M7's "offline-first stays ground truth" | Fastify/Node, Drizzle, better-auth, Stripe, font proxy, image search, `/generate`, opaque-file `files` table, delete-on-replace "versioning" |
| governed-repository design | content addressing with domain-separated BLAKE3; blobs + commits + refs + evidence as the only authority; draft = branch; published = release; size-threshold blob split with verify-on-read; one writer per repository; agent provenance; agents contribute through branch → change request; policy as governed data that fails closed; writes are audited by commits, reads/refusals by evidence; derivatives addressed by recipe; repository = unit of operation | Raft, Cedar (v1), the full canonical binary format, Pimcore element model, workflow/calendar suite |

## 3. Topology (Cloudflare, all Rust on workers-rs)

One Worker (`paged-server`, crate `paged-server`, `worker` crate, wasm32), four Durable
Object classes on SQLite storage, one R2 bucket. No KV.

| Piece | Holds | Why this shape |
|---|---|---|
| **Worker** | routing, auth, `/v1` sync + projections, `/mcp`, `/oauth`, `/.well-known/*`, WebSocket upgrade, MCP App HTML | stateless; fans out to DOs by id |
| **DO `Repo`** (one per repository) | `objects(hash, kind, size, loc, data)` (≤ 64 KiB inline), `refs(name, hash, updated_by, ts)`, `change_requests`, `evidence(seq, hash, entry)`; GC on alarm | one writer per repository → ref compare-and-set is atomic for free; SQLite point-in-time recovery |
| **DO `Workspace`** (one per org) | members + roles, policy (versioned, itself governed), repo directory, agent definitions (accountable human, autonomy), service tokens, OAuth grants | the policy decision point for every Repo |
| **DO `Session`** (one per live editor tab) | hibernating WebSocket to the tab, pending relayed calls, presence | the browser ↔ Claude proxy |
| **R2 `paged-objects`** | objects > 64 KiB at `r/<repo>/<hash>` | free egress; per-repo prefix = delete-a-repo is one prefix delete |
| **DO `AuthObject`** (one) | OAuth clients, pending logins, one-time codes, rotating refresh tokens | strongly consistent: a code is spent exactly once (KV could not promise that); access tokens are HMAC-signed and need no lookup |

Not used in v1: D1, Queues, Containers, Hyperdrive, Workflows. Each is a later lane (§9).

**Write path.** Push = `POST /v1/r/{repo}/have` (addresses offered → missing) →
`PUT /v1/r/{repo}/objects` (missing objects; large ones go straight to R2 from the Worker,
verified by address before the DO records them) → `POST /v1/r/{repo}/refs/{ref}` (expected,
new). The Repo DO checks: every object reachable from `new` is present, the commit graph is
well-formed, the kernel's governance checks pass under the Workspace policy, then CAS.
An unchanged save costs one commit object and a ref move.

**Read path.** `GET /v1/r/{repo}/objects/{hash}` (immutable, cacheable forever),
`GET /v1/r/{repo}/refs`, `GET /v1/r/{repo}/log/{ref}`, and the projection
`GET /v1/r/{repo}/file/{ref}.paged` (built in the Worker by `paged-repo`; reads are logged as
evidence).

**Platform limits to re-check at build time** (from memory, not verified): DO SQLite size per
object, max value size per row, Worker script size after compression, CPU time per request,
WebSocket hibernation semantics in workers-rs.

## 4. Identity and auth

- **The Worker is an OAuth 2.1 authorization server** for MCP clients (Claude): RFC 8414
  metadata, RFC 9728 protected-resource metadata, PKCE, dynamic client registration — the
  MCP authorization profile. Implemented in Rust (the JS `workers-oauth-provider` cannot be
  used from a Rust Worker). **Built (M1):** `server/crates/paged-server/src/oauth.rs`.
- **Login is delegated to an upstream OIDC provider** (generic: GitHub/Google for
  development, Entra/Okta/Keycloak for an enterprise). The server keeps no passwords.
- **The editor** uses a first-party HttpOnly cookie session on the same identity.
- **Service tokens** are scoped (repo, ref pattern, actions), hashed at rest, revocable.
- Actor ids are `user:<oidc-sub>@<issuer-hash>`, `svc:<id>`, `agent:<definition>`.

## 5. Governance

Same kernel checks as in the browser (`paged-repo` `policy`), plus the multi-user parts:

- **Roles:** owner, editor, reviewer, viewer. Agents get their own grants via an agent
  definition with an accountable human.
- **Autonomy** per repository: `read`, **`propose` (default)**, `commit`.
  `propose` = agents write only `agent/<run>/…`; a human merges.
- **Change requests:** source ref, target ref, part-level diff, approvals (never by the
  author), merge = fast-forward or a part-level three-way merge; the same part changed on
  both sides is a conflict that a human resolves.
- **Evidence:** writes are commits. Reads of projections, exports, refusals, every MCP call
  and every relayed call append to the Repo's hash-chained evidence log. A periodic
  write-once snapshot of refs + evidence head goes to R2.
- **Erasure:** delete-a-repository = R2 prefix delete + DO deletion. A per-repository
  encryption key (crypto-shredding) is a later option; dedup is per repository already, so
  it stays possible.

## 6. MCP

One tool registry, two execution lanes.

**Store tools** (run in the Worker, no engine): `list_documents`, `describe_document`
(tree, sizes, refs), `read_part`, `log`, `diff` (part-level), `create_branch`,
`commit_parts` (agent writes, always with provenance), `open_change_request`,
`list_change_requests`, `get_file_url` (signed short-lived projection URL), `lookup_api`
(the engine catalog the `@paged-media/ai` package already ships).

**Engine tools** (`run_script`, `render_page`, `export`) need the engine:

- **Live lane (v1):** the call goes to the user's `Session` DO, over its WebSocket to the
  open tab, through the same `executeScript` path the Ask bar uses. The tab shows each call,
  asks for approval when the autonomy says so, and can undo it. This is the browser ↔ Claude
  proxy. Saving afterwards commits with provenance for the agent's contribution.
- **Headless lane (later):** a Container running the native CLI.

**MCP App.** Engine and store tools declare `_meta.ui.resourceUri = "ui://paged/view"`. The
Worker serves that HTML with a strict CSP. MVP: page renders (PNG from the live lane), a
history and parts browser, approve or reject a change request through the host bridge.
Later: embed the read-only viewer SDK if its size and CSP fit Claude's sandbox (unverified).

**Pairing.** "Connect to Claude" in the editor opens a Session bound to the user. Claude
calls `list_live_sessions` (same identity via OAuth) and passes `session` to engine tools.

**Without a server** the `paged` CLI hosts the same registry over stdio (`paged mcp`) against
a local repository and the native engine, so Claude Desktop and Claude Code can use paged
with nothing deployed.

**Open spike:** whether `rmcp`'s server side compiles for `wasm32-unknown-unknown` inside a
Worker. Fallback: implement streamable-HTTP JSON-RPC by hand over `rmcp`'s model types (the
protocol surface needed is small: initialize, tools/list, tools/call, resources/read).

## 7. Data

Tabular data already lives in parts (paged.data `data/<hash>.<ext>`, paged.sheet
`workbook.xlsx`), so it is versioned and deduplicated with the document. A **dataset
repository** (`kind: data`: Parquet/CSV/JSON parts + `schema.json`) can be referenced from
documents as `paged://<workspace>/<repo>@<ref>/<path>` through the data-provider seam.
Remote-source credentials stay references (plugin-data ADR 556); the server can later resolve
them from secrets and proxy fetches, Postgres included through Hyperdrive.

## 8. Editor side (no default behaviour change)

- A `DocumentStore` port: the local repository (OPFS, default once P2 lands), today's file
  handle as an optional **linked file** projection, and a remote (lazy chunk, only when a
  workspace is connected).
- `navigator.storage.persist()`; a visible warning when it is refused; linked file or bundle
  export as the backup.
- A session bridge (WebSocket) that runs relayed calls through the existing AI tool engine.
- The `/api/ai` Pages proxy stays; it may later move behind the same Worker.

## 9. Phases

| Phase | Delivers | Gate |
|---|---|---|
| P0 | ADR 180, format spec, this concept | — |
| P1 | `paged-repo` crate (core) | round-trip, determinism, dedup, kernel, bundle tests; wasm32 check |
| P2 | editor local repository (save = commit, history, branches, releases, linked file) | browser-only journeys green |
| P3 | server M1: Worker + Repo DO + R2 + OIDC/OAuth + sync + projections; editor remote | miniflare tests; CAS race; tampered object rejected |
| P4 | Workspace DO, roles, policy, change requests, server evidence | refusal matrix |
| P5 | MCP store tools on `/mcp`; `paged mcp` stdio | MCP Inspector; Claude connector |
| P6 | live relay: Session DO, editor bridge, MCP App | relayed `run_script` visible + undoable |
| P7 | element-level model storage (core), headless lane, Hyperdrive, encryption, dataset repos | each its own decision |

Every externally visible step (repo creation, Cloudflare resources, deploys, npm publishes,
archiving editor-server) waits for an explicit OK.
