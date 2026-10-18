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

// @paged-media/publish — the paged.publish plugin bundle (ADR-022 Phase 4).
//
// Registration happens HERE, through the public contribution surface: an IDML
// importer (routed to `host.nativeDocument.open` — the engine owns the parse)
// and an IDML exporter (reusing the engine's existing serializer through the
// `host.editor` escape hatch, transitional per ADR-022 Phase 5). The host
// tracks both registrations; disposing the bundle removes them cleanly.

import { defineBundle } from "@paged-media/plugin-sdk";
import type {
  BundleHandle,
  BundleHost,
  PluginManifest,
} from "@paged-media/plugin-api";

import manifestJson from "../manifest.json";

import { contributeIdmlIo } from "./io/idml";
import { contributePublishCommands } from "./commands";

export function activate(host: BundleHost): BundleHandle {
  // ADR-022 Phase 4 — the IDML importer + exporter, capability-gated. Both
  // surface the engine's EXISTING IDML path (native-document door for import,
  // the `host.editor` escape hatch for export) through the plugin registry.
  const idmlIoSub = contributeIdmlIo(host);
  // ADR 323 — import/export as typed commands (the Node CLI's
  // `paged export --format pdf|idml|paged`, scripts, generated forms).
  const commandsSub = contributePublishCommands(host);
  host.log.info(
    `activated — IDML importer + exporter (apiVersion ${manifestJson.apiVersion})`,
  );
  // The IO registrations are allocated outside a facade-tracked registration,
  // so dispose the handle here.
  return {
    dispose() {
      idmlIoSub.dispose();
      commandsSub?.dispose();
    },
  };
}

export const publishBundle = defineBundle({
  manifest: manifestJson as PluginManifest,
  activate,
});
