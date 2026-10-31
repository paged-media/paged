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

// The Shapes panel (Insert ▸ Shapes, slide ADR 717): every DrawingML preset
// by PowerPoint's categories, each drawn by the slide engine. A click puts
// the preset on the active slide, centred, as a live preset, and selects
// it; the typed command `media.paged.slide.insertShape` does the same for
// scripts and the CLI.

import type { BundleHost, PanelProps } from "@paged-media/plugin-api";
import { subscribeOf, useLive } from "@paged-media/react-live";
import { useStrings } from "@paged-media/strings";
import * as React from "react";

import type { GalleryItem, SlideEngine } from "../engine.js";
import { SHAPES } from "../messages.js";
import { insertShape } from "../shapes.js";
import type { SlidesStore } from "../slides-model.js";

/** The category headings, in PowerPoint's order. */
const CATEGORIES: readonly (keyof typeof SHAPES)[] = [
  "lines",
  "rectangles",
  "basicShapes",
  "blockArrows",
  "equation",
  "flowchart",
  "starsAndBanners",
  "callouts",
  "actionButtons",
];

export function makeShapesPanel(
  host: BundleHost,
  store: SlidesStore,
  engine: () => Promise<SlideEngine>,
): React.ComponentType<PanelProps> {
  let cached: GalleryItem[] | null = null;
  const Component: React.FC<PanelProps> = () => {
    const { t } = useStrings();
    const slides = useLive(store, subscribeOf);
    const [items, setItems] = React.useState<GalleryItem[] | null>(cached);
    React.useEffect(() => {
      if (cached) return;
      let live = true;
      void engine().then((e) => {
        cached = e.gallery();
        if (live) setItems(cached);
      });
      return () => {
        live = false;
      };
    }, []);
    const slide = slides.activeSlide();
    if (!slide) {
      return (
        <div
          style={{ padding: 12, fontSize: 13, opacity: 0.7 }}
          data-shapes-panel="empty"
        >
          {t(SHAPES.empty)}
        </div>
      );
    }
    const insert = async (prst: string) => {
      const [w, h] = slide.sizePt ?? [960, 540];
      const id = await insertShape(host, await engine(), {
        prst,
        pageId: slide.pageId,
        center: [w / 2, h / 2],
      });
      if (id) await host.selection.set([id]);
    };
    return (
      <div data-shapes-panel="" style={{ padding: 8, overflowY: "auto" }}>
        {CATEGORIES.map((c) => {
          const inCat = (items ?? []).filter((i) => i.category === c);
          if (inCat.length === 0) return null;
          return (
            <section key={c} data-shapes-category={c}>
              <h3 style={{ fontSize: 11, margin: "8px 0 4px", opacity: 0.7 }}>
                {t(SHAPES[c])}
              </h3>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 2 }}>
                {inCat.map((i) => (
                  <button
                    key={i.prst}
                    type="button"
                    data-shape={i.prst}
                    title={t(SHAPES.insert, { name: i.prst })}
                    aria-label={t(SHAPES.insert, { name: i.prst })}
                    onClick={() => void insert(i.prst)}
                    style={{
                      width: 30,
                      height: 26,
                      padding: 2,
                      border: "1px solid transparent",
                      background: "transparent",
                      color: "inherit",
                      cursor: "pointer",
                    }}
                  >
                    <svg
                      viewBox="-2 -2 44 34"
                      width="24"
                      height="20"
                      aria-hidden="true"
                    >
                      <path
                        d={i.path}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={1.5}
                        vectorEffect="non-scaling-stroke"
                      />
                    </svg>
                  </button>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    );
  };
  return Component;
}
