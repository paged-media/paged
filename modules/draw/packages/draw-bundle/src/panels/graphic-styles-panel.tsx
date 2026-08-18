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

// The GRAPHIC STYLES panel — the view over the document-resident style
// library that `commands/graphic-styles.ts` models, and over the LINK
// the selected object carries into it.
//
// An expert-leaf REACT panel for the Layers/Appearance reason (B-01): a
// LIST of named records with per-row actions is above the v1 schema
// panel's scalar binding ceiling. It reloads on BOTH
// `selection.onDidChange` and `document.onDidChange` (so undo/redo, a
// foreign appearance edit and a redefine all move the override badge
// with no polling) and writes through the EXACT appliers the commands
// use — no second write path to drift from.
//
// WHAT THE ROWS SAY, and why each word is load-bearing:
//   · "linked" — this object's envelope carries a reference to the row's
//     style. The link is what makes this a style rather than a paste.
//   · "overridden" — the object is still linked, but its live appearance
//     no longer digests to what the style gave it (someone edited it
//     directly). Detected, not stored: nothing is written when an
//     override happens, so every editing surface produces a truthful
//     badge without knowing this panel exists.
//   · the linked COUNT per row — how many objects a Redefine will move.
//     Redefine overwrites overrides, so the number is the blast radius
//     and the panel shows it before the click, not after.

import type { BundleHost, ElementId, PanelProps } from "@paged-media/plugin-api";
import * as React from "react";

import {
  applyBreakGraphicStyleLink,
  applyDeleteGraphicStyle,
  applyGraphicStyleToSelection,
  applyRedefineGraphicStyle,
  applySaveGraphicStyle,
  graphicStyleLinks,
  graphicStyleOverridden,
  graphicStyleRefOf,
  graphicStyleRefusalOf,
  readGraphicAppearance,
  readGraphicStyleLibrary,
  GRAPHIC_STYLES_FEATURE,
  type GraphicStyle,
  type GraphicStyleRef,
} from "../commands/graphic-styles";
import { resolveAppearanceCarrier } from "../commands/appearance-bake";

export const GRAPHIC_STYLES_PANEL_ID = "media.paged.draw.panel.graphicStyles";

/** The limitation the panel renders inline. Exported so the conformance
 *  spec pins the WORDING — an honesty note that can be edited away
 *  silently is not a guarantee. */
export const GRAPHIC_STYLES_NOTE =
  "A graphic style stores a COMPLETE appearance — the stacked fills and " +
  "strokes plus the object's own fill, tint, stroke, weight, opacity and " +
  "blend mode — and applying one LINKS the object to it: Redefine " +
  "propagates to every linked object, Break link keeps the appearance and " +
  "drops the reference. Editing a linked object's appearance directly does " +
  "NOT break the link; the object stays linked and is marked OVERRIDDEN, " +
  "and a Redefine overwrites that override (break the link first to keep a " +
  "local deviation). The library lives in the document, as the container " +
  "part paged/media.paged.draw/graphic-styles.json, so it travels with the " +
  "file — but a container write is not an engine mutation, so SAVE, RENAME " +
  "and DELETE are NOT UNDOABLE (only the per-object writes they perform " +
  "are). What a style cannot reach is named rather than implied: an " +
  "element kind with no slot for a property drops it (a graphic line has no " +
  "fill, tint, opacity or blend mode at all), a BAKED appearance is refused " +
  "until it is released, and this row builds save / apply / redefine / " +
  "break / rename / delete only — the catalog's merge, import, export, " +
  "preview and folder organisation are not built.";

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "3px 0",
  font: "12px var(--font-sans, sans-serif)",
};
const iconBtn: React.CSSProperties = {
  border: "none",
  background: "none",
  cursor: "pointer",
  padding: "0 3px",
  font: "12px var(--font-sans, sans-serif)",
  color: "var(--pg-fg, currentColor)",
};
const sectionStyle: React.CSSProperties = {
  font: "11px var(--font-sans, sans-serif)",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  opacity: 0.65,
  paddingTop: 8,
};
const noteStyle: React.CSSProperties = {
  marginTop: 10,
  padding: "6px 8px",
  border: "1px solid var(--pg-border, rgba(127,127,127,0.4))",
  borderRadius: 3,
  font: "11px/1.45 var(--font-sans, sans-serif)",
  opacity: 0.8,
};
const tagStyle: React.CSSProperties = {
  font: "10px var(--font-sans, sans-serif)",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  border: "1px solid var(--pg-border, rgba(127,127,127,0.5))",
  borderRadius: 2,
  padding: "0 3px",
};
const mutedStyle: React.CSSProperties = {
  opacity: 0.6,
  font: "12px var(--font-sans, sans-serif)",
};

/** The one-line summary a style row shows: how many paints the style
 *  carries and how many objects follow it. Pure — exported so the
 *  conformance spec pins the wording without a DOM. */
export function graphicStyleRowLabel(
  style: GraphicStyle,
  linked: number,
): string {
  const fills = style.appearance.stack.fills.length;
  const strokes = style.appearance.stack.strokes.length;
  const paints =
    fills + strokes === 0
      ? "base paint only"
      : `${fills} fill${fills === 1 ? "" : "s"} · ${strokes} stroke${
          strokes === 1 ? "" : "s"
        }`;
  return `${paints} · ${linked} linked`;
}

/** What the panel knows about the current selection's link. */
interface SelectionLink {
  target: ElementId | null;
  ref: GraphicStyleRef | null;
  overridden: boolean;
  baked: boolean;
}

const NO_LINK: SelectionLink = {
  target: null,
  ref: null,
  overridden: false,
  baked: false,
};

export function makeGraphicStylesPanel(host: BundleHost): {
  title: string;
  component: React.ComponentType<PanelProps>;
  defaultDock: "right";
} {
  const Component: React.FC<PanelProps> = () => {
    const [styles, setStyles] = React.useState<GraphicStyle[]>([]);
    const [counts, setCounts] = React.useState<Record<string, number>>({});
    const [link, setLink] = React.useState<SelectionLink>(NO_LINK);
    const [portable, setPortable] = React.useState(true);

    const reload = React.useCallback(async () => {
      setPortable(host.supports(GRAPHIC_STYLES_FEATURE));
      const library = await readGraphicStyleLibrary(host);
      setStyles(library.styles);

      const tally: Record<string, number> = {};
      for (const l of await graphicStyleLinks(host)) {
        tally[l.ref.id] = (tally[l.ref.id] ?? 0) + 1;
      }
      setCounts(tally);

      const first = host.selection.get()[0] ?? null;
      if (!first) {
        setLink(NO_LINK);
        return;
      }
      try {
        // A baked stack can be selected as its group or as one of its
        // derived layers — both resolve to the carrier that owns the
        // appearance (and therefore the style link).
        const target = await resolveAppearanceCarrier(host, first);
        const read = await readGraphicAppearance(host, target);
        const ref = graphicStyleRefOf(read.envelope);
        setLink({
          target,
          ref,
          overridden: ref ? graphicStyleOverridden(ref, read.appearance) : false,
          baked: graphicStyleRefusalOf(read.envelope) === "baked",
        });
      } catch {
        setLink({ ...NO_LINK, target: first });
      }
    }, []);

    React.useEffect(() => {
      void reload();
      const subs = [
        host.selection.onDidChange(() => void reload()),
        host.document.onDidChange(() => void reload()),
      ];
      return () => {
        for (const s of subs) s.dispose();
      };
    }, [reload]);

    const run = async (work: Promise<unknown>) => {
      try {
        await work;
      } catch (e) {
        host.log.warn(`graphic styles panel: ${String(e)}`);
      }
      void reload();
    };

    const linkedName =
      link.ref === null
        ? null
        : (styles.find((s) => s.id === link.ref!.id)?.name ??
          `${link.ref.id} (missing)`);

    return (
      <div
        style={{ padding: 12 }}
        data-draw-graphic-styles-panel={styles.length}
        data-draw-graphic-styles-portable={portable ? "true" : "false"}
        data-draw-graphic-style-linked={link.ref?.id ?? ""}
        data-draw-graphic-style-overridden={link.overridden ? "true" : "false"}
      >
        <div style={{ ...rowStyle, justifyContent: "space-between" }}>
          <span style={{ ...sectionStyle, paddingTop: 0 }}>
            Graphic styles ({styles.length})
          </span>
          <span style={{ display: "flex", gap: 4 }}>
            <button
              type="button"
              style={iconBtn}
              title="Save the selection's complete appearance as a new style (and link the selection to it)"
              data-draw-graphic-style-save
              disabled={!link.target || link.baked}
              onClick={() => void run(applySaveGraphicStyle(host))}
            >
              + From selection
            </button>
            <button
              type="button"
              style={iconBtn}
              title="Drop the selection's style reference and keep its appearance"
              data-draw-graphic-style-break
              disabled={!link.ref}
              onClick={() => void run(applyBreakGraphicStyleLink(host))}
            >
              Break link
            </button>
          </span>
        </div>

        {!portable && (
          <div style={mutedStyle} data-draw-graphic-styles-degraded>
            This host wires no .paged container writer, so the style library
            cannot be read or saved here — nothing would travel with the file.
          </div>
        )}

        {link.baked && (
          <div style={mutedStyle}>
            The selection's appearance is BAKED into a group of derived paths.
            Release it before saving or applying a graphic style.
          </div>
        )}

        {!link.target && (
          <div style={mutedStyle}>
            Select an object to link it to a style, or to save its appearance as
            a new one.
          </div>
        )}

        {link.ref && (
          <div style={rowStyle} data-draw-graphic-style-selection>
            <span style={{ flex: 1, minWidth: 0 }}>
              Selection follows <strong>{linkedName}</strong>
            </span>
            {link.overridden && (
              <span
                style={tagStyle}
                title="Still linked, but this object's appearance was edited directly — a Redefine will overwrite the change"
              >
                overridden
              </span>
            )}
          </div>
        )}

        <div style={sectionStyle}>Library</div>
        {styles.length === 0 ? (
          <div style={mutedStyle}>
            No graphic styles yet — select an object and save its appearance.
          </div>
        ) : (
          styles.map((style) => {
            const linked = counts[style.id] ?? 0;
            const isLinked = link.ref?.id === style.id;
            return (
              <div
                key={style.id}
                style={rowStyle}
                data-draw-graphic-style-row={style.id}
                data-draw-graphic-style-linked-count={linked}
              >
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={graphicStyleRowLabel(style, linked)}
                >
                  {style.name}
                </span>
                {isLinked && <span style={tagStyle}>linked</span>}
                <button
                  type="button"
                  style={iconBtn}
                  title="Apply this style to the selection (links it)"
                  data-draw-graphic-style-apply
                  disabled={!link.target || link.baked}
                  onClick={() =>
                    void run(applyGraphicStyleToSelection(host, style.id))
                  }
                >
                  Apply
                </button>
                <button
                  type="button"
                  style={iconBtn}
                  title={`Redefine from the selection — ${linked} linked object(s) will follow, overrides included`}
                  data-draw-graphic-style-redefine
                  disabled={!link.target || link.baked}
                  onClick={() =>
                    void run(applyRedefineGraphicStyle(host, style.id))
                  }
                >
                  Redefine
                </button>
                <button
                  type="button"
                  style={iconBtn}
                  title="Delete the style and unlink every object that followed it"
                  data-draw-graphic-style-delete
                  onClick={() =>
                    void run(applyDeleteGraphicStyle(host, style.id))
                  }
                >
                  Delete
                </button>
              </div>
            );
          })
        )}

        <div style={noteStyle} data-draw-graphic-styles-note>
          {GRAPHIC_STYLES_NOTE}
        </div>
      </div>
    );
  };
  return {
    title: "Graphic styles",
    component: Component,
    defaultDock: "right",
  };
}
