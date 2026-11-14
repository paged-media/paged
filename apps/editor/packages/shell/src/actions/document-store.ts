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

// Editor ADR 1240 — the actions a DOCUMENT keeps: the recipe that belongs to
// one publication (store.ts explains why the editor's own list stays in the
// browser). They live in one label on `doc`, `x-paged:actions`, whose value
// is the envelope `{"v": 1, "data": <library>}`: a label travels with the
// file through `.paged` and IDML, and writing it is an ordinary document
// write — one undo step, named — so saving an action into a document is as
// undoable as any edit.

import { useEffect, useRef, useState } from "react";

import { changesTheDocument, type CanvasClient } from "@paged-media/client";

import type { ShellObjectModelHost } from "../catalog/object-model-types";
import {
  ACTIONS_SCHEMA_VERSION,
  parseLibrary,
  type PagedAction,
} from "./model";

/** The `doc` label the document's actions live in. */
export const DOCUMENT_ACTIONS_LABEL = "x-paged:actions";

/** A label larger than this is refused rather than written (the engine
 *  keeps a label's value whole; a recipe this size is a script). */
export const DOCUMENT_ACTIONS_MAX_BYTES = 60_000;

/** The actions a label's raw value holds (an older or malformed value
 *  holds none). Each comes back with `scope: "document"`. */
export function parseDocumentActions(raw: unknown): PagedAction[] {
  let value: unknown = raw;
  try {
    if (typeof raw === "string") value = JSON.parse(raw);
  } catch {
    return [];
  }
  const env = value as { v?: unknown; data?: unknown } | null;
  if (!env || env.v !== 1) return [];
  return parseLibrary(env.data).actions.map((a) => ({
    ...a,
    scope: "document" as const,
  }));
}

/** The label value for `actions`. */
export function documentActionsValue(actions: readonly PagedAction[]): string {
  return JSON.stringify({
    v: 1,
    data: {
      schema: ACTIONS_SCHEMA_VERSION,
      actions: actions.map((a) => ({ ...a, scope: "document" })),
    },
  });
}

export interface DocumentActions {
  /** The open document's actions (empty without a document). */
  actions: readonly PagedAction[];
  /** Whether this editor can keep actions in the document (it has an
   *  object model to read the label through). */
  available: boolean;
  /** Write `actions` as the document's list: one undo step. Resolves the
   *  refusal in words, or null when written. */
  save(actions: readonly PagedAction[], label: string): Promise<string | null>;
}

/** The open document's actions, read again after every document change. */
export function useDocumentActions(
  client: CanvasClient,
  model: ShellObjectModelHost | null,
  tooLarge: string,
): DocumentActions {
  const [actions, setActions] = useState<readonly PagedAction[]>([]);
  const ticket = useRef(0);
  useEffect(() => {
    if (!model) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const read = () => {
      const mine = ++ticket.current;
      void model.objects
        .get("doc", "labels")
        .then((v) => {
          if (mine !== ticket.current) return;
          const map =
            v.kind === "value" && v.value && typeof v.value === "object"
              ? (v.value as Record<string, unknown>)
              : {};
          setActions(parseDocumentActions(map[DOCUMENT_ACTIONS_LABEL] ?? null));
        })
        .catch(() => {
          if (mine === ticket.current) setActions([]);
        });
    };
    read();
    const off = client.subscribe((msg) => {
      if (!changesTheDocument(msg)) return;
      // One read per burst of changes (typing writes on every key).
      if (timer) clearTimeout(timer);
      timer = setTimeout(read, 120);
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [client, model]);

  return {
    actions,
    available: model !== null,
    async save(next, label) {
      const value = documentActionsValue(next);
      if (value.length > DOCUMENT_ACTIONS_MAX_BYTES) return tooLarge;
      const reply = (await client.mutate(
        {
          op: "setDocumentMetadata",
          args: { key: DOCUMENT_ACTIONS_LABEL, value },
        } as never,
        { label },
      )) as { kind: string; payload?: { error?: { kind?: string } } };
      if (reply.kind === "mutationFailed")
        return reply.payload?.error?.kind ?? "refused";
      setActions(next.map((a) => ({ ...a, scope: "document" as const })));
      return null;
    },
  };
}
