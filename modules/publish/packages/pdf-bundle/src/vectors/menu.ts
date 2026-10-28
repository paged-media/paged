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

// Object ▸ Convert Placed PDF to Vectors (publish ADR 658): the selected
// placed PDF or Illustrator frame becomes native page items where it is,
// in one undo step. The report goes to the Problems panel (the bundle's
// diagnostics), the failure too.

import { defineMessages, t } from "@paged-media/strings";

import type { BundleHost, Disposable } from "@paged-media/plugin-api";

import { convertPlacedToVectors } from "./place";

const M = defineMessages("publish.pdfConvert", {
  title: "Convert Placed PDF to Vectors",
  failed: "Convert placed PDF to vectors: {why}",
});

// The menu's segment stays English (an identity); the host shows it
// through this message.
defineMessages("menu", {
  "Convert Placed PDF to Vectors": "Convert Placed PDF to Vectors",
});

export const CONVERT_COMMAND = "media.paged.pdf.command.convertPlaced";
export const CONVERT_MENU_PATH = "Object/Convert Placed PDF to Vectors";
/** The diagnostics key the report goes under. */
export const VECTORS_DIAGNOSTICS = "media.paged.pdf.vectors";

/** The command and its Object-menu entry. */
export function contributeConvertMenu(host: BundleHost): Disposable {
  const subs: Disposable[] = [];
  subs.push(
    host.contribute.command({
      id: CONVERT_COMMAND,
      title: t(M.title),
      category: "Object",
      handler: async () => {
        try {
          const r = await convertPlacedToVectors(host, {});
          host.diagnostics.set(
            VECTORS_DIAGNOSTICS,
            r.losses
              .filter((l) => l.code !== "colours")
              .map((l) => ({
                severity: "info" as const,
                message: l.message,
                source: CONVERT_COMMAND,
              })),
          );
          return r;
        } catch (err) {
          const why = err instanceof Error ? err.message : String(err);
          host.diagnostics.set(VECTORS_DIAGNOSTICS, [
            {
              severity: "warning",
              message: t(M.failed, { why }),
              source: CONVERT_COMMAND,
            },
          ]);
          host.log.warn(`${CONVERT_COMMAND}: ${why}`);
          return null;
        }
      },
    }),
  );
  subs.push(
    host.contribute.menu({
      path: CONVERT_MENU_PATH,
      command: CONVERT_COMMAND,
      group: "convert-plugin",
      order: 10,
    }),
  );
  return {
    dispose() {
      for (const s of subs) s.dispose();
    },
  };
}
