# paged.server (Rust)

The optional remote for paged repositories (core ADR 180): a Cloudflare Worker,
one Durable Object per repository (SQLite: refs, evidence, commits, trees, small
blobs), and R2 for large blobs. The repository format and its governance are
core's `paged-repo` crate — the same code the editor runs in the browser.
The browser is complete without this server; this adds sync, sharing and (next)
an MCP endpoint. Concept: `../docs/concept.md`.

| Crate | What |
|---|---|
| `crates/paged-server` | the Worker + `RepoObject` Durable Object (wasm32, `worker` 0.8) |
| `crates/paged-sync` | a client: push (send only what the server lacks), pull, projections |

## HTTP (M1)

| Route | |
|---|---|
| `POST /v1/r/{repo}/have` | JSON `[address]` → the ones the server lacks |
| `PUT /v1/r/{repo}/objects` | a pack; every record checked against its address; large blobs to R2 before their row |
| `GET /v1/r/{repo}/refs` | `{name: address}` |
| `POST /v1/r/{repo}/refs/{name}` | `{expected, new}`: compare-and-set through the kernel's governance |
| `GET /v1/r/{repo}/log/{ref}` | first-parent history |
| `GET /v1/r/{repo}/objects/{address}` | one object, immutable |
| `GET /v1/r/{repo}/file/{ref}` | the `.paged` projection; `?history=1` carries the history |
| `GET /v1/r/{repo}/evidence` | the evidence log |

Errors are RFC 9457 problem+json. Auth in M1 is service tokens only: the
`PAGED_TOKENS` secret maps SHA-256(token) → actor id; without it every request
is refused. The first writer of a repository owns it.

## Local

```bash
cd crates/paged-server
printf 'PAGED_TOKENS={"%s":"user:dev"}\n' "$(printf %s dev-token | shasum -a 256 | cut -d' ' -f1)" > .dev.vars
npx wrangler dev --port 8791            # builds with worker-build; local workerd, R2 and DOs
cd ../.. && PAGED_SERVER_URL=http://127.0.0.1:8791 cargo test -p paged-sync
```

The tests also want `other-token` → `user:other` in `PAGED_TOKENS`.

Nothing here deploys. Creating the bucket and deploying are separate,
deliberate acts.

## Not yet

OIDC sign-in and the OAuth server for MCP clients; the Workspace DO (members,
roles, policy as governed data); change requests over HTTP; the MCP endpoint;
the Session DO relay to an open editor tab. `paged-repo` is a path dependency
into a sibling core checkout until core's `feat/paged-repo` is on origin.
