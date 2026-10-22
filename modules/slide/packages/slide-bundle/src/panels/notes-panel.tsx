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
//
// It is also the presenter's next / previous: two buttons step through the
// deck, and the notes follow the slide as a view transition (React 19.3,
// editor ADR 240) whose type is the direction of the move, so the next
// slide's notes come in from the right and the previous slide's from the
// left, whichever way the slide changed (these buttons, the Slides panel,
// the canvas). Under reduced motion they just change.

import type { BundleHost, PanelProps } from "@paged-media/plugin-api";
import { subscribeOf, useLive } from "@paged-media/react-live";
import { useStrings } from "@paged-media/strings";
import * as React from "react";

import { NOTES } from "../messages.js";
import { setStateMutation, type SlidesStore } from "../slides-model.js";

/** The transition types of a move through the deck. */
const NEXT = "paged-slide-next";
const PREV = "paged-slide-prev";

// The bundle's own view-transition styles, hoisted into the document head
// once (React 19 `<style href precedence>`), not the host's stylesheet.
const NOTES_VT_CSS = `
::view-transition-new(.paged-slide-from-end){animation:200ms cubic-bezier(.2,.6,.2,1) both paged-slide-in-end}
::view-transition-new(.paged-slide-from-start){animation:200ms cubic-bezier(.2,.6,.2,1) both paged-slide-in-start}
::view-transition-old(.paged-slide-to-start){animation:120ms ease-in both paged-slide-out-start}
::view-transition-old(.paged-slide-to-end){animation:120ms ease-in both paged-slide-out-end}
@keyframes paged-slide-in-end{from{opacity:0;transform:translateX(24px)}}
@keyframes paged-slide-in-start{from{opacity:0;transform:translateX(-24px)}}
@keyframes paged-slide-out-start{to{opacity:0;transform:translateX(-24px)}}
@keyframes paged-slide-out-end{to{opacity:0;transform:translateX(24px)}}
@media (prefers-reduced-motion: reduce){::view-transition-old(.paged-slide-to-start),::view-transition-old(.paged-slide-to-end),::view-transition-new(.paged-slide-from-end),::view-transition-new(.paged-slide-from-start){animation:none!important}}
`;
const ENTER = {
  [NEXT]: "paged-slide-from-end",
  [PREV]: "paged-slide-from-start",
  default: "none",
};
const EXIT = {
  [NEXT]: "paged-slide-to-start",
  [PREV]: "paged-slide-to-end",
  default: "none",
};

export function makeNotesPanel(
  host: BundleHost,
  store: SlidesStore,
): React.ComponentType<PanelProps> {
  const Component: React.FC<PanelProps> = () => {
    // The store as a render value (react-live, editor ADR 229): a new view
    // after every change, so what is read from it is read again.
    const { t } = useStrings();
    const slides = useLive(store, subscribeOf);
    const list = slides.list();
    // The slide shown follows the active one through a transition (a
    // store change is a synchronous update, which never animates), typed
    // with the direction it moved in.
    const [shown, setShown] = React.useState(() => store.activePage());
    const follow = React.useEffectEvent(() => {
      const next = store.activePage();
      if (next === shown) return;
      const order = store.list().map((s) => s.pageId);
      const from = order.indexOf(shown ?? "");
      const to = order.indexOf(next ?? "");
      React.startTransition(() => {
        if (from >= 0 && to >= 0)
          React.addTransitionType(to < from ? PREV : NEXT);
        setShown(next);
      });
    });
    // A hidden dock tab sits in a hidden <Activity> (editor ADR 240), whose
    // effects are unmounted: the slide changed while the panel was hidden
    // is caught up when it subscribes again, not only on the next change.
    React.useEffect(() => {
      follow();
      return store.subscribe(() => follow());
    }, []);
    const slide = list.find((s) => s.pageId === shown) ?? slides.activeSlide();
    const at = slide ? list.indexOf(slide) : -1;
    const step = (delta: -1 | 1) => {
      const target = list[at + delta];
      if (target) void host.viewport.goToPage(target.pageId);
    };
    const saved = slide?.state.notes ?? "";
    const [draft, setDraft] = React.useState(saved);
    // Another slide, or the notes changed underneath (undo): show them.
    React.useEffect(() => setDraft(saved), [slide?.pageId, saved]);

    if (!slide) {
      return (
        <div
          style={{ padding: 12, fontSize: 13, opacity: 0.7 }}
          data-notes-panel="empty"
        >
          {t(NOTES.empty)}
        </div>
      );
    }
    const commit = () => {
      if (draft === saved) return;
      void host.document
        .mutate(
          setStateMutation(slide.pageId, { ...slide.state, notes: draft }),
        )
        .catch((e) => host.log.warn(`paged.slide: ${String(e)}`));
    };
    return (
      <div
        style={{
          padding: 10,
          display: "flex",
          flexDirection: "column",
          gap: 6,
          height: "100%",
        }}
        data-notes-panel="ready"
      >
        <style href="paged-slide-notes-transitions" precedence="default">
          {NOTES_VT_CSS}
        </style>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            fontSize: 11,
          }}
        >
          <span style={{ flex: 1, opacity: 0.7 }}>
            {t(NOTES.heading, { number: slide.number })}
          </span>
          <button
            type="button"
            data-notes-prev
            disabled={at <= 0}
            onClick={() => step(-1)}
            title={t(NOTES.previous)}
            aria-label={t(NOTES.previous)}
          >
            ‹
          </button>
          <button
            type="button"
            data-notes-next
            disabled={at < 0 || at >= list.length - 1}
            onClick={() => step(1)}
            title={t(NOTES.next)}
            aria-label={t(NOTES.next)}
          >
            ›
          </button>
        </div>
        <React.ViewTransition
          key={slide.pageId}
          enter={ENTER}
          exit={EXIT}
          update="none"
        >
          <textarea
            data-notes-text
            value={draft}
            placeholder={t(NOTES.placeholder)}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            style={{
              flex: 1,
              minHeight: 80,
              resize: "vertical",
              font: "inherit",
              fontSize: 13,
            }}
          />
        </React.ViewTransition>
      </div>
    );
  };
  return Component;
}
