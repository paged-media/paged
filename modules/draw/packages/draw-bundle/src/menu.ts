/**
 * paged.draw — the menu bar entries.
 *
 * THE GAP THIS CLOSES. This bundle registers 92 commands and, until the
 * contract grew `contribute.menu()` (plugin-api 0.2.33), not one of them
 * could reach the menu bar. Every verb was findable only through Cmd+K,
 * where it appeared as a raw command id. A user who did not already know
 * that "pathfinder unite" existed had no way to discover it — and a
 * drawing tool whose Object menu is empty does not read as a drawing
 * tool.
 *
 * WHY A TOP-LEVEL `Draw` MENU. The host's own menus describe a page:
 * File, Edit, View, Object, Type, Layout. Draw's verbs are about the
 * SHAPE under the cursor, and folding ninety of them into `Object` would
 * bury the host's five insert items under a plugin's tree. A path whose
 * first segment names an existing menu merges into it; a new first
 * segment inserts a new top-level menu — so `Draw/…` is one deliberate
 * top-level entry rather than ninety intrusions.
 *
 * WHY `scope: "document"` AND NOT the vectorGraphic context. Tempting,
 * and wrong: these verbs act on the SELECTION on the page — you select a
 * rectangle and unite it with another — not on the inside of a graphic
 * you have double-clicked into. Scoping them to `vectorGraphic` would
 * hide the entire menu at exactly the moment a user reaches for it. The
 * context-scoped form exists for verbs that are genuinely interior; none
 * of draw's are.
 *
 * WHAT IS DELIBERATELY ABSENT. Rename/delete/select-instances verbs are
 * panel management — they need a row selected in the Symbols or Graphic
 * Styles panel to mean anything, and a menu item that silently no-ops
 * because no row is selected is the dead affordance this project keeps
 * arguing against. They stay in their panels, where the row is.
 */

import type { BundleHost, Disposable } from "@paged-media/plugin-api";

const C = "media.paged.draw.command";

/** `[path, command suffix, group]`. Order is positional: entries are
 *  numbered by index within their group so inserting one in the middle
 *  does not mean renumbering the file. */
const ENTRIES: [path: string, suffix: string, group: string][] = [
  // ── Paths ──
  ["Draw/Path/Outline stroke", "outlineStroke", "path"],
  ["Draw/Path/Offset path…", "offsetPath", "path"],
  ["Draw/Path/Simplify…", "simplifyPath", "path"],
  ["Draw/Path/Join endpoints", "joinEndpoints", "path-ends"],
  ["Draw/Path/Average endpoints", "averageEndpoints", "path-ends"],
  ["Draw/Path/Close path", "closePath", "path-ends"],

  // ── Pathfinder — the ten boolean ops, in Illustrator's own order so
  //    the muscle memory transfers. ──
  ["Draw/Pathfinder/Unite", "pathfinderUnite", "pf-shape"],
  ["Draw/Pathfinder/Subtract", "pathfinderSubtract", "pf-shape"],
  ["Draw/Pathfinder/Intersect", "pathfinderIntersect", "pf-shape"],
  ["Draw/Pathfinder/Exclude", "pathfinderExclude", "pf-shape"],
  ["Draw/Pathfinder/Divide", "pathfinderDivide", "pf-path"],
  ["Draw/Pathfinder/Trim", "pathfinderTrim", "pf-path"],
  ["Draw/Pathfinder/Merge", "pathfinderMerge", "pf-path"],
  ["Draw/Pathfinder/Crop", "pathfinderCrop", "pf-path"],
  ["Draw/Pathfinder/Outline", "pathfinderOutline", "pf-path"],
  ["Draw/Pathfinder/Minus back", "pathfinderMinusBack", "pf-path"],

  // ── Compound path ──
  ["Draw/Compound path/Make", "makeCompoundPath", "compound"],
  ["Draw/Compound path/Release", "releaseCompoundPath", "compound"],

  // ── Live corners ──
  ["Draw/Corners/Rounded", "cornersRounded", "corners"],
  ["Draw/Corners/Inverse rounded", "cornersInverseRounded", "corners"],
  ["Draw/Corners/Bevel", "cornersBevel", "corners"],
  ["Draw/Corners/Fancy", "cornersFancy", "corners"],
  ["Draw/Corners/None", "cornersNone", "corners-off"],

  // ── Repeat ──
  ["Draw/Repeat/Radial", "makeRadialRepeat", "repeat-make"],
  ["Draw/Repeat/Grid", "makeGridRepeat", "repeat-make"],
  ["Draw/Repeat/Mirror", "makeMirrorRepeat", "repeat-make"],
  ["Draw/Repeat/Update", "updateRepeat", "repeat-edit"],
  ["Draw/Repeat/Expand", "expandRepeat", "repeat-edit"],
  ["Draw/Repeat/Release", "releaseRepeat", "repeat-edit"],

  // ── Pattern ──
  ["Draw/Pattern/Make from selection", "makePatternFromSelection", "pattern"],
  ["Draw/Pattern/Edit tile field", "editPatternField", "pattern"],
  ["Draw/Pattern/Release", "releasePatternField", "pattern"],

  // ── Appearance ──
  ["Draw/Appearance/Add fill", "appearanceAddFill", "appearance-add"],
  ["Draw/Appearance/Add stroke", "appearanceAddStroke", "appearance-add"],
  ["Draw/Appearance/Bake", "bakeAppearance", "appearance-edit"],
  ["Draw/Appearance/Release", "releaseAppearance", "appearance-edit"],
  ["Draw/Appearance/Clear", "appearanceClear", "appearance-edit"],

  // ── Graphic styles ──
  ["Draw/Graphic style/Save from selection", "saveGraphicStyle", "gs"],
  ["Draw/Graphic style/Apply", "applyGraphicStyle", "gs"],
  ["Draw/Graphic style/Redefine", "redefineGraphicStyle", "gs"],
  ["Draw/Graphic style/Break link", "breakGraphicStyleLink", "gs"],

  // ── Symbols ──
  ["Draw/Symbol/Define from selection", "defineSymbol", "sym"],
  ["Draw/Symbol/Place instance", "placeSymbolInstance", "sym"],
  ["Draw/Symbol/Redefine", "redefineSymbol", "sym"],
  ["Draw/Symbol/Break link", "breakSymbolLink", "sym"],
  ["Draw/Symbol/Reset transform", "resetSymbolTransform", "sym"],

  // ── Live paint ──
  ["Draw/Live paint/Make", "makeLivePaintGroup", "lp"],
  ["Draw/Live paint/Regenerate", "regenerateLivePaint", "lp"],
  ["Draw/Live paint/Release", "releaseLivePaint", "lp"],

  // ── Blend ──
  ["Draw/Blend/Make", "blendSelected", "blend-make"],
  ["Draw/Blend/Update", "updateBlend", "blend-edit"],
  ["Draw/Blend/Replace spine", "replaceBlendSpine", "blend-spine"],
  ["Draw/Blend/Reverse spine", "reverseBlendSpine", "blend-spine"],
  ["Draw/Blend/Reverse front to back", "reverseBlendFrontToBack", "blend-spine"],
  ["Draw/Blend/Expand", "expandBlend", "blend-edit"],
  ["Draw/Blend/Release", "releaseBlend", "blend-edit"],

  // ── Objects on a path ──
  ["Draw/Objects on path/Make", "makeObjectsOnPath", "oop"],
  ["Draw/Objects on path/Update", "updateObjectsOnPath", "oop"],
  ["Draw/Objects on path/Expand", "expandObjectsOnPath", "oop"],
  ["Draw/Objects on path/Release", "releaseObjectsOnPath", "oop"],

  // ── Type on a path ──
  ["Draw/Type on path/Attach", "attachTextToPath", "top"],
  ["Draw/Type on path/Detach", "detachTextFromPath", "top"],

  // ── Masks ──
  ["Draw/Opacity mask/Make", "makeOpacityMask", "mask"],
  ["Draw/Opacity mask/Release", "releaseOpacityMask", "mask"],

  // ── Insert — these MERGE into the host's existing Object menu rather
  //    than living under Draw, because they mint a new page item and
  //    that is what Object ▸ Insert already means. ──
  ["Object/Insert arc…", "insertArc", "plugin-insert"],
  ["Object/Insert spiral…", "insertSpiral", "plugin-insert"],
  ["Object/Insert rectangular grid…", "insertRectGrid", "plugin-insert"],
  ["Object/Insert polar grid…", "insertPolarGrid", "plugin-insert"],

  // ── Select same — merges into Edit, where selection verbs live. ──
  ["Edit/Select same/Fill", "selectSameFill", "select-same"],
  ["Edit/Select same/Stroke", "selectSameStroke", "select-same"],
  ["Edit/Select same/Stroke weight", "selectSameStrokeWeight", "select-same"],

  // ── Trace ──
  ["Draw/Image trace…", "imageTrace", "trace"],
];

/**
 * Register every menu entry. Returns one Disposable that drops them all,
 * so deactivate stays a single call.
 *
 * DEGRADES ON AN OLDER HOST. `contribute.menu` is absent before
 * plugin-api 0.2.33; the optional call below simply contributes nothing
 * there, which is the same shape `contributeSvgIo` uses for the
 * importer/exporter doors. A bundle that threw on an older host would
 * take the whole plugin down over a menu.
 */
export function contributeMenu(host: BundleHost): Disposable {
  const contribute = host.contribute as BundleHost["contribute"] & {
    menu?: (c: {
      path: string;
      command: string;
      order?: number;
      group?: string;
    }) => Disposable;
  };
  if (typeof contribute.menu !== "function") {
    host.log.info(
      "host predates contribute.menu (plugin-api 0.2.33) — " +
        `${ENTRIES.length} menu entries not contributed; every command ` +
        "remains reachable through the command palette",
    );
    return { dispose() {} };
  }

  const handles: Disposable[] = [];
  const perGroup = new Map<string, number>();
  for (const [path, suffix, group] of ENTRIES) {
    const n = (perGroup.get(group) ?? 0) + 1;
    perGroup.set(group, n);
    handles.push(
      contribute.menu({
        path,
        command: `${C}.${suffix}`,
        group,
        order: n * 10,
      }),
    );
  }
  host.log.info(`contributed ${handles.length} menu entries`);
  return {
    dispose() {
      for (const h of handles) h.dispose();
      handles.length = 0;
    },
  };
}

/** Exported for the bundle's own test — the spec asserts every command
 *  named here is one the manifest actually declares, because the host
 *  REFUSES an entry pointing at nothing and a typo would otherwise
 *  surface as a missing menu item at runtime. */
export const MENU_ENTRIES = ENTRIES;
export const MENU_COMMAND_PREFIX = C;
