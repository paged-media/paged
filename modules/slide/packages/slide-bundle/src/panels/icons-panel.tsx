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

// The Icons panel (Insert ▸ Icons, slide ADR 723): the bundled icons
// (icons.ts) and an SVG from a file. A click puts the icon on the active
// slide, centred, as an SVG picture, and selects it.

import type { BundleHost, PanelProps } from "@paged-media/plugin-api";
import { subscribeOf, useLive } from "@paged-media/react-live";
import { useStrings } from "@paged-media/strings";
import * as React from "react";

import type { SlideEngine } from "../engine.js";
import { ICONS, iconBytes } from "../icons.js";
import { ICONS_MSG } from "../messages.js";
import { insertPicture } from "../pictures.js";
import type { SlidesStore } from "../slides-model.js";

export function makeIconsPanel(
  host: BundleHost,
  store: SlidesStore,
  engine: () => Promise<SlideEngine>,
  fromFile: () => Promise<unknown>,
): React.ComponentType<PanelProps> {
  const Component: React.FC<PanelProps> = () => {
    const { t } = useStrings();
    const slides = useLive(store, subscribeOf);
    const slide = slides.activeSlide();
    if (!slide) {
      return (
        <div
          style={{ padding: 12, fontSize: 13, opacity: 0.7 }}
          data-icons-panel="empty"
        >
          {t(ICONS_MSG.empty)}
        </div>
      );
    }
    const insert = async (name: string) => {
      const bytes = iconBytes(name);
      if (!bytes) return;
      const [w, h] = slide.sizePt ?? [960, 540];
      const id = await insertPicture(host, await engine(), {
        bytes,
        pageId: slide.pageId,
        pageSize: [w, h],
        center: [w / 2, h / 2],
      });
      if (id) await host.selection.set([id]);
    };
    return (
      <div data-icons-panel="" style={{ padding: 8, overflowY: "auto" }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {ICONS.map((i) => (
            <button
              key={i.name}
              type="button"
              data-icon={i.name}
              title={i.name}
              aria-label={t(ICONS_MSG.insert, { name: i.name })}
              onClick={() => void insert(i.name)}
              style={{
                width: 36,
                height: 36,
                padding: 4,
                border: "1px solid transparent",
                background: "#fff",
                cursor: "pointer",
              }}
            >
              <img
                alt=""
                width={26}
                height={26}
                src={`data:image/svg+xml,${encodeURIComponent(i.svg)}`}
              />
            </button>
          ))}
        </div>
        <button
          type="button"
          data-icons-from-file=""
          onClick={() => void fromFile()}
          style={{ marginTop: 8 }}
        >
          {t(ICONS_MSG.fromFile)}
        </button>
        <p style={{ fontSize: 11, opacity: 0.6, margin: "6px 0 0" }}>
          {t(ICONS_MSG.licence)}
        </p>
      </div>
    );
  };
  return Component;
}
