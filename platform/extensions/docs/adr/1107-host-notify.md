# ADR 1107 — `host.notify`, and the loss on a diagnostic

- **Status:** Accepted 2026-11-13.
- **Scope:** `Notification`, `NotifyOutcome`, `NotifySurface` and `BundleHost.notify` in
  `packages/plugin-api/src/host.ts`; `Diagnostic.loss`; the SDK's `NotifySink`
  (`CreateBundleHostOptions.notifySink`), `host.notify` and the flag `notify@1` in
  `packages/plugin-sdk/src/host-impl.ts`; `lossDiagnostics` sets `loss`
  (`packages/plugin-sdk/src/loss.ts`). The editor half is the operation feedback service (editor
  ADR 1219) and the compatibility report (editor ADR 1222). plugin-sdk and plugin-api
  `0.74.3-canary.101`.

## Context

A bundle could say two things to its user: a diagnostic (`host.diagnostics`, a document's lasting
state, listed in Problems) and a log line (`host.log`, the console). How one of its operations
ended — "the deck could not be opened, nothing changed" — was neither, so it went to the log, and
the user saw nothing (paged.publish's IDML importer failed silently; UX audit F-02). The editor now
has one service for an operation's end (editor ADR 1219). And a bundle's losses reached the host
as diagnostics rows worded by `lossDiagnostics`, without the entry they came from, so the host
could not explain a code or point at the items it stood on.

## Decision

1. **`host.notify(notification)`** says how an operation ended: `{ action, outcome, reason?,
   documentChanged?, remedy?: { label, command, args? }, title?, detail?, key?, prominent?,
   persistent? }`. `outcome` is the interaction specification's taxonomy (`success`, `canceled`,
   `blocked`, `unsupported`, `invalid-input`, `conflict`, `recoverable-failure`,
   `fatal-failure`). The host words it (action, reason, whether the document changed, the remedy),
   routes it (a toast; Problems when `persistent` or fatal), coalesces repeats with one `key` and
   keeps `detail` behind "Details". A remedy is a command the bundle registered. Always callable:
   a host without the service (`supports("notify@1")` false) writes it to the console.
2. **The host stamps the bundle's id** as the notification's source and namespaces its key, so
   two bundles' keys never collide.
3. **`Diagnostic.loss`** (optional) carries the `LossEntry` a row words. The SDK's
   `lossDiagnostics` sets it, so every module that already reports losses through it (paged.slide,
   paged.doc, paged.publish) is read by the host's compatibility report with its code, pages and
   items; paged.pdf's vectors set it on their own rows.

## Consequences

- Additive: a bundle that does not call `notify` or read `loss` is unchanged; an older host's
  `Diagnostic` simply has no `loss`.
- The headless harness and the editor's bundle hosts pass a sink; `createBundleHost` without one
  keeps the console line.
- Tests: `packages/plugin-sdk/test/loss.spec.ts` (`loss` rides each row); the editor's
  `packages/shell/test/state/operation-feedback.test.ts` (a notification as a report) and its
  e2e `UXI-T66`.
