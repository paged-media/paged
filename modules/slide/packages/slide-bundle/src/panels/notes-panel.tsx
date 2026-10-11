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

// The Notes panel: the speaker notes of the slide the user is on, edited in
// place. A change is written when the field loses focus (one undoable
// step per edit, not per keystroke), into the slide's page metadata, so
// notes move, duplicate and undo with their slide.

import type { BundleHost, PanelProps } from "@paged-media/plugin-api";
import * as React from "react";

import { setStateMutation, type SlidesStore } from "../slides-model.js";

export function makeNotesPanel(host: BundleHost, store: SlidesStore): React.ComponentType<PanelProps> {
  const Component: React.FC<PanelProps> = () => {
    const [, force] = React.useReducer((n: number) => n + 1, 0);
    React.useEffect(() => store.subscribe(force), []);
    const slide = store.activeSlide();
    const saved = slide?.state.notes ?? "";
    const [draft, setDraft] = React.useState(saved);
    // Another slide, or the notes changed underneath (undo): show them.
    React.useEffect(() => setDraft(saved), [slide?.pageId, saved]);

    if (!slide) {
      return (
        <div style={{ padding: 12, fontSize: 13, opacity: 0.7 }} data-notes-panel="empty">
          No slide selected.
        </div>
      );
    }
    const commit = () => {
      if (draft === saved) return;
      void host.document
        .mutate(setStateMutation(slide.pageId, { ...slide.state, notes: draft }))
        .catch((e) => host.log.warn(`paged.slide: ${String(e)}`));
    };
    return (
      <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 6, height: "100%" }} data-notes-panel="ready">
        <div style={{ fontSize: 11, opacity: 0.7 }}>Slide {slide.number} · speaker notes</div>
        <textarea
          data-notes-text
          value={draft}
          placeholder="Click to add notes"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          style={{ flex: 1, minHeight: 80, resize: "vertical", font: "inherit", fontSize: 13 }}
        />
      </div>
    );
  };
  return Component;
}
