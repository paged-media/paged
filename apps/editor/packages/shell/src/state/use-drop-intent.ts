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

// The canvas drop zone's file handling (editor ADR 1205): drag-over shows
// what the drop will do (UXI-DND-002), the drop does exactly that after
// revalidating the document and the context it was shown for
// (UXI-DND-004). The intent is `resolveDropIntent`'s, over the target the
// engine hit-tests under the pointer.

import { useRef } from "react";

import {
  dropIntentDrag,
  type DropIntentDrag,
} from "../overlays/drop-intent-overlay";
import { PLACE_DROPPED_COMMAND } from "./commands/file-commands";
import {
  resolveDropIntent,
  revalidateDrop,
  type DropEpoch,
  type DropFile,
  type DropIntent,
} from "./drop-intent";
import { dropTargetAt } from "./drop-target";
import { useEditorScope } from "./editor-scope";
import { useOptionalPaged, type PagedEditor } from "./paged-editor";
import { documentNeedsSave } from "./save-status";
import { useSessionRole } from "./session-role";

/** What a drop resolved to, handed to the shell's file door. */
export type DropFileHandler = (
  file: File,
  at: { clientX: number; clientY: number },
  intent: DropIntent,
) => void;

/** Pointer travel below which drag-over does not hit-test again. */
const MOVE_PX = 3;

function epochOf(editor: PagedEditor | null): DropEpoch {
  const context = editor?.editContext ?? null;
  return {
    docId: editor?.document.handle?.docId ?? null,
    context: context
      ? `${context.type}:${JSON.stringify(context.scopeRoot)}`
      : null,
  };
}

/** The files a drag carries: names once dropped, types while dragging. */
function filesOf(data: DataTransfer, dropped: boolean): DropFile[] {
  if (dropped || (data.files?.length ?? 0) > 0) {
    return [...data.files].map((f) => ({ name: f.name, type: f.type }));
  }
  return [...(data.items ?? [])]
    .filter((i) => i.kind === "file")
    .map((i) => ({ name: null, type: i.type }));
}

/** Does the drag carry files at all (not text, not a data field)? A
 *  browser lists "Files" among the types; a drop also has the files. */
export function carriesFiles(data: {
  readonly types?: readonly string[];
  readonly files?: { readonly length: number } | null;
}): boolean {
  return (
    [...(data.types ?? [])].includes("Files") || (data.files?.length ?? 0) > 0
  );
}

export interface DropIntentHandlers {
  onDragEnter(e: React.DragEvent): void;
  onDragOver(e: React.DragEvent): void;
  onDragLeave(e: React.DragEvent): void;
  onDrop(e: React.DragEvent): void;
}

/**
 * The drop zone's handlers for files. A drag that carries no files is left
 * alone (the data-field drop and the browser handle it). `onFile` runs the
 * drop's intent; without it nothing is dropped.
 */
export function useDropIntent(
  onFile: DropFileHandler | null,
): DropIntentHandlers {
  const scope = useEditorScope();
  const paged = useOptionalPaged();
  const role = useSessionRole();
  const drag = dropIntentDrag(scope);
  const live = useRef({
    epoch: null as DropEpoch | null,
    seq: 0,
    at: null as { x: number; y: number } | null,
    intent: null as DropIntent | null,
  });

  const resolve = async (
    editor: PagedEditor | null,
    files: DropFile[],
    x: number,
    y: number,
  ): Promise<DropIntentDrag> => {
    const { target, frame } = editor
      ? await dropTargetAt(editor, x, y)
      : { target: { kind: "empty" as const }, frame: null };
    const importers = editor?.registries.importers ?? null;
    const intent = resolveDropIntent({
      files,
      target,
      needsSave: documentNeedsSave(scope),
      role,
      canPlace: Boolean(editor?.registries.commands.get(PLACE_DROPPED_COMMAND)),
      importer: (f) => {
        const imp = importers?.resolve(f.name ?? "", f.type || undefined);
        return imp ? { title: imp.title } : null;
      },
    });
    // Outline the frame only when the picture goes into it.
    return {
      intent,
      clientX: x,
      clientY: y,
      frame: intent.frame ? frame : null,
    };
  };

  const clear = () => {
    live.current.seq += 1;
    live.current.at = null;
    live.current.intent = null;
    drag.set(null);
  };

  return {
    onDragEnter(e) {
      if (!onFile || !carriesFiles(e.dataTransfer)) return;
      e.preventDefault();
      if (live.current.epoch === null) live.current.epoch = epochOf(paged);
    },
    onDragOver(e) {
      if (!onFile || !carriesFiles(e.dataTransfer)) return;
      e.preventDefault();
      if (live.current.epoch === null) live.current.epoch = epochOf(paged);
      const known = live.current.intent;
      e.dataTransfer.dropEffect = known?.intent === "reject" ? "none" : "copy";
      const { clientX: x, clientY: y } = e;
      const at = live.current.at;
      if (at && Math.hypot(at.x - x, at.y - y) < MOVE_PX) return;
      live.current.at = { x, y };
      const seq = ++live.current.seq;
      const files = filesOf(e.dataTransfer, false);
      void resolve(paged, files, x, y).then((next) => {
        // A newer position, a leave or a drop made this answer stale.
        if (seq !== live.current.seq) return;
        live.current.intent = next.intent;
        drag.set(next);
      });
    },
    onDragLeave(e) {
      // Leaving for a child of the zone is no leave.
      const next = e.relatedTarget as Node | null;
      if (next && (e.currentTarget as Node).contains(next)) return;
      live.current.epoch = null;
      clear();
    },
    onDrop(e) {
      if (!onFile || !carriesFiles(e.dataTransfer)) return;
      e.preventDefault();
      const dragged = live.current.epoch ?? epochOf(paged);
      live.current.epoch = null;
      clear();
      const file = e.dataTransfer.files[0];
      if (!file) return;
      const at = { clientX: e.clientX, clientY: e.clientY };
      const files = filesOf(e.dataTransfer, true);
      // UXI-DND-004 — the document or the context changed between the
      // drag that showed the label and the drop: nothing lands.
      const stale = revalidateDrop(dragged, epochOf(paged));
      if (stale) {
        onFile(file, at, stale);
        return;
      }
      void resolve(paged, files, at.clientX, at.clientY).then((next) =>
        onFile(file, at, next.intent),
      );
    },
  };
}
