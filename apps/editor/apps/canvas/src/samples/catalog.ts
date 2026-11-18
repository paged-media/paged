/*
 * This file is part of paged (https://paged.media), the commercial editor
 * for the paged IDML engine.
 *
 * paged is free software: you may redistribute it and/or modify it under the
 * terms of the GNU Affero General Public License, version 3, as published by
 * the Free Software Foundation, OR under the Paged Media Enterprise License
 * (PMEL), a commercial license available from And The Next GmbH. Full
 * copyright and license information is available in LICENSE.md, distributed
 * with this source code.
 *
 * paged is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the licenses for details.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    AGPL-3.0-only OR Paged Media Enterprise License (PMEL)
 */

// Sample documents (editor ADR 1243): finished publications a visitor can
// open from the empty canvas or a `?sample=<id>` link. The catalog and the
// documents live on the module host, never in this repository: a catalog
// names each document and the font files it is set in (a `.paged` names
// its faces, it does not carry them), and opening a sample registers those
// faces and then opens the document through the editor's one open path.

import type { PagedEditor } from "@paged-media/shell";
import { openDocumentFile } from "@paged-media/shell";

/** One font file a sample is set in. */
export interface SampleFont {
  family: string;
  /** `null` or absent: the upright face (a variable face answers every
   *  weight); `"Italic"` for the italic file; a static weight by name. */
  style?: string | null;
  /** Relative to the catalog. */
  url: string;
}

/** One sample document. */
export interface Sample {
  id: string;
  title: string;
  summary?: string;
  pages?: number;
  /** Bytes of the document, for the progress line. */
  bytes?: number;
  /** A cover picture, relative to the catalog. */
  thumbnail?: string;
  /** The `.paged`, relative to the catalog. */
  document: string;
  fonts: SampleFont[];
  /** Whose publication it is, shown beside it. */
  credit?: string;
}

export interface SampleCatalog {
  v: 1;
  samples: Sample[];
}

/** Where the catalog is: the build's `VITE_SAMPLES_URL`, else the module
 *  host's. */
export function catalogUrl(): string {
  return (
    (import.meta.env.VITE_SAMPLES_URL as string | undefined) ||
    "https://modules.paged.media/samples/catalog.json"
  );
}

/** Whether this build offers samples: the demo build (play.paged.media),
 *  or any build told where a catalog is. Others reach no host for them:
 *  the editor's network wall (ADR 220) admits no request it was not asked
 *  for. */
export function samplesEnabled(): boolean {
  return (
    import.meta.env.MODE === "demo" || Boolean(import.meta.env.VITE_SAMPLES_URL)
  );
}

/** A catalog's entries, keeping only well-formed ones. */
export function parseCatalog(json: unknown): Sample[] {
  if (!json || typeof json !== "object") return [];
  const c = json as Partial<SampleCatalog>;
  if (c.v !== 1 || !Array.isArray(c.samples)) return [];
  return c.samples.filter(
    (s): s is Sample =>
      !!s &&
      typeof s.id === "string" &&
      typeof s.title === "string" &&
      typeof s.document === "string" &&
      Array.isArray(s.fonts) &&
      s.fonts.every(
        (f) => f && typeof f.family === "string" && typeof f.url === "string",
      ),
  );
}

/** The catalog. An unreachable or malformed catalog is no samples, not an
 *  error. The browser's cache answers a second read (the empty canvas and a
 *  `?sample=` link may both ask). */
export function loadCatalog(
  fetcher: typeof fetch = fetch,
  url = catalogUrl(),
): Promise<Sample[]> {
  return fetcher(url)
    .then((r) => (r.ok ? r.json() : null))
    .then(parseCatalog)
    .catch(() => []);
}

/** `rel` against the catalog's URL (itself read against the page, so a
 *  build may name a catalog by its path). */
export function resolve(rel: string, base = catalogUrl()): string {
  const page = globalThis.location?.href ?? "https://modules.paged.media/";
  return new URL(rel, new URL(base, page)).toString();
}

/** Open `sample`: register its faces, then open its document through the
 *  one IDML / `.paged` load path. */
export async function openSample(
  editor: PagedEditor,
  sample: Sample,
  sinks: {
    setStatus: (s: string) => void;
    pushWarning: (w: string) => void;
  },
  deps: { fetcher?: typeof fetch; open?: typeof openDocumentFile } = {},
): Promise<void> {
  const fetcher = deps.fetcher ?? fetch;
  const open = deps.open ?? openDocumentFile;
  sinks.setStatus(`fetching ${sample.title}…`);
  const fonts = await Promise.all(
    sample.fonts.map(async (f) => {
      const r = await fetcher(resolve(f.url));
      if (!r.ok) throw new Error(`font ${f.family} (${r.status})`);
      return { f, bytes: new Uint8Array(await r.arrayBuffer()) };
    }),
  );
  for (const { f, bytes } of fonts) {
    await editor.client.registerFont(f.family, bytes, f.style ?? null);
  }
  const doc = await fetcher(resolve(sample.document));
  if (!doc.ok) throw new Error(`document (${doc.status})`);
  const bytes = await doc.arrayBuffer();
  const name = `${sample.title}.paged`;
  await open(editor, new File([bytes], name), sinks);
}
