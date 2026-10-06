/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * This file is part of paged (https://paged.media) and is additionally
 * available under the Paged Media Enterprise License (PMEL). Full
 * copyright and license information is available in LICENSE.md which is
 * distributed with this source code.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    MPL-2.0 OR Paged Media Enterprise License (PMEL)
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
