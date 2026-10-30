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

// The Animations pane (slide ADR 714), in the right dock: PowerPoint's
// Animations tab and Animation Pane in one.
//
// - Add effect: every preset by class (Entrance, Emphasis, Exit, Motion
//   Paths), searchable; a click adds it to the selected shape (by
//   paragraph when asked and the shape has more than one).
// - The effect list, in play order: a number per click, the class's
//   colour, the effect and the shape, and a bar on a timeline (where it
//   runs in its click). Drag a bar to change its delay, its right edge to
//   change its duration; drag a row to reorder.
// - Effect options of the selected effect: direction, start (On Click /
//   With Previous / After Previous), duration, delay, repeat, rewind,
//   trigger (as part of the click sequence, or on click of a shape).
// - Preview on the canvas and the Animation Painter.
//
// Each change is one edit of the slide's timing through the engine and one
// undo step (authoring.ts).

import type {
  BundleHost,
  ElementId,
  PanelProps,
} from "@paged-media/plugin-api";
import { subscribeOf, useLive } from "@paged-media/react-live";
import { useStrings } from "@paged-media/strings";
import * as React from "react";

import { ANIM } from "../messages.js";
import type { SlidesStore } from "../slides-model.js";
import type { AnimationAuthoring } from "./authoring.js";
import type {
  EffectInfo,
  EffectList,
  EffectStart,
  GalleryPreset,
  TargetRef,
} from "./model.js";
import { idOf, type PageShapes } from "./shapes.js";

export const ANIMATIONS_PANEL_ID = "media.paged.slide.panel.animations";

const CLASSES = [
  ["entr", "entrance", "#2e9b4d"],
  ["emph", "emphasis", "#d6a400"],
  ["exit", "exit", "#c8402f"],
  ["path", "motion", "#2f6fd6"],
] as const;

export const classColour = (c: string): string =>
  CLASSES.find((x) => x[0] === c)?.[2] ?? "#888";

/** The pane's hooks into the rest of the bundle. */
export interface PaneDeps {
  authoring: AnimationAuthoring;
  /** Play the active slide's animations on the canvas. */
  preview(pageId: string): void;
  /** Arm the Animation Painter with the selected shape's effects. */
  painter(pageId: string, from: ElementId): void;
  /** Show the picked effect's motion path on the canvas (none: hide it). */
  motionPath?(pageId: string | null, effect: EffectInfo | null): void;
}

/** A shape's name for a list row: its key's id, else its item. */
export function shapeLabel(t: TargetRef, page?: PageShapes): string {
  const shape = page?.shapes.find(
    (s) =>
      (t.item && s.items.some((i) => idOf(i.id) === t.item)) ||
      (t.key && s.key === t.key),
  );
  if (shape?.key) return shape.key.split("#").pop() ?? shape.key;
  return t.spid || t.item || t.key || "?";
}

/** Where a bar sits on the timeline: its share of the longest click's
 *  span, left and width, 0..1. */
export function barGeometry(
  e: EffectInfo,
  all: readonly EffectInfo[],
): { left: number; width: number } {
  const span = Math.max(1, ...all.map((x) => x.endMs));
  return {
    left: Math.max(0, e.beginMs) / span,
    width: Math.max(0.01, (e.endMs - e.beginMs) / span),
  };
}

const sec = (ms: number) => Math.round(ms / 10) / 100;

export function makeAnimationsPanel(
  host: BundleHost,
  store: SlidesStore,
  deps: PaneDeps,
): React.ComponentType<PanelProps> {
  const Component: React.FC<PanelProps> = () => {
    const { t } = useStrings();
    const slides = useLive(store, subscribeOf);
    const slide = slides.activeSlide();
    const pageId = slide?.pageId ?? null;
    const timing = slide?.state.timing ?? null;
    const [list, setList] = React.useState<EffectList>({
      effects: [],
      clicks: 0,
    });
    const [gallery, setGallery] = React.useState<GalleryPreset[]>([]);
    const [page, setPage] = React.useState<PageShapes | undefined>(undefined);
    const [cls, setCls] = React.useState<string>("entr");
    const [query, setQuery] = React.useState("");
    const [byParagraph, setByParagraph] = React.useState(false);
    const [picked, setPicked] = React.useState<number | null>(null);
    const [selection, setSelection] = React.useState<ElementId[]>(() =>
      host.selection.get(),
    );
    const [error, setError] = React.useState<string | null>(null);

    React.useEffect(
      () => host.selection.onDidChange((ids) => setSelection(ids)).dispose,
      [],
    );
    React.useEffect(() => {
      let live = true;
      void deps.authoring.presets().then((g) => live && setGallery(g));
      return () => {
        live = false;
      };
    }, []);
    React.useEffect(() => {
      let live = true;
      if (!pageId) return;
      void deps.authoring
        .effects(pageId)
        .then((l) => live && setList(l))
        .catch(() => live && setList({ effects: [], clicks: 0 }));
      void deps.authoring.shapes(pageId).then((p) => live && setPage(p));
      return () => {
        live = false;
      };
    }, [pageId, timing]);

    const pickedEffect = picked !== null ? list.effects[picked] : undefined;
    React.useEffect(() => {
      deps.motionPath?.(pageId, pickedEffect ?? null);
    }, [pageId, pickedEffect]);
    React.useEffect(() => () => deps.motionPath?.(null, null), []);

    if (!slide || !pageId) {
      return (
        <div
          data-animations-panel="empty"
          style={{ padding: 12, fontSize: 13, opacity: 0.7 }}
        >
          {t(ANIM.empty)}
        </div>
      );
    }

    const run = async (p: Promise<{ ok: boolean; reason?: string }>) => {
      const out = await p;
      setError(out.ok ? null : (out.reason ?? null));
      return out.ok;
    };
    const target = selection[0] ?? null;
    const effect = picked !== null ? list.effects[picked] : undefined;
    const presets = gallery.filter(
      (g) =>
        g.class === cls &&
        (query === "" || g.name.toLowerCase().includes(query.toLowerCase())),
    );
    const setTiming = (patch: Record<string, unknown>) =>
      effect &&
      run(
        deps.authoring.edit(pageId, {
          kind: "timing",
          index: effect.index,
          ...patch,
        } as never),
      );

    return (
      <div
        data-animations-panel=""
        style={{ padding: 8, fontSize: 12, overflowY: "auto" }}
      >
        <div
          style={{
            display: "flex",
            gap: 6,
            alignItems: "center",
            marginBottom: 6,
          }}
        >
          <strong data-animations-heading="" style={{ flex: 1 }}>
            {t(ANIM.heading, {
              number: slide.number,
              count: list.effects.length,
            })}
          </strong>
          <button
            type="button"
            data-animations-preview=""
            disabled={list.effects.length === 0}
            onClick={() => deps.preview(pageId)}
          >
            {t(ANIM.preview)}
          </button>
          <button
            type="button"
            data-animations-painter=""
            title={t(ANIM.painter)}
            disabled={!target}
            onClick={() => target && deps.painter(pageId, target)}
          >
            {t(ANIM.painter)}
          </button>
        </div>

        <section data-animations-gallery="">
          <h3 style={{ fontSize: 11, margin: "6px 0", opacity: 0.7 }}>
            {t(ANIM.add)}
          </h3>
          <div
            role="tablist"
            style={{ display: "flex", gap: 2, marginBottom: 4 }}
          >
            {CLASSES.map(([c, label, colour]) => (
              <button
                key={c}
                type="button"
                role="tab"
                aria-selected={cls === c}
                data-animations-class={c}
                onClick={() => setCls(c)}
                style={{
                  borderBottom: `2px solid ${cls === c ? colour : "transparent"}`,
                  background: "transparent",
                  color: "inherit",
                  padding: "2px 6px",
                }}
              >
                {t(ANIM[label])}
              </button>
            ))}
          </div>
          <input
            type="search"
            data-animations-search=""
            placeholder={t(ANIM.search)}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ width: "100%", marginBottom: 4 }}
          />
          <label style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <input
              type="checkbox"
              data-animations-by-paragraph=""
              checked={byParagraph}
              onChange={(e) => setByParagraph(e.target.checked)}
            />
            {t(ANIM.byParagraph)}
          </label>
          {!target ? (
            <div
              data-animations-hint=""
              style={{ opacity: 0.7, margin: "4px 0" }}
            >
              {t(ANIM.selectShape)}
            </div>
          ) : null}
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 2,
              maxHeight: 160,
              overflowY: "auto",
            }}
          >
            {presets.map((g) => (
              <button
                key={`${g.class}:${g.presetId}`}
                type="button"
                data-animation-preset={`${g.class}:${g.presetId}`}
                disabled={!target}
                onClick={() =>
                  target &&
                  void run(
                    deps.authoring.add(pageId, target, {
                      presetClass: g.class,
                      presetId: g.presetId,
                      presetSubtype: g.defaultSubtype,
                      byParagraph,
                    }),
                  ).then((ok) => ok && setPicked(list.effects.length))
                }
                style={{
                  borderLeft: `3px solid ${classColour(g.class)}`,
                  padding: "2px 6px",
                  fontSize: 11,
                }}
              >
                {g.name}
              </button>
            ))}
          </div>
        </section>

        <section data-animations-list="" style={{ marginTop: 8 }}>
          <h3 style={{ fontSize: 11, margin: "6px 0", opacity: 0.7 }}>
            {t(ANIM.timeline)}
          </h3>
          {list.effects.length === 0 ? (
            <div data-animations-none="" style={{ opacity: 0.7 }}>
              {t(ANIM.none)}
            </div>
          ) : null}
          <ol style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {list.effects.map((e, i) => (
              <EffectRow
                key={i}
                effect={e}
                all={list.effects}
                label={shapeLabel(e.target, page)}
                selected={picked === i}
                onPick={() => setPicked(i)}
                onDrop={(from) =>
                  from !== i &&
                  void run(
                    deps.authoring.edit(pageId, { kind: "move", from, to: i }),
                  )
                }
                onRetime={(patch) =>
                  void run(
                    deps.authoring.edit(pageId, {
                      kind: "timing",
                      index: e.index,
                      ...patch,
                    }),
                  )
                }
              />
            ))}
          </ol>
        </section>

        {effect ? (
          <EffectOptions
            effect={effect}
            preset={gallery.find(
              (g) =>
                g.class === effect.presetClass &&
                g.presetId === effect.presetId,
            )}
            page={page}
            count={list.effects.length}
            onTiming={(patch) => void setTiming(patch)}
            onPathLock={(locked) =>
              void run(
                deps.authoring.edit(pageId, {
                  kind: "path",
                  index: effect.index,
                  locked,
                }),
              )
            }
            onOption={(presetSubtype) =>
              void run(
                deps.authoring.edit(pageId, {
                  kind: "option",
                  index: effect.index,
                  presetSubtype,
                }),
              )
            }
            onMove={(to) =>
              void run(
                deps.authoring.edit(pageId, {
                  kind: "move",
                  from: effect.index,
                  to,
                }),
              ).then((ok) => ok && setPicked(to))
            }
            onRemove={() =>
              void run(
                deps.authoring.edit(pageId, {
                  kind: "remove",
                  index: effect.index,
                }),
              ).then((ok) => ok && setPicked(null))
            }
          />
        ) : null}
        {error ? (
          <div
            data-animations-error=""
            role="alert"
            style={{ color: "#c8402f", marginTop: 6 }}
          >
            {error}
          </div>
        ) : null}
      </div>
    );
  };
  return Component;
}

/** One row of the Animation Pane: number, class, name, shape and its bar. */
function EffectRow(props: {
  effect: EffectInfo;
  all: readonly EffectInfo[];
  label: string;
  selected: boolean;
  onPick(): void;
  onDrop(from: number): void;
  onRetime(patch: { delayMs?: number; durationMs?: number }): void;
}) {
  const { t } = useStrings();
  const { effect: e } = props;
  const bar = barGeometry(e, props.all);
  const track = React.useRef<HTMLDivElement | null>(null);
  const span = Math.max(1, ...props.all.map((x) => x.endMs));
  /** Drag the bar (delay) or its right edge (duration). */
  const drag = (edge: boolean) => (ev: React.PointerEvent) => {
    ev.preventDefault();
    ev.stopPropagation();
    const width = track.current?.getBoundingClientRect().width || 1;
    const x0 = ev.clientX;
    const up = (u: PointerEvent) => {
      window.removeEventListener("pointerup", up);
      const dMs = ((u.clientX - x0) / width) * span;
      if (Math.abs(dMs) < 10) return;
      if (edge)
        props.onRetime({
          durationMs: Math.max(10, Math.round(e.durationMs + dMs)),
        });
      else
        props.onRetime({ delayMs: Math.max(0, Math.round(e.delayMs + dMs)) });
    };
    window.addEventListener("pointerup", up);
  };
  const first =
    props.all.findIndex((x) => x.clickGroup === e.clickGroup) === e.index;
  return (
    <li
      data-animation-row={e.index}
      data-animation-class={e.presetClass}
      aria-selected={props.selected}
      draggable
      onDragStart={(ev) =>
        ev.dataTransfer?.setData("text/plain", String(e.index))
      }
      onDragOver={(ev) => ev.preventDefault()}
      onDrop={(ev) => {
        ev.preventDefault();
        const from = Number(ev.dataTransfer?.getData("text/plain"));
        if (Number.isFinite(from)) props.onDrop(from);
      }}
      onClick={props.onPick}
      style={{
        display: "grid",
        gridTemplateColumns: "18px 1fr 90px",
        gap: 4,
        alignItems: "center",
        padding: "2px 2px",
        background: props.selected ? "rgba(47,111,214,.18)" : "transparent",
        cursor: "default",
      }}
    >
      <span
        data-animation-click={e.clickGroup}
        style={{ opacity: 0.7, textAlign: "right" }}
      >
        {first && e.start === "click" ? e.clickGroup : ""}
      </span>
      <span
        style={{
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        <span
          aria-hidden="true"
          style={{
            display: "inline-block",
            width: 8,
            height: 8,
            borderRadius: 2,
            background: classColour(e.presetClass),
            marginRight: 4,
          }}
        />
        {e.name} · {props.label}
        {e.paragraph !== null
          ? ` (${t(ANIM.paragraph, { n: e.paragraph + 1 })})`
          : ""}
        {e.trigger ? " ⚡" : ""}
      </span>
      <div
        ref={track}
        data-animation-track=""
        style={{
          position: "relative",
          height: 10,
          background: "rgba(128,128,128,.15)",
        }}
      >
        <div
          data-animation-bar=""
          onPointerDown={e.editable ? drag(false) : undefined}
          style={{
            position: "absolute",
            left: `${bar.left * 100}%`,
            width: `${bar.width * 100}%`,
            top: 1,
            bottom: 1,
            background: classColour(e.presetClass),
            opacity: 0.8,
          }}
        >
          <div
            data-animation-bar-end=""
            onPointerDown={e.editable ? drag(true) : undefined}
            style={{
              position: "absolute",
              right: -2,
              top: 0,
              bottom: 0,
              width: 5,
              cursor: "ew-resize",
            }}
          />
        </div>
      </div>
    </li>
  );
}

/** The selected effect's options. */
function EffectOptions(props: {
  effect: EffectInfo;
  preset: GalleryPreset | undefined;
  page: PageShapes | undefined;
  count: number;
  onTiming(patch: Record<string, unknown>): void;
  onPathLock(locked: boolean): void;
  onOption(subtype: number): void;
  onMove(to: number): void;
  onRemove(): void;
}) {
  const { t } = useStrings();
  const { effect: e } = props;
  const disabled = !e.editable;
  const row = (label: string, control: React.ReactNode) => (
    <label
      style={{
        display: "grid",
        gridTemplateColumns: "90px 1fr",
        gap: 4,
        alignItems: "center",
        margin: "2px 0",
      }}
    >
      <span>{label}</span>
      {control}
    </label>
  );
  const shapes = props.page?.shapes.filter((s) => s.key) ?? [];
  return (
    <section data-animation-options={e.index} style={{ marginTop: 8 }}>
      <h3 style={{ fontSize: 11, margin: "6px 0", opacity: 0.7 }}>
        {t(ANIM.effectOptions)} · {e.name}
      </h3>
      {disabled ? <div style={{ opacity: 0.7 }}>{t(ANIM.readOnly)}</div> : null}
      {props.preset && props.preset.subtypes.length > 1
        ? row(
            t(ANIM.direction),
            <select
              data-animation-direction=""
              disabled={disabled}
              value={e.presetSubtype}
              onChange={(ev) => props.onOption(Number(ev.target.value))}
            >
              {props.preset.subtypes.map((s) => (
                <option key={s.subtype} value={s.subtype}>
                  {s.label}
                </option>
              ))}
            </select>,
          )
        : null}
      {row(
        t(ANIM.start),
        <select
          data-animation-start=""
          disabled={disabled}
          value={e.start}
          onChange={(ev) =>
            props.onTiming({ start: ev.target.value as EffectStart })
          }
        >
          <option value="click">{t(ANIM.onClick)}</option>
          <option value="with">{t(ANIM.withPrevious)}</option>
          <option value="after">{t(ANIM.afterPrevious)}</option>
        </select>,
      )}
      {row(
        t(ANIM.duration),
        <input
          type="number"
          data-animation-duration=""
          disabled={disabled}
          min={0.01}
          step={0.25}
          defaultValue={sec(e.durationMs)}
          key={`d${e.index}:${e.durationMs}`}
          onBlur={(ev) => {
            const v = Number(ev.target.value);
            if (
              Number.isFinite(v) &&
              v > 0 &&
              Math.round(v * 1000) !== e.durationMs
            )
              props.onTiming({ durationMs: Math.round(v * 1000) });
          }}
        />,
      )}
      {row(
        t(ANIM.delay),
        <input
          type="number"
          data-animation-delay=""
          disabled={disabled}
          min={0}
          step={0.25}
          defaultValue={sec(e.delayMs)}
          key={`l${e.index}:${e.delayMs}`}
          onBlur={(ev) => {
            const v = Number(ev.target.value);
            if (
              Number.isFinite(v) &&
              v >= 0 &&
              Math.round(v * 1000) !== e.delayMs
            )
              props.onTiming({ delayMs: Math.round(v * 1000) });
          }}
        />,
      )}
      {row(
        t(ANIM.repeat),
        <select
          data-animation-repeat=""
          disabled={disabled}
          value={e.repeat === null ? "" : String(e.repeat)}
          onChange={(ev) => {
            const v = ev.target.value;
            props.onTiming({
              repeat:
                v === "" ? null : v === "indefinite" ? "indefinite" : Number(v),
            });
          }}
        >
          <option value="">{t(ANIM.repeatNone)}</option>
          {[2, 3, 4, 5, 10].map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
          <option value="indefinite">{t(ANIM.repeatUntilClick)}</option>
        </select>,
      )}
      <label
        style={{
          display: "flex",
          gap: 4,
          alignItems: "center",
          margin: "2px 0",
        }}
      >
        <input
          type="checkbox"
          data-animation-rewind=""
          disabled={disabled}
          checked={e.rewindWhenDone === true}
          onChange={(ev) =>
            props.onTiming({ rewindWhenDone: ev.target.checked })
          }
        />
        {t(ANIM.rewind)}
      </label>
      <label
        style={{
          display: "flex",
          gap: 4,
          alignItems: "center",
          margin: "2px 0",
        }}
      >
        <input
          type="checkbox"
          data-animation-autoreverse=""
          disabled={disabled}
          checked={e.rewind === true}
          onChange={(ev) => props.onTiming({ rewind: ev.target.checked })}
        />
        {t(ANIM.autoReverse)}
      </label>
      {e.path ? (
        <>
          <label
            style={{
              display: "flex",
              gap: 4,
              alignItems: "center",
              margin: "2px 0",
            }}
          >
            <input
              type="checkbox"
              data-animation-path-locked=""
              disabled={disabled}
              checked={e.pathLocked === true}
              onChange={(ev) => props.onPathLock(ev.target.checked)}
            />
            {t(ANIM.pathLocked)}
          </label>
          <div style={{ opacity: 0.7, margin: "2px 0" }}>{t(ANIM.pathHint)}</div>
        </>
      ) : null}
      {row(
        t(ANIM.trigger),
        <select
          data-animation-trigger=""
          disabled={disabled}
          value={e.trigger?.key ?? ""}
          onChange={(ev) => {
            const key = ev.target.value;
            const shape = shapes.find((s) => s.key === key);
            const item = shape ? (shape.art[0] ?? shape.text) : null;
            props.onTiming({
              trigger: shape
                ? {
                    spid: key.split(/[#/]/).pop() ?? "",
                    key,
                    item: item ? idOf(item.id) : null,
                  }
                : null,
            });
          }}
        >
          <option value="">{t(ANIM.triggerSequence)}</option>
          {shapes.map((s) => (
            <option key={s.key!} value={s.key!}>
              {t(ANIM.triggerOn, { shape: s.key!.split("#").pop() ?? s.key! })}
            </option>
          ))}
        </select>,
      )}
      <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
        <button
          type="button"
          data-animation-move-up=""
          disabled={disabled || e.index === 0}
          onClick={() => props.onMove(e.index - 1)}
        >
          {t(ANIM.moveUp)}
        </button>
        <button
          type="button"
          data-animation-move-down=""
          disabled={disabled || e.index >= props.count - 1}
          onClick={() => props.onMove(e.index + 1)}
        >
          {t(ANIM.moveDown)}
        </button>
        <button type="button" data-animation-remove="" onClick={props.onRemove}>
          {t(ANIM.remove)}
        </button>
      </div>
    </section>
  );
}
