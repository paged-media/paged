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

// Editor ADR 1242 — every object answers the same verbs (the strategy's
// Concept J): Inspect, Transform, Copy, Bind to data, Style, Version
// (a checkpoint), Validate and Export, as host commands `paged.verb.<verb>`
// that work on what is selected in every context — a page item, or a frame
// of a module (a sheet, a vector graphic, an image, a web frame, a Word
// document, a chart, a data binding) whether it is entered or only
// selected. Each verb runs the MODULE's own implementation where the
// module's edit context names one (extensions ADR 1110, `verbs`), and the
// host's otherwise:
//
//   inspect    the Properties panel
//   transform  the Transform panel
//   copy       Edit ▸ Copy (the clipboard already follows the context)
//   bindData   the Data panel
//   style      Paragraph Styles for text, Object Styles for an object
//   version    a named checkpoint on the document's timeline (ADR 1234)
//   validate   the publication's health
//   export     Asset Export, with the selection collected
//
// The same eight rows, in the same order and words, stand in the canvas
// context menu (also inside a module's frame surface) and the palette.

import {
  cockpitActionsOf,
  readEnvelope,
  scopeOf,
  type CommandContribution,
  type ContextMenuEntry,
  type PagedEditor,
} from "@paged-media/shell";
import type { ObjectVerb } from "@paged-media/plugin-api";
import type { ElementId } from "@paged-media/client";
import { defineMessages, t } from "@paged-media/strings";

import { PAGED_EDIT_COPY } from "./clipboard-commands";
import { keepCheckpointReported } from "./checkpoints/checkpoints";
import {
  ASSET_EXPORT_PANEL,
  PAGED_ASSET_EXPORT_COLLECT_SINGLE,
} from "./asset-export/commands";

const M = defineMessages("app.verbs", {
  inspect: "Inspect",
  transform: "Transform…",
  copy: "Copy",
  bindData: "Bind to data…",
  style: "Style…",
  version: "Save a version",
  validate: "Validate",
  export: "Export…",
  needsObject: "Select an object first",
  checkpoint: "Version {time}",
});

/** The verbs, in the order every surface lists them. */
export const OBJECT_VERBS: readonly ObjectVerb[] = [
  "inspect",
  "transform",
  "copy",
  "bindData",
  "style",
  "version",
  "validate",
  "export",
];

/** The host command of `verb`. */
export const verbCommand = (verb: ObjectVerb): string => `paged.verb.${verb}`;

/** The context menu's verb rows (one group, first). */
export const VERB_MENU_ROWS: readonly ContextMenuEntry[] = OBJECT_VERBS.map(
  (verb) => ({ command: verbCommand(verb), group: "verbs" }),
);

/** The slices of the editor handle the verbs read. */
interface VerbState {
  selection?: { elementSelection?: readonly ElementId[] } | null;
  contentSelection?: { contentSelection?: unknown } | null;
  /** The active edit context's frame (`PagedEditor.editContext`). */
  editContext?: { type?: string } | null;
  client?: unknown;
  registries?: {
    commands?: {
      get(id: string): unknown;
      invoke(id: string, payload?: unknown): Promise<unknown>;
      applicability?(id: string): { state: string };
    };
    editContexts?: {
      get(
        type: string,
      ): { verbs?: Partial<Record<ObjectVerb, string>> } | undefined;
    };
    objectTypes?: {
      list(): Array<{
        editContextType?: string;
        metadataKey?: string;
        matches?(c: unknown): boolean;
      }>;
    };
  } | null;
}

const activeContextOf = (s: VerbState | null): string | null =>
  s?.editContext?.type ?? null;

/** A verb applies on a selection, a text selection, or inside a context. */
export const verbApplies = (state: unknown): boolean => {
  const s = state as VerbState | null;
  return (
    (s?.selection?.elementSelection?.length ?? 0) > 0 ||
    s?.contentSelection?.contentSelection != null ||
    activeContextOf(s) !== null
  );
};

/** The module context a selected frame belongs to (the object type that
 *  claims it by its metadata, as a double-click resolves it), or null. */
async function frameContextOf(s: VerbState): Promise<string | null> {
  const selection = s.selection?.elementSelection ?? [];
  const types = s.registries?.objectTypes?.list() ?? [];
  if (selection.length !== 1 || types.length === 0) return null;
  const element = selection[0]!;
  const client = s.client as {
    elementProperties?(id: ElementId): Promise<{ entries: unknown[] } | null>;
  } | null;
  const props = await client?.elementProperties?.(element).catch(() => null);
  const entries = (props?.entries ?? []) as ReadonlyArray<{ value?: unknown }>;
  for (const ot of types) {
    if (!ot.editContextType) continue;
    const candidate = {
      id: element,
      kind: (element as { kind?: string }).kind,
      groupChain: [],
      metadata: ot.metadataKey ? readEnvelope(entries, ot.metadataKey) : null,
    };
    try {
      if (ot.matches?.(candidate)) return ot.editContextType;
    } catch {
      // A throwing matcher claims nothing.
    }
  }
  return null;
}

/** Where `verb` runs on what is selected now: the module's command, when
 *  its context (entered, or the selected frame's) names one this editor
 *  has and it applies, else the host's. */
export async function resolveVerb(
  paged: PagedEditor,
  verb: ObjectVerb,
): Promise<
  { via: "module"; command: string; context: string } | { via: "host" }
> {
  const s = paged as unknown as VerbState;
  const context = activeContextOf(s) ?? (await frameContextOf(s));
  if (context) {
    const command = s.registries?.editContexts?.get(context)?.verbs?.[verb];
    const commands = s.registries?.commands;
    // The module's, when this editor has it and it applies here (its own
    // `when`: a sheet's Copy needs an open workbook); the host's otherwise.
    if (
      command &&
      commands?.get(command) &&
      (commands.applicability?.(command)?.state ?? "here") === "here"
    )
      return { via: "module", command, context };
  }
  return { via: "host" };
}

const openPanel = (paged: PagedEditor, id: string) =>
  cockpitActionsOf(scopeOf(paged)).openPanel?.(id);

/** The host's own verb. */
async function hostVerb(paged: PagedEditor, verb: ObjectVerb): Promise<void> {
  const s = paged as unknown as VerbState;
  const commands = s.registries?.commands;
  switch (verb) {
    case "inspect":
      return openPanel(paged, "paged.properties");
    case "transform":
      return openPanel(paged, "paged.object-transform");
    case "copy":
      await commands?.invoke(PAGED_EDIT_COPY);
      return;
    case "bindData":
      return openPanel(paged, "paged.data");
    case "style":
      return openPanel(
        paged,
        s.contentSelection?.contentSelection != null
          ? "paged.paragraph-styles"
          : "paged.object-styles",
      );
    case "version":
      // A named checkpoint on the document's timeline (editor ADR 1234),
      // or the reason it cannot be kept, said through the feedback service.
      await keepCheckpointReported(
        paged,
        t(M.checkpoint, {
          time: new Date().toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          }),
        }),
      );
      return;
    case "validate":
      return openPanel(paged, "paged.publication-health");
    case "export":
      if (
        commands?.applicability?.(PAGED_ASSET_EXPORT_COLLECT_SINGLE)?.state ===
        "here"
      ) {
        await commands.invoke(PAGED_ASSET_EXPORT_COLLECT_SINGLE);
        return;
      }
      return openPanel(paged, ASSET_EXPORT_PANEL);
  }
}

/** Run `verb` on what is selected: the module's, or the host's. */
export async function runVerb(
  paged: PagedEditor,
  verb: ObjectVerb,
): Promise<void> {
  const where = await resolveVerb(paged, verb);
  if (where.via === "module") {
    const commands = (paged as unknown as VerbState).registries?.commands;
    await commands?.invoke(where.command);
    return;
  }
  await hostVerb(paged, verb);
}

/** The eight host commands. */
export function buildVerbCommands(): CommandContribution[] {
  return OBJECT_VERBS.map((verb) => ({
    id: verbCommand(verb),
    get title() {
      return t(M[verb]);
    },
    category: "Object",
    keywords: "verb",
    applicability: (state: unknown) =>
      verbApplies(state)
        ? { state: "here" as const }
        : { state: "disabled" as const, reason: t(M.needsObject) },
    handler: (paged: unknown) => runVerb(paged as PagedEditor, verb),
  }));
}
