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

// Whether an item is locked (ADR 251), read from its property snapshot
// (`elementLocked`): the canvas shows a locked item as locked — by its
// shape and a glyph, never by colour alone (the interaction specification's
// `UXI-OVR-008`, `UXI-TRN-006`, D-08).

import { useEffect, useState } from "react";

import type { ElementId } from "@paged-media/client";

import { useOptionalCanvasClient } from "./canvas-client-context";

/** Is the `elementLocked` entry of a property snapshot on? */
export function isLockedEntries(
  entries: ReadonlyArray<{ path: string; value?: unknown }>,
): boolean {
  const entry = entries.find((e) => e.path === "elementLocked");
  const v = entry?.value as { type?: string; value?: unknown } | undefined;
  return v?.value === true;
}

const keyOf = (id: ElementId) =>
  `${id.kind}:${String((id as { id?: unknown }).id)}`;

/** The keys (`kind:id`) of the locked items among `ids`, refreshed when
 *  the ids change or the document does. */
export function useLockedKeys(ids: readonly ElementId[]): ReadonlySet<string> {
  const client = useOptionalCanvasClient();
  // The answer, with the ids it answers: an answer for other ids is not
  // shown (no state is reset during an effect).
  const [answer, setAnswer] = useState<{
    asked: string;
    keys: ReadonlySet<string>;
  }>({ asked: "", keys: NONE });
  const [revision, setRevision] = useState(0);
  const asked = ids.map(keyOf).join("|");
  useEffect(() => {
    if (!client) return;
    return client.subscribe((msg) => {
      if (
        msg.kind === "mutationApplied" ||
        msg.kind === "undoApplied" ||
        msg.kind === "redoApplied"
      )
        setRevision((n) => n + 1);
    });
  }, [client]);
  useEffect(() => {
    // The ids again, from their keys: the effect depends on the keys only
    // (the caller hands a new array every render).
    const wanted = asked
      ? asked.split("|").map((k) => {
          const i = k.indexOf(":");
          return { kind: k.slice(0, i), id: k.slice(i + 1) } as ElementId;
        })
      : [];
    if (!client || wanted.length === 0) return;
    let live = true;
    void Promise.all(
      wanted.map((id) =>
        client
          .elementProperties(id)
          .then((p) => (p && isLockedEntries(p.entries) ? keyOf(id) : null))
          .catch(() => null),
      ),
    ).then((keys) => {
      if (!live) return;
      const set = new Set(keys.filter((k): k is string => k !== null));
      setAnswer({ asked, keys: set.size === 0 ? NONE : set });
    });
    return () => {
      live = false;
    };
  }, [client, asked, revision]);
  return client && asked !== "" && answer.asked === asked ? answer.keys : NONE;
}

const NONE: ReadonlySet<string> = new Set();
