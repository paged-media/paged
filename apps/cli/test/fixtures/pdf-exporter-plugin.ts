/*
 * This file is part of paged (https://paged.media).
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

// A typed PDF exporter whose args struct carries DEFAULTS and OPTIONAL
// fields (ADR 323 §21.8) — the shape of paged.publish's `exportPdf`. Its
// handler answers the args it RECEIVED (after `invoke` filled the
// defaults) as the "PDF" bytes, so a spec can read back exactly what the
// plugin saw. The CLI loads it with `--plugins <path>`.

import type { PagedBundle, ValueType } from "@paged-media/plugin-api";

export const EXPORT_PDF = "acme.pdfx.exportPdf";

export const ARGS: ValueType = {
  kind: "struct",
  fields: {
    standard: { kind: "enum", members: ["pdf17", "pdfx4"], default: "pdf17" },
    pages: { kind: "text", maxLength: 32, default: "" },
    cropMarks: { kind: "bool", default: false },
    bleed: { kind: "list", of: { kind: "length" }, maxItems: 4, default: [] },
    effectDpi: { kind: "number", unit: "ppi", default: 300 },
    title: { kind: "text", optional: true },
  },
};

const bundle: PagedBundle = {
  manifest: {
    id: "acme.pdfx",
    name: "PDF exporter (typed, with defaults)",
    version: "0.0.0",
    apiVersion: "^0.2.0",
    capabilities: { document: { read: "broad" } },
    contributes: { objectModel: { kinds: [], commands: [{ id: EXPORT_PDF, title: "Export PDF", args: ARGS }] } },
  },
  activate(host) {
    return host.contribute.objectModel({
      kinds: [],
      commands: [
        {
          id: EXPORT_PDF,
          title: "Export PDF",
          args: ARGS,
          handler: (_ctx, args) => ({
            bytes: new TextEncoder().encode(`%PDF-fake ${JSON.stringify(args)}`),
            fileName: "document.pdf",
            mimeType: "application/pdf",
            pageCount: 1,
            diagnostics: [],
          }),
        },
      ],
    });
  },
};

export default bundle;
