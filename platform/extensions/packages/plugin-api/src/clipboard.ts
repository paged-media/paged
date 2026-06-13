// The capability-gated CLIPBOARD door (K-6 / S-14). A read/write surface
// over the SYSTEM clipboard with a rich `{ text?, tabular? }` payload —
// the home the sheets-mode grid's range copy/paste had nowhere to land
// (RFI §6 K-6). The editor injects a backend over `navigator.clipboard`;
// when none is wired, `read` answers `null` and `write` is a no-op (the
// honest no-clipboard door, like the rest of plugin-api).
//
// Type-only, like the rest of plugin-api: the actual clipboard backend is
// a value the host injects at `loadBundle` time (the same shape as
// `assetSource` / `blobStore` / `consent`) and reaches the bundle through
// `host.clipboard`. A bundle imports only the shapes from here.
//
// Capability mapping (`capabilities.clipboard`, the existing manifest
// enum). The honest reading — wide enough for the consumers that asked,
// no wider:
//   · `"full"`  — BOTH `text` and `tabular`. The rich grid interchange
//     (cells as a rectangular display-string grid). What paged.sheet
//     declares.
//   · `"vector"` — `text` ONLY. A vector plugin copies a textual/SVG
//     representation, not a cell grid; a `tabular` payload it tries to
//     WRITE is dropped (the host strips it, logs once), and a `tabular`
//     payload it READS is never surfaced (read returns the `text` half).
//   · `"none"` / absent — the door is DENIED: `read` answers `null`,
//     `write` refuses (a capability error in `'enforce'`, a warn+no-op in
//     `'warn'`). This is the manifest default, so a bundle that never
//     declares clipboard cannot touch the system clipboard by accident.

/**
 * The canonical tabular interchange — a RECTANGULAR grid of cell DISPLAY
 * strings (already number-formatted; the consumer owns re-parsing on
 * paste). `rows[r][c]` is the display text of the cell at grid row `r`,
 * column `c`. Ragged input is the producer's responsibility to
 * rectangularize; the host does not pad. Serializable (plain strings), so
 * the door proxies across the future isolate boundary unchanged.
 */
export interface TabularClipboard {
  /** Row-major grid of cell display strings. `rows.length` = row count;
   *  each inner array is one row's cells, left to right. */
  rows: string[][];
}

/**
 * A clipboard payload — a plain-text half and/or a tabular half. Both are
 * optional: a text-only copy carries `text`; a grid copy carries BOTH
 * (the `tabular` grid AND a TSV `text` fallback so a paste into a plain
 * editor still lands something). On READ the host fills whichever halves
 * it could recover from the system clipboard (`tabular` is reconstructed
 * from TSV `text` when the platform offers no richer form).
 */
export interface ClipboardPayload {
  /** Plain-text representation. For a grid copy this is the TSV fallback
   *  (rows joined by `\t` within a row and `\n` between rows). */
  text?: string;
  /** The rich rectangular cell grid (the canonical interchange). Present
   *  on a grid copy; absent for a plain-text copy. Gated on
   *  `capabilities.clipboard: "full"` — a `"vector"` declaration sees the
   *  `text` half only. */
  tabular?: TabularClipboard;
}

/**
 * The clipboard accessor a bundle reaches through `host.clipboard`. Two
 * doors over the SYSTEM clipboard: `read` recovers a payload (or `null`
 * when there is nothing readable / no backend wired), `write` puts a
 * payload on the clipboard. Capability-gated on `capabilities.clipboard`
 * (see the mapping above): `"full"` grants text + tabular, `"vector"`
 * grants text only, `"none"`/absent denies. Probe
 * `supports("clipboard@1")` to know whether a real system-clipboard
 * backend is wired (false ⇒ `read` answers `null` and `write` no-ops).
 */
export interface ClipboardSurface {
  /**
   * Read the current clipboard payload, or `null` when there is nothing
   * readable, the read is denied by the platform, or no backend is wired
   * (the honest no-clipboard door). A `"vector"` declaration never
   * receives the `tabular` half (only `text`).
   */
  read(): Promise<ClipboardPayload | null>;
  /**
   * Write a payload to the system clipboard. A `"vector"` declaration may
   * only write `text` — a `tabular` half it supplies is DROPPED (the host
   * logs once). With no backend wired this is a no-op (probe
   * `supports("clipboard@1")` first). Never throws on a platform refusal:
   * a denied write resolves without effect (the honest browser posture —
   * the clipboard API rejects without a user gesture).
   */
  write(payload: ClipboardPayload): Promise<void>;
}
