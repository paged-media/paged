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

// The Slides panel: the deck's slides in order as thumbnails. Click goes to
// a slide, dragging reorders (movePage), and each slide can be duplicated,
// deleted (its buttons, or Delete on the focused thumbnail) or hidden from
// the slideshow. Every action is one engine
// mutation, so one undo step. Display glue only: what a slide is comes
// from SlidesStore.

import type { BundleHost, PanelProps } from "@paged-media/plugin-api";
import { subscribeOf, useLive, useNearViewport } from "@paged-media/react-live";
import { useStrings } from "@paged-media/strings";
import * as React from "react";

import {
  deleteMutation,
  duplicateMutation,
  layouts,
  moveMutation,
  newSlide,
  setStateMutation,
  type Layout,
  type Slide,
  type SlidesStore,
} from "../slides-model.js";
import { color } from "@paged-media/panel-kit";

import { SLIDES } from "../messages.js";

const list: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 10,
  padding: 10,
};
const tools: React.CSSProperties = { display: "flex", gap: 4, marginTop: 4 };
const small: React.CSSProperties = { fontSize: 11, padding: "1px 6px" };

export function makeSlidesPanel(
  host: BundleHost,
  store: SlidesStore,
): React.ComponentType<PanelProps> {
  const mutate = (m: Parameters<BundleHost["document"]["mutate"]>[0]) =>
    void host.document
      .mutate(m)
      .catch((e) => host.log.warn(`paged.slide: ${String(e)}`));

  const Thumb: React.FC<{ slide: Slide; near: boolean }> = ({
    slide,
    near,
  }) => {
    // Its own view of the store: a thumbnail landing re-renders this
    // thumbnail, not the list (react-live, editor ADR 229). Asked for only
    // once the slide comes near the panel's view: a long deck renders the
    // slides a user scrolls to, not all of them at once (editor ADR 240).
    const thumbs = useLive(store, subscribeOf);
    const url = near ? thumbs.thumbnail(slide.pageId) : null;
    const [w, h] = slide.sizePt;
    return (
      <div
        style={{
          aspectRatio: w > 0 && h > 0 ? `${w} / ${h}` : "16 / 9",
          background: color.muted,
          borderRadius: 2,
          overflow: "hidden",
          opacity: slide.state.hidden ? 0.4 : 1,
        }}
      >
        {url && (
          <img
            src={url}
            alt=""
            draggable={false}
            style={{ width: "100%", height: "100%", display: "block" }}
          />
        )}
      </div>
    );
  };

  /** New slide: a layout picker and the button, above the list. */
  const NewSlide: React.FC<{ slides: readonly Slide[] }> = ({ slides }) => {
    const { t } = useStrings();
    const [options, setOptions] = React.useState<Layout[]>([]);
    const [chosen, setChosen] = React.useState<string>("");
    const [busy, setBusy] = React.useState(false);
    const key = slides
      .map((s) => `${s.pageId}:${s.state.layout ?? ""}`)
      .join(",");
    React.useEffect(() => {
      let live = true;
      void layouts(host, slides).then((ls) => {
        if (!live) return;
        setOptions(ls);
        setChosen((c) =>
          ls.some((l) => l.masterId === c) ? c : (ls[0]?.masterId ?? ""),
        );
      });
      return () => {
        live = false;
      };
    }, [key]);
    if (options.length === 0) return null;
    const layout = options.find((l) => l.masterId === chosen) ?? options[0];
    return (
      <div
        style={{ display: "flex", gap: 6, alignItems: "center" }}
        data-new-slide
      >
        <select
          aria-label={t(SLIDES.layout)}
          value={layout.masterId}
          onChange={(e) => setChosen(e.target.value)}
          style={{ flex: 1, minWidth: 0 }}
        >
          {options.map((l) => (
            <option key={l.masterId} value={l.masterId}>
              {l.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void newSlide(host, layout, store.activePage())
              .then((id) => (id ? host.viewport.goToPage(id) : false))
              .catch((e) => host.log.warn(`paged.slide: ${String(e)}`))
              .finally(() => setBusy(false));
          }}
        >
          {t(SLIDES.newSlide)}
        </button>
      </div>
    );
  };

  const Component: React.FC<PanelProps> = () => {
    // The store as a render value (react-live, editor ADR 229): a new view
    // after every change, so the list and the active slide are read again.
    const { t } = useStrings();
    const live = useLive(store, subscribeOf);
    const { observe: observeNear, has: isNear } = useNearViewport();
    const [dragging, setDragging] = React.useState<string | null>(null);
    const [over, setOver] = React.useState<number | null>(null);
    const slides = live.list();
    const active = live.activePage();
    const order = slides.map((s) => s.pageId);

    if (slides.length === 0) {
      return (
        <div
          style={{ padding: 12, fontSize: 13, opacity: 0.7 }}
          data-slides-panel="empty"
        >
          {t(SLIDES.empty)}
        </div>
      );
    }

    return (
      <div style={list} data-slides-panel="ready">
        <NewSlide slides={slides} />
        <React.Fragment ref={observeNear}>
          {slides.map((slide, i) => (
            <div
              key={slide.pageId}
              data-near={slide.pageId}
              data-slide={slide.pageId}
              data-active={slide.pageId === active || undefined}
              draggable
              onDragStart={(e) => {
                setDragging(slide.pageId);
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(e) => {
                if (dragging) {
                  e.preventDefault();
                  setOver(i);
                }
              }}
              onDragEnd={() => {
                setDragging(null);
                setOver(null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragging) {
                  const m = moveMutation(order, dragging, i);
                  if (m) mutate(m);
                }
                setDragging(null);
                setOver(null);
              }}
              style={{
                display: "flex",
                gap: 8,
                alignItems: "flex-start",
                borderTop:
                  over === i && dragging
                    ? "2px solid var(--overlay-selection, #e0218a)"
                    : "2px solid transparent",
              }}
            >
              <div
                style={{
                  width: 18,
                  fontSize: 11,
                  opacity: 0.7,
                  textAlign: "right",
                  paddingTop: 2,
                }}
              >
                {slide.number}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <button
                  type="button"
                  title={t(SLIDES.goTo, { number: slide.number })}
                  data-slide-thumb={slide.pageId}
                  onClick={() => void host.viewport.goToPage(slide.pageId)}
                  // Delete or Backspace on the focused thumbnail deletes
                  // its slide, as in PowerPoint's thumbnail pane; the
                  // canvas's Delete (the selected object) never sees it.
                  onKeyDown={(e) => {
                    if (e.key !== "Delete" && e.key !== "Backspace") return;
                    if (e.metaKey || e.ctrlKey || e.altKey) return;
                    e.preventDefault();
                    e.stopPropagation();
                    if (slides.length < 2) return;
                    const next = slides[i + 1] ?? slides[i - 1];
                    mutate(deleteMutation(slide.pageId));
                    if (next) void host.viewport.goToPage(next.pageId);
                  }}
                  style={{
                    display: "block",
                    width: "100%",
                    padding: 0,
                    border:
                      slide.pageId === active
                        ? "2px solid var(--overlay-selection, #e0218a)"
                        : "2px solid transparent",
                    background: "none",
                    cursor: "pointer",
                  }}
                >
                  <Thumb slide={slide} near={isNear(slide.pageId, i)} />
                </button>
                <div style={tools}>
                  <button
                    type="button"
                    style={small}
                    title={t(SLIDES.duplicateTitle)}
                    onClick={() => mutate(duplicateMutation(slide.pageId))}
                  >
                    {t(SLIDES.duplicate)}
                  </button>
                  <button
                    type="button"
                    style={small}
                    title={t(SLIDES.deleteTitle)}
                    disabled={slides.length < 2}
                    onClick={() => mutate(deleteMutation(slide.pageId))}
                  >
                    {t(SLIDES.delete)}
                  </button>
                  <button
                    type="button"
                    style={small}
                    aria-pressed={!!slide.state.hidden}
                    title={t(slide.state.hidden ? SLIDES.show : SLIDES.hide)}
                    onClick={() =>
                      mutate(
                        setStateMutation(slide.pageId, {
                          ...slide.state,
                          hidden: !slide.state.hidden,
                        }),
                      )
                    }
                  >
                    {t(
                      slide.state.hidden
                        ? SLIDES.unhideButton
                        : SLIDES.hideButton,
                    )}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </React.Fragment>
      </div>
    );
  };
  return Component;
}
