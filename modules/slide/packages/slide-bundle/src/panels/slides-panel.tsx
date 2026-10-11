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
// deleted or hidden from the slideshow. Every action is one engine
// mutation, so one undo step. Display glue only: what a slide is comes
// from SlidesStore.

import type { BundleHost, PanelProps } from "@paged-media/plugin-api";
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

const list: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 10, padding: 10 };
const tools: React.CSSProperties = { display: "flex", gap: 4, marginTop: 4 };
const small: React.CSSProperties = { fontSize: 11, padding: "1px 6px" };

export function makeSlidesPanel(
  host: BundleHost,
  store: SlidesStore,
): React.ComponentType<PanelProps> {
  const mutate = (m: Parameters<BundleHost["document"]["mutate"]>[0]) =>
    void host.document.mutate(m).catch((e) => host.log.warn(`paged.slide: ${String(e)}`));

  const Thumb: React.FC<{ slide: Slide }> = ({ slide }) => {
    const url = store.thumbnail(slide.pageId);
    const [w, h] = slide.sizePt;
    return (
      <div
        style={{
          aspectRatio: w > 0 && h > 0 ? `${w} / ${h}` : "16 / 9",
          background: "var(--chrome-surface-2, #2a2a2a)",
          borderRadius: 2,
          overflow: "hidden",
          opacity: slide.state.hidden ? 0.4 : 1,
        }}
      >
        {url && <img src={url} alt="" draggable={false} style={{ width: "100%", height: "100%", display: "block" }} />}
      </div>
    );
  };

  /** New slide: a layout picker and the button, above the list. */
  const NewSlide: React.FC<{ slides: readonly Slide[] }> = ({ slides }) => {
    const [options, setOptions] = React.useState<Layout[]>([]);
    const [chosen, setChosen] = React.useState<string>("");
    const [busy, setBusy] = React.useState(false);
    const key = slides.map((s) => `${s.pageId}:${s.state.layout ?? ""}`).join(",");
    React.useEffect(() => {
      let live = true;
      void layouts(host, slides).then((ls) => {
        if (!live) return;
        setOptions(ls);
        setChosen((c) => (ls.some((l) => l.masterId === c) ? c : (ls[0]?.masterId ?? "")));
      });
      return () => {
        live = false;
      };
    }, [key]);
    if (options.length === 0) return null;
    const layout = options.find((l) => l.masterId === chosen) ?? options[0];
    return (
      <div style={{ display: "flex", gap: 6, alignItems: "center" }} data-new-slide>
        <select
          aria-label="Layout"
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
          New slide
        </button>
      </div>
    );
  };

  const Component: React.FC<PanelProps> = () => {
    const [, force] = React.useReducer((n: number) => n + 1, 0);
    React.useEffect(() => store.subscribe(force), []);
    const [dragging, setDragging] = React.useState<string | null>(null);
    const [over, setOver] = React.useState<number | null>(null);
    const slides = store.list();
    const active = store.activePage();
    const order = slides.map((s) => s.pageId);

    if (slides.length === 0) {
      return (
        <div style={{ padding: 12, fontSize: 13, opacity: 0.7 }} data-slides-panel="empty">
          No slides. Open a PowerPoint deck with File ▸ Open.
        </div>
      );
    }

    return (
      <div style={list} data-slides-panel="ready">
        <NewSlide slides={slides} />
        {slides.map((slide, i) => (
          <div
            key={slide.pageId}
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
              borderTop: over === i && dragging ? "2px solid var(--overlay-selection, #e0218a)" : "2px solid transparent",
            }}
          >
            <div style={{ width: 18, fontSize: 11, opacity: 0.7, textAlign: "right", paddingTop: 2 }}>
              {slide.number}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <button
                type="button"
                title={`Go to slide ${slide.number}`}
                onClick={() => void host.viewport.goToPage(slide.pageId)}
                style={{
                  display: "block",
                  width: "100%",
                  padding: 0,
                  border: slide.pageId === active ? "2px solid var(--overlay-selection, #e0218a)" : "2px solid transparent",
                  background: "none",
                  cursor: "pointer",
                }}
              >
                <Thumb slide={slide} />
              </button>
              <div style={tools}>
                <button type="button" style={small} title="Duplicate slide" onClick={() => mutate(duplicateMutation(slide.pageId))}>
                  Duplicate
                </button>
                <button
                  type="button"
                  style={small}
                  title="Delete slide"
                  disabled={slides.length < 2}
                  onClick={() => mutate(deleteMutation(slide.pageId))}
                >
                  Delete
                </button>
                <button
                  type="button"
                  style={small}
                  aria-pressed={!!slide.state.hidden}
                  title={slide.state.hidden ? "Show in slideshow" : "Hide from slideshow"}
                  onClick={() => mutate(setStateMutation(slide.pageId, { ...slide.state, hidden: !slide.state.hidden }))}
                >
                  {slide.state.hidden ? "Unhide" : "Hide"}
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  };
  return Component;
}
