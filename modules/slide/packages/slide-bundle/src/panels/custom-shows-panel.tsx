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

// Slide Show ▸ Custom Shows… (slide ADR 720): the deck's custom shows,
// PowerPoint's Define Custom Show dialog as a panel. Pick a show, name it,
// choose its slides and their order, play it. Each change is one undoable
// write of the deck's label.

import type { BundleHost, PanelProps } from "@paged-media/plugin-api";
import { subscribeOf, useLive } from "@paged-media/react-live";
import { useStrings } from "@paged-media/strings";
import * as React from "react";

import { liveShows, nextShowId, type CustomShow } from "../custom-shows.js";
import { OUTPUT } from "../messages.js";
import type { Output } from "../output/output.js";
import type { SlidesStore } from "../slides-model.js";

const row: React.CSSProperties = {
  display: "flex",
  gap: 6,
  alignItems: "center",
  fontSize: 12,
};

/** "New show N" with the first N no show in `shows` is named (outside the
 *  component: the React Compiler does not lower a counter a lambda
 *  updates). */
function freeShowName(base: string, shows: readonly CustomShow[]): string {
  let n = shows.length + 1;
  while (shows.some((s) => s.name === `${base} ${n}`)) n++;
  return `${base} ${n}`;
}

export function makeCustomShowsPanel(
  host: BundleHost,
  store: SlidesStore,
  output: Output,
): React.ComponentType<PanelProps> {
  const Panel: React.FC<PanelProps> = () => {
    const { t } = useStrings();
    const live = useLive(store, subscribeOf);
    const slides = live.list();
    const [shows, setShows] = React.useState<CustomShow[]>([]);
    const [picked, setPicked] = React.useState<number | null>(null);
    const [adding, setAdding] = React.useState("");

    const reload = React.useCallback(() => {
      void output.shows.list().then(setShows, () => setShows([]));
    }, []);
    React.useEffect(() => {
      reload();
      const d = host.document.onDidChange(() => reload());
      return () => d.dispose();
    }, [reload]);

    const pageIds = slides.map((s) => s.pageId);
    const visible = liveShows(shows, pageIds);
    const show = visible.find((s) => s.id === picked) ?? null;
    const numberOf = new Map(slides.map((s) => [s.pageId, s.number]));
    const write = (next: CustomShow[]) => {
      setShows(next);
      void output.shows.write(next).then(reload);
    };
    const edit = (pages: string[]) =>
      show &&
      write(visible.map((s) => (s.id === show.id ? { ...s, pages } : s)));

    return (
      <div
        data-custom-shows="ready"
        style={{ padding: 8, display: "grid", gap: 8 }}
      >
        {visible.length === 0 && (
          <div style={{ fontSize: 12, opacity: 0.7 }}>
            {t(OUTPUT.showsEmpty)}
          </div>
        )}
        <div
          role="listbox"
          aria-label={t(OUTPUT.showsTitle)}
          style={{ display: "grid", gap: 2 }}
        >
          {visible.map((s) => (
            <div
              key={s.id}
              role="option"
              aria-selected={s.id === picked}
              data-custom-show={s.name}
              onClick={() => setPicked(s.id)}
              style={{
                ...row,
                padding: "4px 6px",
                cursor: "pointer",
                background:
                  s.id === picked
                    ? "var(--pg-selection-bg, rgba(224,33,138,.12))"
                    : undefined,
              }}
            >
              <span style={{ flex: 1 }}>{s.name}</span>
              <span style={{ opacity: 0.6 }}>
                {t(OUTPUT.sectionSlides, { count: s.pages.length })}
              </span>
              <button
                type="button"
                data-custom-show-play={s.name}
                disabled={s.pages.length === 0}
                onClick={(e) => {
                  e.stopPropagation();
                  void output.playCustomShow(s.name).catch(() => {});
                }}
              >
                {t(OUTPUT.play)}
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          data-custom-show-new
          onClick={() => {
            const id = nextShowId(visible);
            const name = freeShowName(t(OUTPUT.newShow), visible);
            write([...visible, { id, name, pages: [] }]);
            setPicked(id);
          }}
        >
          {t(OUTPUT.newShow)}
        </button>
        {show && (
          <div data-custom-show-editor style={{ display: "grid", gap: 6 }}>
            <label style={row}>
              {t(OUTPUT.showName)}
              <input
                key={show.id}
                defaultValue={show.name}
                data-custom-show-name
                onBlur={(e) => {
                  const name = e.target.value.trim();
                  if (
                    name &&
                    name !== show.name &&
                    !visible.some((s) => s.name === name)
                  )
                    write(
                      visible.map((s) =>
                        s.id === show.id ? { ...s, name } : s,
                      ),
                    );
                }}
              />
            </label>
            <div style={{ fontSize: 12, opacity: 0.7 }}>{t(OUTPUT.inShow)}</div>
            {show.pages.map((p, i) => (
              <div
                key={`${p}-${i}`}
                style={row}
                data-custom-show-slide={numberOf.get(p)}
              >
                <span style={{ flex: 1 }}>{numberOf.get(p)}</span>
                <button
                  type="button"
                  title={t(OUTPUT.moveUp)}
                  disabled={i === 0}
                  onClick={() => {
                    const next = [...show.pages];
                    [next[i - 1], next[i]] = [next[i]!, next[i - 1]!];
                    edit(next);
                  }}
                >
                  ↑
                </button>
                <button
                  type="button"
                  title={t(OUTPUT.moveDown)}
                  disabled={i === show.pages.length - 1}
                  onClick={() => {
                    const next = [...show.pages];
                    [next[i + 1], next[i]] = [next[i]!, next[i + 1]!];
                    edit(next);
                  }}
                >
                  ↓
                </button>
                <button
                  type="button"
                  title={t(OUTPUT.delete)}
                  onClick={() => edit(show.pages.filter((_, k) => k !== i))}
                >
                  ×
                </button>
              </div>
            ))}
            <div style={row}>
              <select
                data-custom-show-add
                value={adding}
                onChange={(e) => setAdding(e.target.value)}
              >
                <option value="">—</option>
                {slides.map((s) => (
                  <option key={s.pageId} value={s.pageId}>
                    {s.number}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={!adding}
                onClick={() => {
                  edit([...show.pages, adding]);
                  setAdding("");
                }}
              >
                +
              </button>
              <span style={{ flex: 1 }} />
              <button
                type="button"
                data-custom-show-delete
                onClick={() => {
                  write(visible.filter((s) => s.id !== show.id));
                  setPicked(null);
                }}
              >
                {t(OUTPUT.delete)}
              </button>
            </div>
          </div>
        )}
      </div>
    );
  };
  return Panel;
}
