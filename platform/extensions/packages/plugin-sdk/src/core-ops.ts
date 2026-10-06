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

// `delete` of a core object, shared by both seams: every address kind with
// a delete op on the wire maps to it. Only `textVariable` (protocol 71)
// needs the newer engine.

import type { MutationInput, ParsedAddress } from "@paged-media/plugin-api";

import type { CorePlan } from "./core-objects";
import { formatAddress } from "./object-address";

const STYLE_DELETE = {
  paragraph: "deleteParagraphStyle",
  character: "deleteCharacterStyle",
  object: "deleteObjectStyle",
  cell: "deleteCellStyle",
  table: "deleteTableStyle",
} as const;

/** The delete mutation for a core address. `swatchId` / `pageId` resolve a
 *  swatch NAME and a `page:#n` to the self ids the ops take. */
export async function planCoreDelete(
  a: ParsedAddress,
  swatchId: (name: string) => Promise<string | null>,
  pageId: (a: ParsedAddress) => Promise<string | null>,
  protocol: number,
): Promise<CorePlan> {
  const ok = (m: MutationInput): CorePlan => ({ ok: true, mutations: [m] });
  const none = (why: string): CorePlan => ({ ok: false, code: "unknownAddress", reason: why });
  switch (a.kind) {
    case "item":
      return ok({ op: "deleteFrame", args: { frameId: a.id } });
    case "page":
    case "pageIndex": {
      const id = await pageId(a);
      return id ? ok({ op: "deletePage", args: { pageId: id } }) : none(`no page ${formatAddress(a)}`);
    }
    case "layer":
      return ok({ op: "layerRemove", args: { layerId: a.id } });
    case "swatch": {
      const id = await swatchId(a.name);
      return id ? ok({ op: "deleteSwatch", args: { swatchId: id } }) : none(`no swatch ${a.name}`);
    }
    case "gradient":
      return ok({ op: "deleteGradient", args: { gradientId: a.name } });
    case "colorGroup":
      return ok({ op: "deleteColorGroup", args: { groupId: a.name } });
    case "numberingList":
      return ok({ op: "deleteNumberingList", args: { listId: a.name } });
    case "style":
      return ok({ op: STYLE_DELETE[a.family], args: { styleId: a.name } } as MutationInput);
    case "master":
      return ok({ op: "deleteMaster", args: { master: a.id } });
    case "guide":
      return ok({ op: "deleteGuide", args: { guideId: a.id } });
    case "section":
      return ok({ op: "deleteSection", args: { sectionId: a.id } });
    case "textVariable":
      if (protocol < 71) return { ok: false, code: "unmapped", reason: "deleting a text variable needs engine protocol 71" };
      return ok({ op: "deleteTextVariable", args: { variableId: a.id } } as MutationInput);
    default:
      return { ok: false, code: "unmapped", reason: `delete ${formatAddress(a)}: the wire has no delete for this kind` };
  }
}
