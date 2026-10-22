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

// SDK Phase 5 / panel-gallery pass — Condition Sets panel.
//
// Gallery list shape over every `<ConditionSet>`: glyph rows with
// the condition count, plus a per-set Apply trail button that activates
// the set (`activateConditionSet`: each member condition's recorded
// visibility comes back). It was a disabled seam awaiting that operation
// after the engine had it (PN-101); a refusal is said in words.

import { useState } from "react";

import { refusalText } from "@paged-media/panel-kit";
import {
  CockpitBtn,
  ListRows,
  useCanvasClient,
  useCollection,
} from "@paged-media/shell";
import type { ConditionSetSummary } from "@paged-media/client";
import { defineMessages, useStrings } from "@paged-media/strings";

const M = defineMessages("app.conditionSetsPanel", {
  apply: "Apply",
  loading: "Loading condition sets…",
  empty: "No condition sets in this document.",
  conditions: "{count, plural, one {# condition} other {# conditions}}",
});

export function ConditionSetsPanel() {
  const strings = useStrings();
  const client = useCanvasClient();
  const items = useCollection<ConditionSetSummary>("conditionSets");
  const [refused, setRefused] = useState<string | null>(null);
  const apply = async (set: string) => {
    const reply = (await client
      .mutate({ op: "activateConditionSet", args: { set } })
      .catch((err: unknown) => ({
        kind: "failed",
        payload: { error: err },
      }))) as {
      kind: string;
      payload?: { error?: unknown };
    };
    setRefused(
      reply.kind === "mutationApplied"
        ? null
        : refusalText(reply.payload?.error ?? reply.kind, strings.t(M.apply)),
    );
  };
  if (items === null) {
    return (
      <div
        className="p-3 text-xs text-muted-foreground"
        data-condition-sets-panel="loading"
      >
        {strings.t(M.loading)}
      </div>
    );
  }
  return (
    <div data-condition-sets-panel="ready">
      {items.length === 0 ? (
        <div
          className="p-3 text-xs text-muted-foreground"
          data-empty-condition-sets
        >
          {strings.t(M.empty)}
        </div>
      ) : (
        <div data-condition-set-list>
          <ListRows
            rows={items.map((set) => ({
              key: set.selfId,
              icon: "panel-condition-sets",
              primary: set.name,
              secondary: strings.t(M.conditions, {
                count: set.conditions.length,
              }),
              trail: (
                <CockpitBtn
                  sm
                  tone="soft"
                  onClick={() => void apply(set.selfId)}
                >
                  {strings.t(M.apply)}
                </CockpitBtn>
              ),
            }))}
          />
          {refused && (
            <div
              className="px-3 pb-2 text-xs"
              role="status"
              data-condition-set-refused
              style={{ color: "var(--pg-danger, var(--pg-muted-fg))" }}
            >
              {refused}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
