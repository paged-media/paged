// Asset columns (data ADR 563; PM-0015): a column whose values name assets
// by URL or path. An image binding over one places the asset after three
// steps:
//
//   1. fetch — a remote URL only for an origin the user consented to (the
//      same gate as remote sources, editor ADR 218); a relative path
//      against the column's base;
//   2. keep — the bytes by content hash in `host.blob` (local, per plugin),
//      so a refresh refetches only references it has not seen;
//   3. act — the column's action chain (`host.actions`, extensions ADR 344:
//      a fit, a colour conversion, a background removal), its result cached
//      under the chain's key.
//
// The result is placed as a `data:` URI (core ADR 208), so the document
// carries the processed picture itself. A reference that cannot be had is
// reported with its reason and placed as nothing, never skipped silently.

import type { ActionStep, BundleHost } from "@paged-media/plugin-api";

/** What a column does with its assets. */
export interface AssetColumnDef {
  /** The actions each asset goes through before it is placed. */
  chain?: ActionStep[];
  /** What a relative reference is resolved against. */
  base?: string;
}

/** An asset made ready, or why not. */
export type AssetOutcome =
  | { ok: true; uri: string; key: string; mediaType: string; cached: boolean }
  | { ok: false; reason: string };

const MEDIA_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  tif: "image/tiff",
  tiff: "image/tiff",
  pdf: "application/pdf",
};

/** A media type from the bytes' signature, else the name's extension. */
export function mediaTypeOf(bytes: Uint8Array, name: string): string {
  const b = bytes;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47)
    return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46)
    return "application/pdf";
  const ext = /\.([a-z0-9]+)(?:[?#].*)?$/i.exec(name)?.[1]?.toLowerCase();
  return (ext && MEDIA_TYPES[ext]) || "application/octet-stream";
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const d = await globalThis.crypto.subtle.digest(
    "SHA-256",
    bytes as BufferSource,
  );
  return Array.from(new Uint8Array(d), (x) =>
    x.toString(16).padStart(2, "0"),
  ).join("");
}

function dataUri(bytes: Uint8Array, mediaType: string): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${mediaType};base64,${btoa(s)}`;
}

/** What the pipeline needs of the session. */
export interface AssetDeps {
  /** The origins the user consented to (and the build allows). */
  consentedOrigins(): readonly string[];
  /** Fetch bytes (the editor's `fetch`; a test injects one). */
  fetch?: (url: string) => Promise<Uint8Array>;
}

export interface AssetPipeline {
  resolve(reference: string, def: AssetColumnDef): Promise<AssetOutcome>;
  /** References fetched from the network this session (a test reads it). */
  readonly fetched: readonly string[];
}

const BLOB_PREFIX = "assets/";

export function createAssetPipeline(
  host: BundleHost,
  deps: AssetDeps,
): AssetPipeline {
  // reference → content hash, and hash → bytes (this session's cache; the
  // blob store keeps them across sessions).
  const byReference = new Map<string, string>();
  const bytesOf = new Map<string, { bytes: Uint8Array; mediaType: string }>();
  const fetched: string[] = [];
  const blob = () => (host.supports("storage.blob@1") ? host.blob : null);

  async function keep(bytes: Uint8Array, mediaType: string): Promise<string> {
    const hash = await sha256(bytes);
    if (!bytesOf.has(hash)) {
      bytesOf.set(hash, { bytes, mediaType });
      try {
        await blob()?.write(`${BLOB_PREFIX}${hash}`, bytes);
      } catch (err) {
        host.log.debug(`asset ${hash}: not kept in the blob store`, err);
      }
    }
    return hash;
  }

  async function load(
    reference: string,
    def: AssetColumnDef,
  ): Promise<
    | { bytes: Uint8Array; mediaType: string; hash: string; fresh: boolean }
    | string
  > {
    const known = byReference.get(reference);
    if (known) {
      const b = bytesOf.get(known);
      if (b) return { ...b, hash: known, fresh: false };
      try {
        const stored = await blob()?.read(`${BLOB_PREFIX}${known}`);
        if (stored)
          return {
            bytes: stored,
            mediaType: mediaTypeOf(stored, reference),
            hash: known,
            fresh: false,
          };
      } catch {
        // Fall through to a fetch.
      }
    }
    let url: URL;
    try {
      url = new URL(reference, def.base);
    } catch {
      return `"${reference}" is not a URL, and the column has no base to resolve it against`;
    }
    if (url.protocol === "data:") {
      const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(reference);
      if (!m) return `"${reference.slice(0, 40)}…" is not a data URI`;
      const raw = m[2]
        ? Uint8Array.from(atob(m[3]!), (c) => c.charCodeAt(0))
        : new TextEncoder().encode(decodeURIComponent(m[3]!));
      const mediaType = m[1] || mediaTypeOf(raw, "");
      const hash = await keep(raw, mediaType);
      byReference.set(reference, hash);
      return { bytes: raw, mediaType, hash, fresh: false };
    }
    if (url.protocol !== "https:" && url.protocol !== "http:")
      return `"${url.href}" is not fetched: only http(s) assets are`;
    if (!deps.consentedOrigins().includes(url.origin))
      return `"${url.origin}" has no consent: allow it in the data sources' origins first`;
    const get =
      deps.fetch ??
      (async (u: string) => {
        const r = await globalThis.fetch(u);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return new Uint8Array(await r.arrayBuffer());
      });
    let bytes: Uint8Array;
    try {
      bytes = await get(url.href);
    } catch (err) {
      return `"${url.href}" could not be fetched (${err instanceof Error ? err.message : String(err)})`;
    }
    fetched.push(url.href);
    const mediaType = mediaTypeOf(bytes, url.pathname);
    const hash = await keep(bytes, mediaType);
    byReference.set(reference, hash);
    return { bytes, mediaType, hash, fresh: true };
  }

  return {
    fetched,
    async resolve(reference, def) {
      const got = await load(reference, def);
      if (typeof got === "string") return { ok: false, reason: got };
      let { bytes, mediaType } = got;
      let key = got.hash;
      let cached = !got.fresh;
      if (def.chain && def.chain.length > 0) {
        if (!host.supports("actions@1"))
          return {
            ok: false,
            reason:
              "the column has an action chain, but no action registry is wired (supports('actions@1') is false)",
          };
        try {
          const r = await host.actions.runChain(def.chain, {
            bytes,
            mediaType,
          });
          const out = r.output as { bytes?: unknown; mediaType?: unknown };
          if (
            !(out?.bytes instanceof Uint8Array) ||
            typeof out.mediaType !== "string"
          )
            return {
              ok: false,
              reason: "the action chain did not give an asset",
            };
          bytes = out.bytes;
          mediaType = out.mediaType;
          key = r.key;
          cached = r.cached;
        } catch (err) {
          return {
            ok: false,
            reason: `the action chain failed: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }
      return {
        ok: true,
        uri: dataUri(bytes, mediaType),
        key,
        mediaType,
        cached,
      };
    },
  };
}
