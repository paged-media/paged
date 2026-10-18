# RFC: network capability + per-origin consent + data-source manifest (D-03)

Design note, written before the implementation. What was built is recorded in
[ADR 556](https://github.com/paged-media/plugin-data/blob/main/docs/adr/556-secrets-never-enter-the-plugin.md)
and in `DESIGN.md` §4.6b.

**Origin:** the paged.data concept paper (`plugin-data: docs/concept.md`) §11 (the threat
model — the largest attack surface in the suite), §6.2 (remote / DB / governed
sources), §7 (governed data). Section references below (§6.1, §11, §13) are to that paper.
D-03 is the id this door carries in `packages/plugin-api/src/host.ts` and `DESIGN.md` §4.6b;
D-11 is the credential store ([credential-store.md](credential-store.md)).
**Consumes:** `plugin-data: data-sources` (the `authorize()` gate + the credential-redacting
data-source manifest are already built + tested — the §11 skeleton).

## Problem

`paged.data` is the only plugin in the suite that needs **network and
filesystem reach**, and concept §11 is emphatic about the rules: external data
+ scriptable queries make it categorically higher-risk than its siblings, so

- network access is **capability-gated and user-consented**, per-origin and
  rememberable;
- a **visible data-source manifest** shows every origin/file a document will
  touch — **no silent fetch, ever**;
- documents carrying queries are **treated as carrying code**: opening one does
  NOT auto-execute remote fetches; external sources are **inert until the user
  reviews the manifest and consents**. A shared/untrusted document cannot
  silently exfiltrate via DuckDB `httpfs` or call an attacker origin on open.

The platform today offers only a **declarative boolean**:
`capabilities.network?: boolean` (`packages/plugin-api/src/manifest.schema.json`,
`packages/plugin-api/src/manifest.ts`)
with **no host API** — no `host.network`, no consent door, no origin allow-list,
no data-source manifest contract. `capabilities` is a closed vocabulary
(`additionalProperties: false`). The asset door already sets the right default
posture: the host MUST NOT fetch to satisfy a read — "that would make a 'render
offline forever' document silently depend on a live URL" (`DESIGN.md` §13.3). The
network surface needs the same conviction, made consent-explicit.

## Proposal (three stages)

*Status note (2026-10-02): this section predates the implementation; see `DESIGN.md` §4.6b.
Stage 1 shipped with `"origins": "consent"` in place of `"*-consent"`, and the boolean form
is still accepted (`packages/plugin-api/src/manifest.ts`). Stage 2 shipped as written; a
remembered grant is stored in the bundle's own `host.storage` namespace
(`packages/plugin-sdk/src/host-impl.ts`), so it is kept per bundle, not per document.
Stage 3a is not built as written: the editor ships a fixed `connect-src 'self' blob: data:`
policy (`editor: apps/canvas/public/_headers`, `editor: apps/canvas/vite.config.ts`) that is
not derived from the granted origins, so a consented external origin stays unreachable in the
browser (`editor: apps/canvas/src/plugin-consent.ts`); and the remote-source lane of the
paged.data bundle does not go through DuckDB `httpfs` — it gates one `fetch` of its own on
`consentedOrigins()` and hands the bytes to DuckDB
(`plugin-data: packages/data-bundle/src/session.ts`).*

**Stage 1 — a structured network declaration (manifest schema).** Replace the
bare boolean with a per-origin declaration (keeping `network: false` as the
no-network default). Because capabilities are `additionalProperties:false`, this
is a schema change → an `apiVersion` minor bump:

```jsonc
"network": {
  "origins": ["https://warehouse.example.com", "https://api.example.com"],
  "purpose": "Bind print content to governed datasets the author selects."
}
```

`origins` is the allow-list of `scheme://host[:port]` the bundle may *ever*
reach; `purpose` is human-readable, shown in the consent UI. A bundle that
declares no fixed origins (dynamic author-supplied sources) declares
`"origins": "*-consent"` — meaning *every* reach requires runtime consent and
none is pre-allowed.

**Stage 2 — the consent door (host surface).** A new capability-gated
`host.network` surface:

```ts
interface NetworkSurface {
  // Renders the visible data-source manifest (origins + purpose) for review and
  // returns the user's per-origin decision. NOTHING fetches before this resolves.
  requestConsent(origins: string[], purpose: string): Promise<ConsentResult>;
  // The currently-granted origins (so the bundle gates its own DuckDB httpfs).
  consentedOrigins(): readonly string[];
}
// ConsentResult = { granted: string[]; denied: string[]; remembered: boolean }
```

Consent is **per (document, origin)**, rememberable, and **not auto-granted on
reopen** unless the user chose "remember" — opening a document is never a fetch.
This is the platform half of concept §11's "data-source manifest in the UI".

**Stage 3 — gated reach (recommended: 3a).**

- **3a — enforce the boundary, don't proxy the bytes (recommended).** The bundle
  performs its own fetch / DuckDB `httpfs`, but the platform enforces the
  allow-list at the realm boundary: a **CSP `connect-src` derived from the
  granted origins** plus the editor's existing COOP/COEP cross-origin isolation
  (already required for the wasm/worker lanes). The host does not see or proxy
  payloads; it constrains *where* the realm may connect. DuckDB-WASM `httpfs`
  works unchanged; a non-granted origin is blocked by CSP.
- **3b — host-proxied `host.network.fetch(req): Promise<Response>` (rejected for
  v1).** Fully mediates, but breaks DuckDB `httpfs` (which fetches itself), adds
  a large host surface, and forces every adapter through a single chokepoint.
  Kept only as the fallback if CSP-per-grant proves infeasible.

## Why not alternatives

- **Keep `network: boolean`.** A global on/off with no origin allow-list and no
  consent cannot satisfy §11: it permits silent exfiltration to *any* origin on
  open. Directly violates the threat model.
- **Allow-list only, no runtime consent.** Insufficient for author-supplied
  dynamic sources (the common case) and still fetches on open without review.
  Consent + manifest review is the §11 requirement, not just an allow-list.
- **Host-proxied fetch as the primary path (3b).** Breaks the vendored
  DuckDB-WASM `httpfs` connector — *connector breadth is the product*
  (concept §6.1) — and centralizes a large attack surface for no isolation
  gain over CSP-enforced grants.

## Security / data-protection notes

Documents carrying queries are treated as carrying code: **inert until
consented**. A shared/untrusted document with no granted origins **cannot
connect anywhere** (CSP `connect-src 'none'` for ungranted realms), so it cannot
exfiltrate via `httpfs` or beacon an attacker origin on open. DB-attach
**credentials** are out of scope here — handled by a separate secret store
(D-11, [credential-store.md](credential-store.md)), never serialized into the
document payload (already enforced + tested in
`plugin-data: data-sources` / `plugin-data: data-js`: the round-trip gate asserts
credentials absent).

**Data-protection posture:** client-side
fetch means data may leave the user's machine to third-party origins they
authorized; the consent UI must make destinations + purpose **legible** before
any reach.

## Posture without this RFC

*Status note (2026-10-02): this section predates the implementation; the paged.data manifest
now declares `network: { origins: "consent" }`
(`plugin-data: packages/data-bundle/manifest.json`).*

`paged.data` ships **today** with `network: false`: inline + file sources work;
all remote / `httpfs` / DB-attach / governed-extract sources are **unreachable by
construction**. Critically, the engine's `authorize()` capability gate and the
**credential-redacting data-source manifest** are already built and conformance-
tested (the §11 skeleton: `data.security.no-network-pre-consent`,
`data.security.capability-gate`, `data.security.credentials-absent`). So flipping
to the granted model when this RFC lands is a **wiring change** — declare the
`origins`, call `requestConsent`, read `consentedOrigins()` to gate DuckDB
`httpfs` — **not a redesign**. This RFC is the gate for the entire remote /
governed-data half of the plugin (concept §13, tiers T1/T2).
