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

// What File ▸ Open's native picker offers (editor ADR 1205; UX audit
// F-10). It listed `.paged` and `.idml` only, so a Word, PowerPoint, Excel,
// PDF or Photoshop file hid behind "All files" although an importer opens
// it. The first entry, the one the picker shows, is everything the editor
// opens; one entry per importer follows for filtering.

/** One `showOpenFilePicker` type: a label and MIME type → extensions. */
export interface PickerType {
  description: string;
  accept: Record<string, string[]>;
}

/** What the picker needs of an importer. */
export interface PickerImporter {
  readonly title: string;
  readonly extensions: readonly string[];
  readonly mimeTypes?: readonly string[];
}

const DOCUMENTS: Record<string, string[]> = {
  "application/x-paged+zip": [".paged"],
  "application/vnd.adobe.indesign-idml-package": [".idml"],
};

/** The platform refuses the whole call over one malformed entry. */
const EXTENSION = /^\.[a-z0-9+_-]{1,15}$/i;
const MIME = /^[a-z0-9.+-]+\/[a-z0-9.+*-]+$/i;
const FALLBACK_MIME = "application/octet-stream";

function acceptOf(imp: PickerImporter): Record<string, string[]> {
  const extensions = imp.extensions
    .map((e) => e.toLowerCase())
    .filter((e) => EXTENSION.test(e));
  if (extensions.length === 0) return {};
  const mime = imp.mimeTypes?.find((m) => MIME.test(m)) ?? FALLBACK_MIME;
  return { [mime]: extensions };
}

function merge(
  into: Record<string, string[]>,
  from: Record<string, string[]>,
): void {
  for (const [mime, extensions] of Object.entries(from)) {
    const list = (into[mime] ??= []);
    for (const e of extensions) if (!list.includes(e)) list.push(e);
  }
}

/** The picker's types: everything first, then documents, then each
 *  importer's own. */
export function pickerTypes(
  importers: readonly PickerImporter[],
  labels: { everything: string; documents: string },
): PickerType[] {
  const all: Record<string, string[]> = {};
  merge(all, DOCUMENTS);
  const own: PickerType[] = [];
  for (const imp of importers) {
    const accept = acceptOf(imp);
    if (Object.keys(accept).length === 0) continue;
    merge(all, accept);
    own.push({ description: imp.title, accept });
  }
  return [
    { description: labels.everything, accept: all },
    { description: labels.documents, accept: { ...DOCUMENTS } },
    ...own,
  ];
}

/** May Save write `.paged` bytes back over the picked file? Only over a
 *  `.paged` or an `.idml` (a container is a valid IDML package); over a
 *  Word or Excel file it would destroy the original, so such a file keeps
 *  no write-back handle and its first save makes a new file. */
export function writesBackTo(fileName: string): boolean {
  return /\.(paged|idml)$/i.test(fileName);
}
