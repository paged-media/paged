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

// SDK Phase 5 / panel-gallery pass — Cross References panel.
//
// Gallery list shape: source name + mono format secondary. Below it the
// two inserts at the text cursor (P2, the host's `paged.insert.bookmark`
// and `paged.insert.crossReference`, which paged.doc's References dialog
// calls too): a named destination (a text anchor, Word's bookmark), and a
// cross-reference to one, read as its text, its page number or
// above / below.

import { useState } from "react";
import { REFERENCE_INSERT_COMMANDS } from "@paged-media/helpers";
import {
  ListRows,
  useCollection,
  useContentSelection,
  useRegistries,
} from "@paged-media/shell";
import type { CrossReferenceSummary } from "@paged-media/client";
import { defineMessages, useStrings } from "@paged-media/strings";

const M = defineMessages("app.crossReferencesPanel", {
  loading: "Loading cross-references…",
  empty: "No cross-references in this document.",
  destinationName: "Destination name",
  newDestination: "+ New destination at the cursor",
  referTo: "Refer to",
  asText: "Its text",
  asPage: "Its page number",
  asAboveBelow: "Above / below",
  insert: "+ Insert cross-reference",
  placeCursor: "Place the text cursor where it goes",
});

const field =
  "w-full text-xs h-[26px] rounded-[6px] border bg-transparent px-2";
const button =
  "w-full text-xs h-[30px] rounded-[7px] border text-muted-foreground disabled:opacity-55";

/** The two inserts at the text cursor. */
function InsertForm() {
  const strings = useStrings();
  const registries = useRegistries();
  const { contentSelection } = useContentSelection();
  const [name, setName] = useState("");
  const [referTo, setReferTo] = useState("text");
  const caret = !!contentSelection && !contentSelection.cell;
  const run = (id: string, payload: unknown) =>
    void registries.commands.invoke(id, payload);
  const title = caret ? undefined : strings.t(M.placeCursor);
  return (
    <div className="px-3 pb-3 flex flex-col gap-2" data-cross-reference-insert>
      <input
        className={field}
        style={{ borderColor: "var(--chrome-divider)" }}
        placeholder={strings.t(M.destinationName)}
        aria-label={strings.t(M.destinationName)}
        value={name}
        onChange={(e) => setName(e.target.value)}
        data-destination-name
      />
      <button
        type="button"
        className={button}
        style={{ borderColor: "var(--chrome-divider)" }}
        disabled={!caret || !name.trim()}
        title={title}
        onClick={() => run(REFERENCE_INSERT_COMMANDS.bookmark, { name })}
        data-new-destination
      >
        {strings.t(M.newDestination)}
      </button>
      <label className="text-xs text-muted-foreground flex items-center gap-2">
        {strings.t(M.referTo)}
        <select
          className={field}
          style={{ borderColor: "var(--chrome-divider)" }}
          value={referTo}
          onChange={(e) => setReferTo(e.target.value)}
          data-refer-to
        >
          <option value="text">{strings.t(M.asText)}</option>
          <option value="pageNumber">{strings.t(M.asPage)}</option>
          <option value="aboveBelow">{strings.t(M.asAboveBelow)}</option>
        </select>
      </label>
      <button
        type="button"
        className={button}
        style={{ borderColor: "var(--chrome-divider)" }}
        disabled={!caret || !name.trim()}
        title={title}
        onClick={() =>
          run(REFERENCE_INSERT_COMMANDS.crossReference, {
            bookmark: name.trim(),
            referTo,
          })
        }
        data-insert-cross-reference
      >
        {strings.t(M.insert)}
      </button>
    </div>
  );
}

export function CrossReferencesPanel() {
  const strings = useStrings();
  const items = useCollection<CrossReferenceSummary>("crossReferences");
  if (items === null) {
    return (
      <div
        className="p-3 text-xs text-muted-foreground"
        data-cross-references-panel="loading"
      >
        {strings.t(M.loading)}
      </div>
    );
  }
  return (
    <div data-cross-references-panel="ready">
      {items.length === 0 ? (
        <div
          className="p-3 text-xs text-muted-foreground"
          data-empty-cross-references
        >
          {strings.t(M.empty)}
        </div>
      ) : (
        <div data-cross-reference-list>
          <ListRows
            rows={items.map((x) => ({
              key: x.selfId,
              icon: "panel-cross-references",
              primary: x.name,
              // The format by its name (R13, ADR 254), never its id.
              secondary: x.formatName ?? undefined,
            }))}
          />
        </div>
      )}
      <InsertForm />
    </div>
  );
}
