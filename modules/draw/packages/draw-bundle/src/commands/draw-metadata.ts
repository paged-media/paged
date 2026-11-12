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

// paged.draw's metadata envelope written INSIDE a batch: the one key and
// the one raw `setPluginMetadata` builder every command that stamps its
// envelope alongside its own edits uses (one undo step, not two).

import type {
  ElementId,
  Mutation,
  PluginMetadataEnvelope,
} from "@paged-media/plugin-api";
import { labelKey } from "@paged-media/helpers";

import manifest from "../../manifest.json";

/** This plugin's metadata key — the SAME derivation the SDK facade uses
 *  (`x-paged:<manifest id>`), spelled out here because a command writes
 *  its envelopes through RAW `setPluginMetadata` ops so they ride in the
 *  same batch as its edits (the facade's `setMetadata` is its own
 *  mutation, i.e. its own undo step, and a command would otherwise cost
 *  one more). The SDK's namespace gate still checks the key on the
 *  way through — a foreign key is refused before the engine sees it. */
export const DRAW_METADATA_KEY = labelKey(manifest.id);

/** A RAW `setPluginMetadata` op carrying this plugin's envelope.
 *
 *  Exported because it is the ONE builder every module that needs its
 *  envelope write to ride INSIDE its own batch uses (the graphic-style apply in
 *  `graphic-styles.ts`, the recipes, the migration): the facade's
 *  `setMetadata` is its own mutation, i.e. its own undo step, so an
 *  in-batch stamp is the difference between one undo step and two. The
 *  SDK's namespace gate still checks the key on the way through — a
 *  foreign key is refused before the engine sees it. */
export const stampDrawMetadata = (
  elementId: ElementId,
  envelope: PluginMetadataEnvelope | null,
): Mutation => ({
  op: "setPluginMetadata",
  args: {
    elementId,
    key: DRAW_METADATA_KEY,
    value: envelope === null ? null : JSON.stringify(envelope),
    caller: manifest.id,
  },
});
