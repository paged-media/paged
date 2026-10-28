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

// View ▸ Slide Sorter (slide ADR 716): the deck's slides as a grid of
// thumbnails in place of the canvas (a module view, extensions ADR 345).
// Click selects, Shift+click selects a run, Cmd/Ctrl+click adds or
// removes one; dragging moves the selection; the bar hides or shows the
// selected slides and sets their transition, each one undo step; a
// double-click opens the slide in the normal view. Sections (slide ADR
// 720) head their slides: add one at the selection, rename it in place,
// move it with its slides, remove it (its slides join the one before).

import type {
  BundleHost,
  MutationInput,
  ViewProps,
} from "@paged-media/plugin-api";
import { subscribeOf, useLive } from "@paged-media/react-live";
import { useStrings } from "@paged-media/strings";
import * as React from "react";

import { color } from "@paged-media/panel-kit";

import { OUTPUT, SHOW } from "../messages.js";
import {
  addSectionMutation,
  moveSectionMutation,
  removeSectionMutation,
  renameSectionMutation,
  sectionsOf,
  type Section,
} from "../sections.js";
import {
  setStateMutation,
  type Slide,
  type SlideState,
  type SlidesStore,
} from "../slides-model.js";

/** The transitions the bar offers (PowerPoint's names). */
export const SORTER_TRANSITIONS = [
  "fade",
  "push",
  "wipe",
  "split",
  "reveal",
  "cover",
  "uncover",
  "cut",
  "randomBar",
  "shape",
  "flash",
] as const;

/** The selection after a click on `pageId` (`order` the deck's pages). */
export function nextSelection(
  order: readonly string[],
  selected: readonly string[],
  anchor: string | null,
  pageId: string,
  mods: { shift: boolean; toggle: boolean },
): string[] {
  if (mods.toggle) {
    return selected.includes(pageId)
      ? selected.filter((p) => p !== pageId)
      : order.filter((p) => p === pageId || selected.includes(p));
  }
  if (mods.shift && anchor && order.includes(anchor)) {
    const a = order.indexOf(anchor);
    const b = order.indexOf(pageId);
    const [lo, hi] = a < b ? [a, b] : [b, a];
    return order.slice(lo, hi + 1);
  }
  return [pageId];
}

/** Move `moving` (in deck order) so they land together before the slide
 *  at `to` of `order` (`to === order.length`: last), as one batch. */
export function moveManyMutation(
  order: readonly string[],
  moving: readonly string[],
  to: number,
): MutationInput | null {
  const set = new Set(moving);
  const block = order.filter((p) => set.has(p));
  if (block.length === 0) return null;
  const before = order.slice(0, Math.max(0, Math.min(to, order.length)));
  const anchor = [...before].reverse().find((p) => !set.has(p)) ?? null;
  const rest = order.filter((p) => !set.has(p));
  const at = anchor === null ? 0 : rest.indexOf(anchor) + 1;
  const target = [...rest.slice(0, at), ...block, ...rest.slice(at)];
  if (target.every((p, i) => p === order[i])) return null;
  const ops: MutationInput[] = block.map((page, i) => ({
    op: "movePage",
    args: { page, after: i === 0 ? anchor : block[i - 1] },
  }));
  return { op: "batch", args: { ops } } as MutationInput;
}

/** A slide's state with `kind` as its transition (null: none). A changed
 *  kind drops the deck's own element, which no longer describes it. */
export function withTransition(
  state: SlideState,
  kind: string | null,
): SlideState {
  const prev = state.transition ?? {};
  const { xml: _xml, kind: _kind, dir: _dir, ...keep } = prev;
  if (kind === null) {
    const advance =
      keep.advanceAfterMs !== undefined || keep.advanceOnClick !== undefined;
    return {
      ...state,
      transition: advance
        ? {
            advanceOnClick: keep.advanceOnClick,
            advanceAfterMs: keep.advanceAfterMs,
          }
        : undefined,
    };
  }
  if (prev.kind === kind) return state;
  return { ...state, transition: { ...keep, kind } };
}

const bar: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "8px 12px",
  borderBottom: `1px solid ${color.border}`,
  position: "sticky",
  top: 0,
  background: "var(--pg-bg, #fff)",
  zIndex: 1,
};

export function makeSlideSorter(
  host: BundleHost,
  store: SlidesStore,
): React.ComponentType<ViewProps> {
  const mutate = (m: MutationInput | null) => {
    if (!m) return;
    void host.document
      .mutate(m)
      .catch((e) => host.log.warn(`paged.slide sorter: ${String(e)}`));
  };
  const batch = (ops: MutationInput[]) =>
    mutate(
      ops.length === 0
        ? null
        : ops.length === 1
          ? ops[0]
          : ({ op: "batch", args: { ops } } as MutationInput),
    );

  const Thumb: React.FC<{ slide: Slide }> = ({ slide }) => {
    const thumbs = useLive(store, subscribeOf);
    const url = thumbs.thumbnail(slide.pageId);
    const [w, h] = slide.sizePt;
    return (
      <div
        style={{
          aspectRatio: w > 0 && h > 0 ? `${w} / ${h}` : "16 / 9",
          background: color.muted,
          opacity: slide.state.hidden ? 0.45 : 1,
          overflow: "hidden",
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

  const SectionHeader: React.FC<{
    section: Section;
    slides: readonly Slide[];
    first: boolean;
    last: boolean;
  }> = ({ section: sec, slides, first, last }) => {
    const { t } = useStrings();
    return (
      <div
        data-sorter-section={sec.name}
        data-section-id={sec.id}
        style={{
          gridColumn: "1 / -1",
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontSize: 12,
          borderBottom: `1px solid ${color.border}`,
          paddingBottom: 4,
        }}
      >
        <input
          key={`${sec.id}:${sec.name}`}
          aria-label={t(OUTPUT.renameSection)}
          data-section-name
          defaultValue={sec.name}
          style={{ fontWeight: 600, border: "none", background: "transparent" }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          onBlur={(e) => {
            const name = e.target.value.trim();
            if (name) mutate(renameSectionMutation(slides, sec.id, name));
          }}
        />
        <span style={{ opacity: 0.6 }}>
          {t(OUTPUT.sectionSlides, { count: sec.pageIds.length })}
        </span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          data-section-up
          title={t(OUTPUT.sectionUp)}
          disabled={first}
          onClick={() => mutate(moveSectionMutation(slides, sec.id, -1))}
        >
          ↑
        </button>
        <button
          type="button"
          data-section-down
          title={t(OUTPUT.sectionDown)}
          disabled={last}
          onClick={() => mutate(moveSectionMutation(slides, sec.id, 1))}
        >
          ↓
        </button>
        <button
          type="button"
          data-section-remove
          title={t(OUTPUT.removeSection)}
          onClick={() => mutate(removeSectionMutation(slides, sec.id))}
        >
          ×
        </button>
      </div>
    );
  };

  const Sorter: React.FC<ViewProps> = ({ close }) => {
    const { t } = useStrings();
    const live = useLive(store, subscribeOf);
    const slides = live.list();
    const order = slides.map((s) => s.pageId);
    const [selected, setSelected] = React.useState<readonly string[]>([]);
    const [anchor, setAnchor] = React.useState<string | null>(null);
    const [dragging, setDragging] = React.useState(false);
    const [over, setOver] = React.useState<number | null>(null);
    const chosen = slides.filter((s) => selected.includes(s.pageId));
    const allHidden = chosen.length > 0 && chosen.every((s) => s.state.hidden);
    const kinds = new Set(chosen.map((s) => s.state.transition?.kind ?? ""));
    const kind = kinds.size === 1 ? [...kinds][0] : "";
    const sections = sectionsOf(slides);
    const startsAt = new Map(sections.map((sec, k) => [sec.start, k]));

    if (slides.length === 0) {
      return (
        <div data-slide-sorter="empty" style={{ padding: 24, opacity: 0.7 }}>
          {t(SHOW.sorterEmpty)}
        </div>
      );
    }

    const open = (pageId: string) => {
      void host.viewport.goToPage(pageId);
      close();
    };

    return (
      <div data-slide-sorter="ready" style={{ minHeight: "100%" }}>
        <div style={bar} role="toolbar" aria-label={t(SHOW.slideSorter)}>
          <button type="button" data-sorter="normal" onClick={close}>
            {t(SHOW.normalView)}
          </button>
          <span style={{ flex: 1, fontSize: 12, opacity: 0.7 }}>
            {chosen.length > 0
              ? t(SHOW.selected, { count: chosen.length })
              : ""}
          </span>
          <button
            type="button"
            data-sorter="add-section"
            onClick={() =>
              mutate(
                addSectionMutation(
                  slides,
                  chosen[0]?.pageId ?? slides[0]!.pageId,
                  t(OUTPUT.untitledSection),
                ),
              )
            }
          >
            {t(OUTPUT.addSection)}
          </button>
          <button
            type="button"
            data-sorter="hide"
            disabled={chosen.length === 0}
            aria-pressed={allHidden}
            onClick={() =>
              batch(
                chosen.map((s) =>
                  setStateMutation(s.pageId, {
                    ...s.state,
                    hidden: !allHidden,
                  }),
                ),
              )
            }
          >
            {t(allHidden ? SHOW.unhide : SHOW.hide)}
          </button>
          <label style={{ fontSize: 12 }}>
            {t(SHOW.transition)}{" "}
            <select
              data-sorter="transition"
              disabled={chosen.length === 0}
              value={kind}
              onChange={(e) => {
                const k = e.target.value || null;
                batch(
                  chosen
                    .map((s) => ({ s, next: withTransition(s.state, k) }))
                    .filter(({ s, next }) => next !== s.state)
                    .map(({ s, next }) => setStateMutation(s.pageId, next)),
                );
              }}
            >
              <option value="">{t(SHOW.noTransition)}</option>
              {SORTER_TRANSITIONS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div
          role="listbox"
          aria-multiselectable="true"
          aria-label={t(SHOW.slideSorter)}
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
            gap: 20,
            padding: 20,
          }}
        >
          {slides.map((slide, i) => {
            const isSelected = selected.includes(slide.pageId);
            const k = startsAt.get(i);
            return (
              <React.Fragment key={slide.pageId}>
                {k !== undefined && (
                  <SectionHeader
                    section={sections[k]!}
                    slides={slides}
                    first={k === 0}
                    last={k === sections.length - 1}
                  />
                )}
                <div
                  role="option"
                  aria-selected={isSelected}
                  data-sorter-slide={slide.pageId}
                  data-number={slide.number}
                  draggable
                  onClick={(e) => {
                    setSelected(
                      nextSelection(order, selected, anchor, slide.pageId, {
                        shift: e.shiftKey,
                        toggle: e.metaKey || e.ctrlKey,
                      }),
                    );
                    if (!e.shiftKey) setAnchor(slide.pageId);
                  }}
                  onDoubleClick={() => open(slide.pageId)}
                  onDragStart={(e) => {
                    if (!isSelected) {
                      setSelected([slide.pageId]);
                      setAnchor(slide.pageId);
                    }
                    setDragging(true);
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  onDragOver={(e) => {
                    if (!dragging) return;
                    e.preventDefault();
                    setOver(i);
                  }}
                  onDragEnd={() => {
                    setDragging(false);
                    setOver(null);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    const moving =
                      selected.length > 0 ? selected : [slide.pageId];
                    mutate(moveManyMutation(order, moving, i));
                    setDragging(false);
                    setOver(null);
                  }}
                  style={{
                    cursor: "pointer",
                    outline: isSelected
                      ? "3px solid var(--overlay-selection, #e0218a)"
                      : `1px solid ${color.border}`,
                    borderLeft:
                      over === i && dragging
                        ? "4px solid var(--overlay-selection, #e0218a)"
                        : "4px solid transparent",
                  }}
                >
                  <Thumb slide={slide} />
                  <div
                    style={{
                      display: "flex",
                      gap: 6,
                      fontSize: 12,
                      padding: "4px 2px",
                    }}
                  >
                    <span>{slide.number}</span>
                    {slide.state.hidden && (
                      <span data-sorter-hidden style={{ opacity: 0.7 }}>
                        {t(SHOW.hidden)}
                      </span>
                    )}
                    {slide.state.transition?.kind && (
                      <span
                        data-sorter-transition
                        title={slide.state.transition.kind}
                        style={{ marginLeft: "auto" }}
                      >
                        ★
                      </span>
                    )}
                  </div>
                </div>
              </React.Fragment>
            );
          })}
        </div>
      </div>
    );
  };
  return Sorter;
}
