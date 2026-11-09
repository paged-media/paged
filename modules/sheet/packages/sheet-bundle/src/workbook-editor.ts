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

// The workbook editor (extensions ADR 1102): paged.sheet offers its grid
// and engine to the bundles that keep a workbook of their own (a chart's
// data in paged.slide). Each open is a session of its own over a detached
// workbook (`createWorkbookSession(host, { detached: true })`): the same
// engine, journal, formula bar and grid as the sheet's, but nothing is
// written into the document, and the document's own workbook is not
// touched. The consumer takes the bytes back (`saveXlsx`, the
// preservation-first save) and writes them where it keeps them.

import type {
  BundleHost,
  WorkbookEditSession,
  WorkbookEditorContribution,
} from "@paged-media/plugin-api";

import { createWorkbookSession } from "./session";
import { makeWorkbookGrid } from "./panels/grid-panel";

export const WORKBOOK_EDITOR_ID = "media.paged.sheet.workbookEditor";

/** The editor paged.sheet contributes. */
export function workbookEditor(host: BundleHost): WorkbookEditorContribution {
  return {
    id: WORKBOOK_EDITOR_ID,
    async open(request): Promise<WorkbookEditSession> {
      const session = createWorkbookSession(host, { detached: true });
      const ok = await session.import(
        request.xlsx,
        request.name ?? "workbook.xlsx",
      );
      if (!ok) {
        session.dispose();
        throw new Error(
          session.state().bootError ?? "paged.sheet: not a workbook it reads",
        );
      }
      // The sheet of the first range opens first.
      const first = request.ranges?.[0]?.sheet;
      const sheet = first
        ? session.sheets().find((x) => x.name === first)
        : undefined;
      if (sheet && sheet.id !== session.state().activeSheet)
        session.setActiveSheet(sheet.id);
      const baseline = session.editRevision();
      let closed = false;
      return {
        editor: WORKBOOK_EDITOR_ID,
        Surface: makeWorkbookGrid(session, request.ranges ?? []),
        changed: () => session.editRevision() !== baseline,
        xlsx: () => session.saveXlsx() ?? request.xlsx,
        onDidChange(listener) {
          let at = session.editRevision();
          return session.onDidChange(() => {
            const now = session.editRevision();
            if (now === at) return;
            at = now;
            listener();
          });
        },
        close() {
          if (closed) return;
          closed = true;
          session.dispose();
        },
      };
    },
  };
}

/** Offer the editor where the host shares a registry. */
export function contributeWorkbookEditor(host: BundleHost): Array<() => void> {
  if (!host.supports("contribute.workbookEditor@1")) return [];
  return [host.contribute.workbookEditor(workbookEditor(host)).dispose];
}
