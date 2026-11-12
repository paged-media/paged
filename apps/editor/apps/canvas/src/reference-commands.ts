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

// `paged.insert.footnote` / `endnote` / `bookmark` / `crossReference` /
// `indexEntry` — the reference inserts as host commands (P2).
//
// A footnote, a bookmark (a named text destination), a cross-reference and
// an index entry are text structure every kind of document has; nothing
// about them is Word's. The insert is one implementation in
// `@paged-media/helpers` (`insertReference`); this file is the host's door
// for it over the live text selection, the commands the palette and the
// Type menu run, and the typed twins (`referenceTypedCommands`) that
// scripts and paged.doc's Word-styled References dialogs call by id. A bare
// Bookmark, Cross-reference or Index entry command opens the host panel
// that has its form (Cross-References: a named destination and a
// cross-reference; Index: a page reference).

import type {
  CommandContribution,
  MenuItemContribution,
} from "@paged-media/shell";
import type { CanvasClient } from "@paged-media/client";
import {
  insertReference,
  type ReferenceDoor,
  type ReferenceInsert,
} from "@paged-media/helpers";
import { contentToChar, paragraphTexts } from "@paged-media/plugin-sdk";
import { refusalText } from "@paged-media/panel-kit";
import { defineMessages, t } from "@paged-media/strings";

const M = defineMessages("app.referenceCommands", {
  footnote: "Insert footnote",
  endnote: "Insert endnote",
  bookmark: "Insert bookmark…",
  crossReference: "Insert cross-reference…",
  indexEntry: "New index entry…",
});

// The menu leaves (`menu.<label>`).
defineMessages("menu", {
  "Insert footnote": "Insert footnote",
  "Insert endnote": "Insert endnote",
  "Insert bookmark…": "Insert bookmark…",
  "Insert cross-reference…": "Insert cross-reference…",
  "New index entry…": "New index entry…",
});

/** The Problems panel's source id for these commands. */
export const REFERENCE_DIAGNOSTIC_SOURCE = "paged.insert.references";

/** What the door needs of the app: the client and the live selection. */
export interface ReferenceDeps {
  client: Pick<CanvasClient, "send" | "mutate">;
  getSelection: () => {
    storyId: string;
    start: number;
    end?: number;
    cell?: unknown;
  } | null;
}

/** The inserts' door over the live text selection (a story's text, not a
 *  table cell's: cell offsets are not story offsets). */
export function referenceDoorOf(deps: ReferenceDeps): ReferenceDoor {
  const selection = () => {
    const sel = deps.getSelection();
    return sel && !sel.cell
      ? { storyId: sel.storyId, start: sel.start, end: sel.end ?? sel.start }
      : null;
  };
  return {
    selection,
    async characterRange() {
      const sel = selection();
      if (!sel) return null;
      try {
        const reply = await deps.client.send({
          kind: "requestStoryContent",
          payload: { storyId: sel.storyId },
        });
        if (reply.kind !== "storyContentResult" || !reply.payload.content)
          return null;
        const paras = paragraphTexts(reply.payload.content);
        return {
          storyId: sel.storyId,
          start: contentToChar(paras, sel.start),
          end: contentToChar(paras, sel.end),
        };
      } catch {
        return null;
      }
    },
    async mutate(mutation) {
      const reply = await deps.client.mutate(mutation as never);
      return reply.kind === "mutationFailed"
        ? { applied: false, error: refusalText(reply.payload.error, "Text") }
        : { applied: true };
    },
  };
}

/** The payload a command was run with, as an insert; null when bare. */
function insertOf(
  kind: ReferenceInsert["kind"],
  payload: unknown,
): ReferenceInsert | null {
  const p = (payload ?? {}) as Record<string, unknown>;
  switch (kind) {
    case "footnote":
    case "endnote":
      return { kind, text: typeof p.text === "string" ? p.text : "" };
    case "bookmark":
      return typeof p.name === "string" ? { kind, name: p.name } : null;
    case "crossReference": {
      const referTo =
        p.referTo === "pageNumber" || p.referTo === "aboveBelow"
          ? p.referTo
          : "text";
      if (typeof p.bookmark === "string")
        return { kind, target: { bookmark: p.bookmark }, referTo };
      if (typeof p.storyId === "string" && typeof p.paragraph === "number")
        return {
          kind,
          target: { storyId: p.storyId, paragraph: p.paragraph },
          referTo,
        };
      return null;
    }
    case "indexEntry":
      return Array.isArray(p.topic)
        ? { kind, topic: p.topic.map(String) }
        : null;
  }
}

/** The panel a bare command opens (its form is there). */
const PANEL_OF: Partial<Record<ReferenceInsert["kind"], string>> = {
  bookmark: "paged.cross-references",
  crossReference: "paged.cross-references",
  indexEntry: "paged.index",
};

/** The commands, their ids spelled out for the static surface inventory
 *  (they are `REFERENCE_INSERT_COMMANDS`, which a spec holds them to). */
export const REFERENCE_ENTRIES = [
  { kind: "footnote", id: "paged.insert.footnote", menu: "Insert footnote" },
  { kind: "endnote", id: "paged.insert.endnote", menu: "Insert endnote" },
  { kind: "bookmark", id: "paged.insert.bookmark", menu: "Insert bookmark…" },
  {
    kind: "crossReference",
    id: "paged.insert.crossReference",
    menu: "Insert cross-reference…",
  },
  {
    kind: "indexEntry",
    id: "paged.insert.indexEntry",
    menu: "New index entry…",
  },
] as const;

/** The commands. `report` lands a refusal in the Problems panel. */
export function buildReferenceCommands(
  deps: ReferenceDeps,
  openPanel: (panelId: string) => void,
  report: (message: string) => void,
  clear: () => void,
): CommandContribution[] {
  const door = referenceDoorOf(deps);
  return REFERENCE_ENTRIES.map(({ kind, id }) => ({
    id,
    title: t(M[kind]),
    category: "Insert",
    handler: async (_paged: unknown, payload?: unknown) => {
      const r = insertOf(kind, payload);
      if (!r) {
        const panel = PANEL_OF[kind];
        if (panel) openPanel(panel);
        return;
      }
      clear();
      const out = await insertReference(door, r);
      if (!out.applied) report(out.error ?? "refused");
    },
  }));
}

/** Type > Insert footnote / endnote / bookmark… / cross-reference… / New
 *  index entry…. */
export const REFERENCE_MENU_ITEMS: MenuItemContribution[] =
  REFERENCE_ENTRIES.map((e, i) => ({
    path: `Type/${e.menu}`,
    command: e.id,
    order: 60 + i / 10,
    group: "references",
  }));
