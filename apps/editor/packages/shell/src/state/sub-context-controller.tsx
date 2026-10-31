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

// Editor ADR 301 — a header, footer or note edited IN PLACE (extensions
// ADR 349, C6). A bundle's provider answers a page double-click with the
// story to edit, the page it is edited on and the area it fills; the
// controller puts the caret into that story, pins its caret and range to
// that page (a master's story is laid out on every page that shows the
// master, and the engine answers its geometry on the first of them), and
// takes the Type tool. The overlay (`overlays/sub-context.tsx`) dims the
// rest of the page and shows the bar.
//
// Leaving: Escape takes the caret out of the text (useTextEditing), a
// click in the body moves it to another story; either way the selection
// leaves the sub-context's story, and that ends the sub-context. The
// bar's Close, the bundle's `exitSubContext` and a new document end it
// too, and take the caret with them.

import { useCallback, useEffect, useEffectEvent } from "react";

import type { CanvasClient } from "@paged-media/client";

import { useOptionalCanvasClient } from "./canvas-client-context";
import { useContentSelection } from "./content-selection-context";
import { useOptionalEditContextStack } from "./edit-context-stack";
import { useOptionalRegistries, useRegistries } from "./registries-context";
import { TEXT_TOOL_ID, useOptionalTool } from "./tool-context";
import type { SubContextState } from "../registries/sub-context";

const utf8 = new TextEncoder();

/** The UTF-8 byte offset of a story's end (the run bytes plus one
 *  separator per paragraph boundary, the engine's story offsets). */
export async function storyEndOffset(
  client: CanvasClient,
  storyId: string,
): Promise<number> {
  const reply = await client.send({
    kind: "requestStoryContent",
    payload: { storyId },
  });
  if (reply.kind !== "storyContentResult" || !reply.payload.content) return 0;
  const paragraphs = reply.payload.content.paragraphs;
  let bytes = Math.max(0, paragraphs.length - 1);
  for (const p of paragraphs) {
    for (const r of p.runs) bytes += utf8.encode(r.text).length;
  }
  return bytes;
}

export function SubContextController() {
  const { subContexts } = useRegistries();
  const client = useOptionalCanvasClient();
  const tool = useOptionalTool();
  const {
    setContentSelection,
    subscribeSelection,
    contentSelectionRef,
    setPagePin,
  } = useContentSelection();
  // The tool store's value changes with the tool; the effect must not
  // re-subscribe for it.
  const takeTypeTool = useEffectEvent(() => tool?.setBaseTool(TEXT_TOOL_ID));

  useEffect(() => {
    let entered: SubContextState | null = subContexts.current();
    const sync = () => {
      const now = subContexts.current();
      if (now === entered) return;
      const left = entered;
      entered = now;
      if (!now) {
        setPagePin(null);
        // Left by the bar, the bundle or a new document: the caret goes
        // with it. (Left by the caret leaving, there is nothing to take.)
        if (left && contentSelectionRef.current?.storyId === left.storyId) {
          setContentSelection(null);
        }
        return;
      }
      setPagePin({ storyId: now.storyId, pageId: String(now.pageId) });
      takeTypeTool();
      const place = (offset: number) => {
        if (subContexts.current() !== now) return;
        setContentSelection({
          storyId: now.storyId,
          start: offset,
          end: offset,
          affinity: false,
        });
      };
      if (now.offset != null) place(now.offset);
      else if (client) {
        void storyEndOffset(client, now.storyId)
          .then(place)
          .catch(() => place(0));
      } else place(0);
    };
    const changes = subContexts.onChange(sync);
    const offSelection = subscribeSelection(() => {
      const now = subContexts.current();
      if (!now) return;
      const sel = contentSelectionRef.current;
      if (sel?.storyId !== now.storyId) subContexts.exit();
    });
    const offClient = client?.subscribe((msg) => {
      if (msg.kind === "documentLoaded") subContexts.exit();
    });
    return () => {
      changes.dispose();
      offSelection();
      offClient?.();
    };
  }, [
    subContexts,
    client,
    setContentSelection,
    subscribeSelection,
    contentSelectionRef,
    setPagePin,
  ]);

  return null;
}

/** The point the canvas offers to the sub-context providers. */
export interface SubContextDoubleClick {
  pageId: string;
  pagePoint: [number, number];
}

/**
 * Editor ADR 301 — offer a page double-click to the sub-context providers
 * of the active edit context, else the document context. Resolves `true`
 * when one answered (a sub-context was entered: the canvas does nothing
 * else with the double-click).
 */
export function useSubContextEntry() {
  // Optional: the canvas mounts without the registries in some specs.
  const registries = useOptionalRegistries();
  const stack = useOptionalEditContextStack();
  const activeType = stack?.active?.type ?? null;
  // eslint-disable-next-line no-restricted-syntax -- read by the canvas's double-click handler (ADR 229)
  const trySubContext = useCallback(
    async (at: SubContextDoubleClick): Promise<boolean> => {
      if (!registries) return false;
      const editContext =
        activeType ?? registries.documentContext.get()?.type ?? null;
      if (!editContext) return false;
      const entered = await registries.subContexts.resolve({
        editContext,
        pageId: at.pageId,
        pagePoint: at.pagePoint,
      });
      return entered !== null;
    },
    [registries, activeType],
  );
  return { trySubContext };
}
