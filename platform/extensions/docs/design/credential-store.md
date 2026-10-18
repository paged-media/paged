# RFC — D-11 credential store for DB/remote sources

Design note, written before the implementation. What was built is recorded in
[ADR 556](https://github.com/paged-media/plugin-data/blob/main/docs/adr/556-secrets-never-enter-the-plugin.md)
and in `DESIGN.md` §16.

Sections not relevant outside the original planning context have been removed; numbering is unchanged.

**2026-06-12 · RFC · status: DIRECTION FIXED.** Section 11 and decision D-8 of the
paged.data concept paper (`plugin-data: docs/concept.md`): secrets
for DB-attach (SQLite/Postgres/MySQL) and authenticated remote sources,
kept **out of the document payload** (hard gate, round-trip-tested) and out
of plugin-readable persistent storage. D-11 is the id this door carries in
`packages/plugin-api/src/host.ts` and `DESIGN.md` §16; D-03 is the network consent door
([network-consent.md](network-consent.md)).

## Decision

*Status note (2026-10-02): this section predates the implementation; see `DESIGN.md` §16.
Layer 1 ships as written, except that a bundle passes the value to `set` and the editor asks
the user to confirm it before storing. Of layer 2 the editor ships the WebCrypto-wrapped
IndexedDB tier and the session-only fallback (`editor: apps/canvas/src/plugin-secret-store.ts`);
the OS-keychain tier is not built. The host-side door that would resolve a `credentialRef` and
inject the material is not built, and no shipped bundle declares `capabilities.secrets`.*

**A host-owned, reference-only secret store behind a new SDK door; plugins
hold `credentialRef` strings, never secret material.** Three layers:

1. **Contract (`plugin-api`):** `host.secrets`, gated on
   `capabilities.secrets: { sources: true }`:
   ```ts
   set(ref: string, secret: SecretMaterial): Promise<void>;   // via host UI only
   exists(ref: string): Promise<boolean>;
   forget(ref: string): Promise<void>;
   // NO get(): secret bytes never enter the plugin realm. The plugin passes
   // the ref to the host fetch/attach door; the HOST injects the material
   // (Authorization header / connection string) on its side of the wire.
   ```
   The injection point pairs with the D-03 consent door: a consented origin
   plus a `credentialRef` resolve host-side; DuckDB `httpfs`/attach sees
   the resolved connection only inside the host-mediated transport.
2. **Editor backing:** OS keychain where available (macOS Keychain / DPAPI /
   libsecret via the future shell; WebCrypto-wrapped IndexedDB with a
   user-passphrase wrap in the pure-web editor — explicitly marked the
   weaker tier in the consent UI). Namespaced `paged:<plugin-id>:<ref>`.
3. **Fallback:** no backing injected → session-only in-memory store; refs
   die with the tab; documents stay inert until re-entered (the honest
   degradation the concept paper names).

## What stays true (hard gates, already tested)

*Status note (2026-10-02): the first two gates are tested in
`plugin-data: data-conformance/tests/security.rs`; the batch binary (`plugin-data: data-cli`)
does not resolve credential references.*

- `credentials-absent` round-trip: save → inspect → assert no secret bytes
  in IDML/metadata. The ref strings ARE allowed in the source manifest
  (see the payload test
  `plugin-data: packages/data-host-model/src/__tests__/payload-budget.test.ts` — refs
  only, e.g. `keychain:source-4`).
- No silent network: a ref without a live consent grant resolves nothing.
- Batch/headless (`paged-data-batch`, napi later): secrets come from the
  process environment / OS keychain via the same ref indirection — the
  document format does not change between interactive and headless.

## Rejected

- Plugin-readable `get()` (any in-realm secret defeats the trust line and
  the capability story).
- Secrets in `host.storage`/`host.blob` (plugin-readable, quota-evictable,
  sync-exposed).
- Per-document encrypted secret blobs (key-distribution problem disguised
  as a feature; breaks the "document is shareable" invariant).
