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
import { linkIndex } from "../link-index";
import { usePanelReload } from "./use-panel-reload";
import { PanelAbout, PanelIntro, Refusal, useActionFeedback } from "./panel-kit";

export const LIVE_PAINT_PANEL_ID = "media.paged.draw.panel.livePaint";

/** What the panel is for, in one sentence (shown at the top). */
export const LIVE_PAINT_SUMMARY =
  "Fill the areas where the selected paths overlap; after you edit the " +
  "paths, choose Regenerate to update the fills.";

/** The "About" text. Exported so the conformance spec pins the wording. */
export const LIVE_PAINT_NOTE =
  "A live paint group remembers its paths and a colour for each area, and " +
  "each filled area is a real shape placed over that region. Editing a " +
  "path does not repaint anything until you choose Regenerate, which " +
  "rebuilds every area that still exists and removes the fills of areas " +
  "that are gone. Paths must actually touch to enclose an area (gaps are " +
  "not closed for you), and edges cannot be painted. A group can have at " +
  "most 12 paths and 256 areas. Filled areas are placed on top of the " +
  "other objects, over the inner half of the strokes around them. Making " +
  "and releasing a group and deleting a fill change the group's record " +
  "outside undo.";

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

    // WHAT A RELOAD COSTS (`test/panels/live-paint-panel.spec.tsx`, and
    // it may only go down): the recipe part once, and — once per document
    // REVISION, not per reload — the links (out of the walk every panel
    // shares) and the swatch collection. A selection change cannot have
    // changed either, and reads neither.
    const reload = usePanelReload(
      host,
      "live-paint",
      async ({ live, selection }) => {
        const library = await readLivePaintLibrary(host);
        if (!live()) return;
        const group = await selectedLivePaintGroup(host, library);
        if (!live()) return;
        const swatches = await linkIndex(host)
          .cached("collection:swatches", async () =>
            (await host.document.collection<SwatchSummary>("swatches")).slice(),
          )
          .catch(() => [] as SwatchSummary[]);
        if (!live()) return;
        const links = await livePaintLinks(host);
        if (!live()) return;
        const tally: Record<string, string[]> = {};
        for (const f of links.fills) {
          (tally[f.ref.group] ??= []).push(f.ref.face);
        }
        setPortable(host.supports(LIVE_PAINT_FEATURE));
        setGroups(library.groups);
        setHasSelection(selection.length > 0);
        setActive(group?.id ?? null);
        setSwatches(swatches);
        setPainted(tally);
      },
    );

    const { refusal, run } = useActionFeedback(host, reload);

    return (
      <div
        style={{ padding: 12 }}
        data-draw-live-paint-panel={groups.length}
        data-draw-live-paint-portable={portable ? "true" : "false"}
        data-draw-live-paint-active={active ?? ""}
      >
        <PanelIntro summary={LIVE_PAINT_SUMMARY} attr="data-draw-live-paint-intro" />
        <div style={{ ...rowStyle, justifyContent: "space-between" }}>
          <span style={{ ...sectionStyle, paddingTop: 0 }}>
            Live paint ({groups.length})
          </span>
          <button
            type="button"
            style={iconBtn}
            title={
              hasSelection
                ? "Make a live paint group from the selected paths (up to 12)"
                : "Select two or more overlapping paths first"
            }
            data-draw-live-paint-make
            disabled={!hasSelection}
            onClick={() => void run(() => applyMakeLivePaintGroup(host))}
          >
            + From selection
          </button>
        </div>

        <Refusal text={refusal} />

        {!portable && (
          <div style={mutedStyle} data-draw-live-paint-degraded>
            This editor cannot save data into the document, so a live paint
            group could not be regenerated later.
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
            <option value="">None</option>
            {swatches.map((s) => (
              <option key={s.selfId} value={s.selfId}>
                {s.name}
              </option>
            ))}
          </select>
        </div>

        {groups.length === 0 ? (
          <div style={mutedStyle}>
            No live paint groups yet. Select two or more overlapping paths and
            choose + From selection.
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
                  title="Rebuild the fills from the paths' current shapes; areas that no longer exist lose their fill"
                  data-draw-live-paint-regenerate
                  onClick={() =>
                    void run(() => applyRegenerateLivePaint(host, { groupId: group.id }),
                    )
                  }
                >
                  Regenerate
                </button>
                <button
                  type="button"
                  style={iconBtn}
                  title="Select every filled area of this group"
                  data-draw-live-paint-select
                  onClick={() =>
                    void run(() => applySelectLivePaintFaces(host, { groupId: group.id }),
                    )
                  }
                >
                  Select faces
                </button>
                <button
                  type="button"
                  style={iconBtn}
                  title="Stop tracking this group; the paths and the filled areas stay as ordinary artwork"
                  data-draw-live-paint-release
                  onClick={() =>
                    void run(() => applyReleaseLivePaint(host, { groupId: group.id }))
                  }
                >
                  Release
                </button>
              </div>
              <div style={mutedStyle}>{livePaintRowLabel(group)}</div>
              {group.faces.map((face, faceIndex) => {
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
                    <span style={{ flex: 1 }} title={face.face}>
                      Area {faceIndex + 1}
                    </span>
                    <span style={mutedStyle}>
                      {face.fill === null
                        ? "No fill"
                        : (swatches.find((s) => s.selfId === face.fill)?.name ??
                          face.fill)}
                    </span>
                    <button
                      type="button"
                      style={iconBtn}
                      title="Select this area's fill"
                      data-draw-live-paint-face-select
                      onClick={() =>
                        void run(() => applySelectLivePaintFaces(host, {
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
                      title="Delete this area's fill"
                      data-draw-live-paint-face-delete
                      onClick={() =>
                        void run(() => applyDeleteLivePaintFace(host, {
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

        <PanelAbout text={LIVE_PAINT_NOTE} attr="data-draw-live-paint-note" />
      </div>
    );
  };
  return {
    title: "Live paint",
    component: Component,
    defaultDock: "right",
  };
}
