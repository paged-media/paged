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

// @paged-media/pdf — the paged.pdf plugin bundle (Phase 0: image-only PDF
// import, zero Rust/wasm).
//
// Registration happens HERE, through the public contribution surface: a PDF
// importer that rasterizes pages (pdf.js) and wraps them in a minimal IDML
// package routed to `host.nativeDocument.open` (the engine owns the parse +
// inline-image path). The host tracks the registration; disposing the bundle
// removes it cleanly.

import { defineBundle } from "@paged-media/plugin-sdk";
import type {
  BundleHandle,
  BundleHost,
  PluginManifest,
} from "@paged-media/plugin-api";

import manifestJson from "../manifest.json";

import { contributePdfIo } from "./io/pdf";
import { contributePdfCommands } from "./commands";

export function activate(host: BundleHost): BundleHandle {
  // Phase 0 — the PDF importer, capability-gated. Surfaces the engine's
  // EXISTING IDML/inline-image path (via the native-document door) through
  // the plugin registry.
  const pdfIoSub = contributePdfIo(host);
  // ADR 323 — the import as a typed command (Node CLI, scripts).
  const commandsSub = contributePdfCommands(host);
  host.log.info(
    `activated — PDF importer (apiVersion ${manifestJson.apiVersion})`,
  );
  // The IO registration is allocated outside a facade-tracked registration,
  // so dispose the handle here.
  return {
    dispose() {
      pdfIoSub.dispose();
      commandsSub?.dispose();
    },
  };
}

export const pdfBundle = defineBundle({
  manifest: manifestJson as PluginManifest,
  activate,
});
