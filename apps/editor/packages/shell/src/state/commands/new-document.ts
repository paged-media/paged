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

// Creating a document from the New document dialog's setup (editor ADR
// 1213). The page comes from the one blank path (`mintBlankDocument`, the
// engine's `newBlankDocument`); what the blank document does not carry is
// written with the engine's own operations, the ones Document Setup and
// Margins and Columns write (ADRs 267, 323): `insertPage` for the further
// pages, `set` on `doc` for the bleed and on each `page:#n` for its margins,
// columns and gutter. The writes are ONE undo group, and the document is
// then marked as it was made (`markSaved`, as an importer's build is, UX
// audit F-08): it opens clean, "Not saved yet", not "Unsaved changes".

import type { DocumentHandle, Mutation, Value } from "@paged-media/client";

import { defineMessages, t } from "@paged-media/strings";

import type { CommandContribution } from "../../registries";
import type { PagedEditor } from "../paged-editor";
import type { NewDocumentSetup } from "../new-document-presets";

/** The command that opens the New document dialog. */
export const PAGED_FILE_NEW_DIALOG = "paged.file.newDialog";

const M = defineMessages("shell.newDocument", {
  title: "New document…",
  refused:
    "The new document was created, but its setup was refused: {reason}. Set the margins and columns in Layout ▸ Margins and columns….",
});

const BLEED_PATHS = [
  "documentBleedTop",
  "documentBleedBottom",
  "documentBleedInsideOrLeft",
  "documentBleedOutsideOrRight",
] as const;

const length = (value: number): Value => ({ type: "length", value });

/** The writes that turn a one-page blank document into `setup`, in the
 *  order they apply: the further pages, then the bleed and every page's
 *  margins and columns. */
export function setupMutations(
  setup: NewDocumentSetup,
  firstPageId: string,
): { pages: Mutation | null; layout: Mutation } {
  const pages: Mutation[] = [];
  for (let i = 1; i < setup.pages; i++)
    pages.push({
      op: "insertPage",
      args: { afterPageId: firstPageId, masterId: null },
    });
  const layout: Mutation[] = [];
  if (setup.bleedPt > 0)
    for (const path of BLEED_PATHS)
      layout.push({
        op: "set",
        args: { address: "doc", path, value: length(setup.bleedPt) },
      });
  const m = setup.margins;
  for (let n = 1; n <= setup.pages; n++) {
    const address = `page:#${n}`;
    const set = (path: string, value: Value) =>
      layout.push({ op: "set", args: { address, path, value } });
    set("pageMarginTop", length(m.top));
    set("pageMarginBottom", length(m.bottom));
    set("pageMarginLeft", length(m.inside));
    set("pageMarginRight", length(m.outside));
    set("pageColumnCount", { type: "number", value: setup.columns });
    set("pageColumnGutter", length(setup.gutterPt));
  }
  return {
    pages: pages.length > 0 ? { op: "batch", args: { ops: pages } } : null,
    layout: { op: "batch", args: { ops: layout } },
  };
}

/** What a write answered, when it was refused. */
function refusal(reply: { kind: string; payload?: unknown }): string | null {
  if (reply.kind === "mutationApplied") return null;
  const error = (reply.payload as { error?: unknown } | undefined)?.error;
  if (typeof error === "string") return error;
  const kind = (error as { kind?: string } | undefined)?.kind;
  return kind ?? reply.kind;
}

/**
 * Write what `setup` asks of the blank document `handle` was just minted
 * as (the caller minted it at the setup's size, after asking to discard).
 * A write the engine refuses leaves the document as far as it got and
 * says why through `pushWarning` (nothing is faked); otherwise the
 * document is marked as made.
 */
export async function applyDocumentSetup(
  editor: PagedEditor,
  handle: DocumentHandle,
  setup: NewDocumentSetup,
  sinks: { pushWarning: (w: string) => void },
): Promise<boolean> {
  const first = handle.pageIds[0];
  if (!first) return false;
  const writes = setupMutations(setup, first);
  const client = editor.client;
  client.beginUndoGroup();
  let refused: string | null = null;
  try {
    if (writes.pages) refused = refusal(await client.mutate(writes.pages));
    if (!refused) refused = refusal(await client.mutate(writes.layout));
  } finally {
    await client.endUndoGroup();
  }
  if (refused) {
    sinks.pushWarning(t(M.refused, { reason: refused }));
    return false;
  }
  // The setup is how the document was made, not an edit of it.
  client.markSaved();
  return true;
}

/** File ▸ New document… — opens the New document dialog (editor ADR
 *  1213). `paged.file.new` stays the quick path: a blank Letter page, or
 *  the setup its payload carries, with no dialog (scripts, embeds). */
export function buildNewDocumentDialogCommand(
  open: (paged: unknown) => void,
): CommandContribution {
  return {
    id: PAGED_FILE_NEW_DIALOG,
    title: t(M.title),
    category: "File",
    handler: (paged) => {
      open(paged);
    },
  };
}
