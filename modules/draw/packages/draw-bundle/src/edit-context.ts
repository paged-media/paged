// W3.2 — the paged.draw vectorGraphic EDIT CONTEXT (closes B-02).
//
// Double-clicking a path-bearing element (polygon / graphic line /
// rectangle / text frame — the Track-J path kinds) ENTERS the
// vectorGraphic context: the anchor-editing tool-set is focused
// (Add/Delete/Convert), the stroke panel is raised, a breadcrumb shows
// "Vector graphic", and Esc pops back out. Entry is by KIND, not
// metadata — a path is recognizable from its engine kind, so the
// matcher reads `candidate.kind` (no `x-paged:` metadata needed; this is
// the kind-claimed half of the registry, vs. paged.web's metadata-
// claimed objectType half).
//
// Host-agnostic: imports only the plugin-api CONTRACT type. The shell
// owns the stack / chrome / write-scope; this declares the claim + the
// tool/panel sets.

import type { EditContextContribution } from "@paged-media/plugin-api";

import { DRAW_TOOLS } from "./tools";
import { STROKE_PANEL_ID } from "./panels/stroke-panel";

export const VECTOR_GRAPHIC_CONTEXT = "vectorGraphic";

/** The engine kinds that carry path anchors (the Track-J fan-out). A
 *  double-click on any of these enters anchor-editing. */
const PATH_KINDS = new Set(["polygon", "graphicLine", "rectangle", "textFrame"]);

export const vectorGraphicEditContext: EditContextContribution = {
  type: VECTOR_GRAPHIC_CONTEXT,
  entry: "doubleClick",
  // Kind-claimed: any path-bearing element. (paged.web's webFrame is a
  // rectangle too, but its objectType claims the double-click FIRST via
  // metadata — see resolveDoubleClick ordering — so a webFrame never
  // falls through to this kind matcher.)
  matches: (candidate) =>
    candidate.kind !== undefined && PATH_KINDS.has(candidate.kind),
  // The anchor-editing tool-set the context focuses (Add is first → the
  // host focuses it on enter).
  toolIds: DRAW_TOOLS.map((t) => t.id),
  // The stroke panel the cockpit raises on enter.
  panelIds: [STROKE_PANEL_ID],
};
