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

// The LIVE PAINT panel — the view over the document-resident RECIPES
// that `commands/live-paint.ts` models, plus the face list that makes
// "select individual faces for styling or deletion" reachable without a
// pointer.
//
// An expert-leaf REACT panel for the Layers / Appearance / Graphic
// Styles / Symbols reason (B-01): a LIST of records with per-row actions
// is above the v1 schema panel's scalar binding ceiling. It reloads on
// BOTH `selection.onDidChange` and `document.onDidChange` and writes
// through the EXACT appliers the commands use — no second write path to
// drift from.
//
// WHAT THE ROWS SAY, and why each word is load-bearing:
//   · the FACE COUNT per row is how many faces carry paint — the blast
//     radius of a Regenerate, which replaces every one of them.
//   · each FACE row shows the engine's own face id, because that id is
//     the thing that may not survive a member edit. Showing it is how a
//     user can tell "the same face" from "the same colour".
//   · the SWATCH select drives the bucket's fill (module state in
//     `handlers/live-paint.ts`) — the tool has nothing else to read.

import type { BundleHost, PanelProps, SwatchSummary } from "@paged-media/plugin-api";
import * as React from "react";

import {
  applyDeleteLivePaintFace,
  applyRegenerateLivePaint,
  applyReleaseLivePaint,
  applySelectLivePaintFaces,
  applyMakeLivePaintGroup,
  livePaintLinks,
  readLivePaintLibrary,
  selectedLivePaintGroup,
  LIVE_PAINT_FEATURE,
  type LivePaintRecipe,
} from "../commands/live-paint";
import {
  getLivePaintFill,
  setLivePaintFill,
} from "../handlers/live-paint";

export const LIVE_PAINT_PANEL_ID = "media.paged.draw.panel.livePaint";

/** The limitation the panel renders inline. Exported so the conformance
 *  spec pins the WORDING — an honesty note that can be edited away
 *  silently is not a guarantee. */
export const LIVE_PAINT_NOTE =
  "REGENERABLE, NOT LIVE. Illustrator's Live Paint is a document-resident " +
  "object with a persistent face/edge graph; this engine has no such node " +
  "kind, only a per-call query that re-runs the planar arrangement and " +
  "returns face ids of the form <signature>#<component> — indices into the " +
  "ORDERED member list plus a component number assigned by position. So a " +
  "group here is a RECIPE (the member order plus a paint per face id) saved " +
  "as the container part paged/media.paged.draw/live-paint.json, and a " +
  "filled face is REAL ARTWORK inserted over the region. Editing a member " +
  "does NOT repaint anything: run Regenerate, which re-derives the " +
  "arrangement, rebuilds every face id that still resolves, and reports the " +
  "ones that do not (their artwork is removed rather than left bounded by " +
  "geometry that is gone). Three limits are named rather than implied. " +
  "GAPS ARE NOT HANDLED: the engine's arrangement door takes elementIds and " +
  "an optional point and NO tolerance, its kernel lists gap detection as out " +
  "of scope, and every input subpath is implicitly CLOSED — so two paths " +
  "that do not meet simply do not bound a face. EDGES ARE NOT BUILT: the " +
  "wire exposes face outlines and no edge ids at all, so the catalog's " +
  "\"or stroke edges\" half has nothing to address. And the engine REFUSES " +
  "past 12 member paths or 256 faces — it never truncates, and the refusal " +
  "is shown with the engine's own words instead of an empty result. Two " +
  "smaller facts: a filled face lands at the TOP of the z-order (`insertPath` " +
  "carries no position argument, and Live Paint v0 does not restack), so it " +
  "paints over the inner half " +
  "of the strokes that bound it; and the recipe is a container write, not a " +
  "mutation, so Make, Regenerate's bookkeeping, Delete face and Release " +
  "change it OUTSIDE the undo stack.";

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
const monoStyle: React.CSSProperties = {
  font: "11px var(--font-mono, ui-monospace, monospace)",
  opacity: 0.85,
};
const mutedStyle: React.CSSProperties = {
  opacity: 0.6,
  font: "12px var(--font-sans, sans-serif)",
};

/** The one-line summary a group row shows: how many members form the
 *  arrangement basis and how many of its faces carry paint. Pure —
 *  exported so the conformance spec pins the wording without a DOM. */
export function livePaintRowLabel(group: LivePaintRecipe): string {
  const members = group.inputs.length;
  const faces = group.faces.length;
  return (
    `${members} member${members === 1 ? "" : "s"} · ` +
    `${faces} painted face${faces === 1 ? "" : "s"}`
  );
}

export function makeLivePaintPanel(host: BundleHost): {
  title: string;
  component: React.ComponentType<PanelProps>;
  defaultDock: "right";
} {
  const Component: React.FC<PanelProps> = () => {
    const [groups, setGroups] = React.useState<LivePaintRecipe[]>([]);
    const [active, setActive] = React.useState<string | null>(null);
    const [swatches, setSwatches] = React.useState<SwatchSummary[]>([]);
    const [fill, setFill] = React.useState<string | null>(getLivePaintFill());
    const [hasSelection, setHasSelection] = React.useState(false);
    const [portable, setPortable] = React.useState(true);
    const [painted, setPainted] = React.useState<Record<string, string[]>>({});

    const reload = React.useCallback(async () => {
      setPortable(host.supports(LIVE_PAINT_FEATURE));
      const library = await readLivePaintLibrary(host);
      setGroups(library.groups);
      setHasSelection(host.selection.get().length > 0);
      setActive((await selectedLivePaintGroup(host))?.id ?? null);
      try {
        setSwatches(
          (await host.document.collection<SwatchSummary>("swatches")).slice(),
        );
      } catch {
        setSwatches([]);
      }
      const tally: Record<string, string[]> = {};
      const links = await livePaintLinks(host);
      for (const f of links.fills) {
        (tally[f.ref.group] ??= []).push(f.ref.face);
      }
      setPainted(tally);
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
        host.log.warn(`live paint panel: ${String(e)}`);
      }
      void reload();
    };

    return (
      <div
        style={{ padding: 12 }}
        data-draw-live-paint-panel={groups.length}
        data-draw-live-paint-portable={portable ? "true" : "false"}
        data-draw-live-paint-active={active ?? ""}
      >
        <div style={{ ...rowStyle, justifyContent: "space-between" }}>
          <span style={{ ...sectionStyle, paddingTop: 0 }}>
            Live Paint ({groups.length})
          </span>
          <button
            type="button"
            style={iconBtn}
            title="Record the selected paths as a Live Paint recipe — the engine refuses past 12 paths, and the refusal is shown verbatim"
            data-draw-live-paint-make
            disabled={!hasSelection}
            onClick={() => void run(applyMakeLivePaintGroup(host))}
          >
            + From selection
          </button>
        </div>

        {!portable && (
          <div style={mutedStyle} data-draw-live-paint-degraded>
            This host wires no .paged container writer, so a recipe cannot be
            saved — the fills would be artwork nothing can regenerate.
          </div>
        )}

        <div style={rowStyle}>
          <span style={{ flex: 1 }}>Bucket fill</span>
          <select
            style={{ font: "12px var(--font-sans, sans-serif)" }}
            data-draw-live-paint-fill
            value={fill ?? ""}
            onChange={(e) => {
              const next = e.target.value.length > 0 ? e.target.value : null;
              setFill(next);
              setLivePaintFill(next);
            }}
          >
            <option value="">(none)</option>
            {swatches.map((s) => (
              <option key={s.selfId} value={s.selfId}>
                {s.name}
              </option>
            ))}
          </select>
        </div>

        {groups.length === 0 ? (
          <div style={mutedStyle}>
            No Live Paint groups yet — select two or more overlapping paths and
            record them.
          </div>
        ) : (
          groups.map((group) => (
            <div key={group.id} data-draw-live-paint-row={group.id}>
              <div style={{ ...rowStyle, paddingTop: 8 }}>
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={livePaintRowLabel(group)}
                >
                  {group.name}
                </span>
                <button
                  type="button"
                  style={iconBtn}
                  title="Re-derive the arrangement and rebuild every face that still resolves — face ids may not survive a member edit"
                  data-draw-live-paint-regenerate
                  onClick={() =>
                    void run(
                      applyRegenerateLivePaint(host, { groupId: group.id }),
                    )
                  }
                >
                  Regenerate
                </button>
                <button
                  type="button"
                  style={iconBtn}
                  title="Select every painted face of this group"
                  data-draw-live-paint-select
                  onClick={() =>
                    void run(
                      applySelectLivePaintFaces(host, { groupId: group.id }),
                    )
                  }
                >
                  Select faces
                </button>
                <button
                  type="button"
                  style={iconBtn}
                  title="Drop the recipe and every link — the members and the painted faces keep their artwork"
                  data-draw-live-paint-release
                  onClick={() =>
                    void run(applyReleaseLivePaint(host, { groupId: group.id }))
                  }
                >
                  Release
                </button>
              </div>
              <div style={mutedStyle}>{livePaintRowLabel(group)}</div>
              {group.faces.map((face) => {
                const materialised = (painted[group.id] ?? []).includes(
                  face.face,
                );
                return (
                  <div
                    key={face.face}
                    style={rowStyle}
                    data-draw-live-paint-face={face.face}
                    data-draw-live-paint-face-materialised={
                      materialised ? "true" : "false"
                    }
                  >
                    <span style={{ ...monoStyle, flex: 1 }}>{face.face}</span>
                    <span style={mutedStyle}>{face.fill ?? "(none)"}</span>
                    <button
                      type="button"
                      style={iconBtn}
                      title="Select this face's artwork"
                      data-draw-live-paint-face-select
                      onClick={() =>
                        void run(
                          applySelectLivePaintFaces(host, {
                            groupId: group.id,
                            face: face.face,
                          }),
                        )
                      }
                    >
                      Select
                    </button>
                    <button
                      type="button"
                      style={iconBtn}
                      title="Delete this face's artwork and forget its paint"
                      data-draw-live-paint-face-delete
                      onClick={() =>
                        void run(
                          applyDeleteLivePaintFace(host, {
                            groupId: group.id,
                            face: face.face,
                          }),
                        )
                      }
                    >
                      Delete
                    </button>
                  </div>
                );
              })}
            </div>
          ))
        )}

        <div style={noteStyle} data-draw-live-paint-note>
          {LIVE_PAINT_NOTE}
        </div>
      </div>
    );
  };
  return {
    title: "Live paint",
    component: Component,
    defaultDock: "right",
  };
}
