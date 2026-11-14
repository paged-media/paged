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
//
// Slide ADR 725 — the sorter is a deck's navigation: a deck of several
// slides opens here (`show/sorter-on-open.ts`, with the bar's switch); the
// bar plays the show and shows the speaker notes; the slide shown on the
// canvas is marked; the arrow keys move through the slides (Shift
// extends), Home / End go to the ends, Enter opens the slide in Normal
// view, Delete removes the selection in one batch; a portrait deck gets
// narrower columns.

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
  deleteMutation,
  setStateMutation,
  type Slide,
  type SlideState,
  type SlidesStore,
} from "../slides-model.js";
import { setSorterOnOpen, sorterOnOpen } from "../show/sorter-on-open.js";

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

/** The ops of deleting `ids` from `slides` in one batch: each deletion as
 *  `deleteMutation` plans it against the deck as the earlier ones left it
 *  (a section a deleted slide starts moves to the next one kept). */
export function deleteManyOps(
  slides: readonly Slide[],
  ids: readonly string[],
): MutationInput[] {
  let left = slides.slice();
  const ops: MutationInput[] = [];
  for (const id of ids) {
    if (left.length < 2) break;
    ops.push(deleteMutation(id, left));
    const i = left.findIndex((s) => s.pageId === id);
    const next = left[i + 1];
    left = left
      .filter((s) => s.pageId !== id)
      .map((s) =>
        next &&
        s.pageId === next.pageId &&
        !s.state.section &&
        left[i]?.state.section
          ? { ...s, state: { ...s.state, section: left[i]!.state.section } }
          : s,
      );
  }
  return ops;
}

/** What the sorter needs beyond the host and the store. */
export interface SorterDeps {
  /** Play the show from `pageId`, or from the beginning (null). */
  play?: (pageId: string | null) => void;
}

export function makeSlideSorter(
  host: BundleHost,
  store: SlidesStore,
  deps: SorterDeps = {},
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

  const subscribeActive = (listener: () => void) => {
    try {
      const sub = host.viewport.onDidChangeActivePage(() => listener());
      return () => sub.dispose();
    } catch {
      return () => {};
    }
  };
  const readActive = (): string | null => {
    try {
      return host.viewport.activePage();
    } catch {
      return null;
    }
  };

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
    const [showNotes, setShowNotes] = React.useState(false);
    const [openOnLoad, setOpenOnLoad] = React.useState(() =>
      sorterOnOpen(host),
    );
    const current = React.useSyncExternalStore(
      subscribeActive,
      readActive,
      readActive,
    );
    const listRef = React.useRef<HTMLDivElement | null>(null);
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

    // The keys of the grid (slide ADR 725).
    const focusIndex = Math.max(
      0,
      order.indexOf(anchor ?? selected[selected.length - 1] ?? current ?? ""),
    );
    const moveTo = (index: number, extend: boolean) => {
      const i = Math.max(0, Math.min(order.length - 1, index));
      const id = order[i]!;
      setSelected(
        nextSelection(order, selected, anchor, id, {
          shift: extend,
          toggle: false,
        }),
      );
      if (!extend) setAnchor(id);
      listRef.current
        ?.querySelector<HTMLElement>(`[data-sorter-slide="${id}"]`)
        ?.scrollIntoView?.({ block: "nearest" });
    };
    const onKeyDown = (e: React.KeyboardEvent) => {
      const step =
        e.key === "ArrowRight" || e.key === "ArrowDown"
          ? 1
          : e.key === "ArrowLeft" || e.key === "ArrowUp"
            ? -1
            : 0;
      if (step !== 0) {
        e.preventDefault();
        const from =
          selected.length === 0
            ? focusIndex - step
            : order.indexOf(
                selected[selected.length - 1] === anchor && selected.length > 1
                  ? selected[0]!
                  : selected[selected.length - 1]!,
              );
        moveTo((from < 0 ? focusIndex : from) + step, e.shiftKey);
        return;
      }
      if (e.key === "Home" || e.key === "End") {
        e.preventDefault();
        moveTo(e.key === "Home" ? 0 : order.length - 1, e.shiftKey);
        return;
      }
      if (e.key === "Enter") {
        const id = selected[selected.length - 1] ?? order[focusIndex];
        if (id) {
          e.preventDefault();
          open(id);
        }
        return;
      }
      if (
        (e.key === "Delete" || e.key === "Backspace") &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        chosen.length > 0
      ) {
        e.preventDefault();
        batch(
          deleteManyOps(
            slides,
            chosen.map((s) => s.pageId),
          ),
        );
        setSelected([]);
      }
    };
    const portrait = slides.some((s) => s.sizePt[1] > s.sizePt[0]);

    return (
      <div data-slide-sorter="ready" style={{ minHeight: "100%" }}>
        <div style={bar} role="toolbar" aria-label={t(SHOW.slideSorter)}>
          <button type="button" data-sorter="normal" onClick={close}>
            {t(SHOW.normalView)}
          </button>
          {deps.play ? (
            <button
              type="button"
              data-sorter="play"
              title={t(SHOW.sorterPlayTitle)}
              onClick={() => deps.play?.(chosen[0]?.pageId ?? null)}
            >
              {t(SHOW.sorterPlay)}
            </button>
          ) : null}
          <label style={{ fontSize: 12 }}>
            <input
              type="checkbox"
              data-sorter="notes"
              checked={showNotes}
              onChange={(e) => setShowNotes(e.target.checked)}
            />{" "}
            {t(SHOW.sorterNotes)}
          </label>
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
          <label style={{ fontSize: 12 }} title={t(SHOW.sorterOpenOnLoadTitle)}>
            <input
              type="checkbox"
              data-sorter-open-on-load
              checked={openOnLoad}
              onChange={(e) => {
                setSorterOnOpen(host, e.target.checked);
                setOpenOnLoad(e.target.checked);
              }}
            />{" "}
            {t(SHOW.sorterOpenOnLoad)}
          </label>
        </div>
        <div
          ref={listRef}
          role="listbox"
          tabIndex={0}
          aria-multiselectable="true"
          aria-label={t(SHOW.slideSorter)}
          onKeyDown={onKeyDown}
          style={{
            display: "grid",
            gridTemplateColumns: `repeat(auto-fill, minmax(${portrait ? 140 : 200}px, 1fr))`,
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
                  data-current={slide.pageId === current ? "true" : undefined}
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
                      : slide.pageId === current
                        ? "2px solid var(--pg-primary, #6d28d9)"
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
                  {showNotes && slide.state.notes ? (
                    <div
                      data-sorter-notes
                      style={{
                        fontSize: 11,
                        opacity: 0.8,
                        padding: "0 2px 4px",
                        whiteSpace: "pre-wrap",
                        maxHeight: 64,
                        overflow: "hidden",
                      }}
                    >
                      {slide.state.notes}
                    </div>
                  ) : null}
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
