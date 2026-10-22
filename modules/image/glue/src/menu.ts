/**
 * paged.image — the menu bar entries.
 *
 * 23 commands and, until `contribute.menu()` (plugin-api 0.2.33), no
 * route to a menu: every verb lived behind Cmd+K, where a raster editor's
 * whole vocabulary — adjust, fill, feather, bake — appeared as a flat
 * list of ids next to everything else in the app.
 *
 * A TOP-LEVEL `Image` MENU, which is what every raster editor has and
 * where a user will look first. Two verbs merge elsewhere instead,
 * because they are about the DOCUMENT rather than the image: the
 * selection-to-path pair belongs beside the host's own selection verbs
 * in `Edit`.
 *
 * THREE COMMANDS ARE DELIBERATELY ABSENT, and the reasons differ:
 *
 *   · `undo` / `redo` — the host owns `Edit ▸ Undo`. A second undo in a
 *     second menu, operating on a DIFFERENT stack (the image session's,
 *     not the document's), is the most dangerous kind of duplicate: it
 *     looks like the thing you know and destroys something else. It
 *     stays on its panel, where the stack it belongs to is visible.
 *   · `claimTiles` — "serve image tiles to the renderer" is plumbing the
 *     compositor calls, not a verb a person performs.
 */

import type { BundleHost, Disposable } from "@paged-media/plugin-api";
import { defineMessages } from "@paged-media/strings";

// The paths stay English: they are the entries' identities (the host's
// Edit menu among them). Each segment this bundle creates is a message
// under "menu", which the shell shows through its menu labels.
defineMessages("menu", {
  Image: "Image",
  "Open image panel": "Open image panel",
  "Adjust…": "Adjust…",
  "Auto-enhance": "Auto-enhance",
  "Bake adjustments into layer": "Bake adjustments into layer",
  "Rotate 90° clockwise": "Rotate 90° clockwise",
  "Rotate 90° counter-clockwise": "Rotate 90° counter-clockwise",
  "Rotate 180°": "Rotate 180°",
  "Flip horizontal": "Flip horizontal",
  "Flip vertical": "Flip vertical",
  Layer: "Layer",
  Add: "Add",
  "Add mask (reveal all)": "Add mask (reveal all)",
  "Add mask (hide all)": "Add mask (hide all)",
  "Convert to smart object": "Convert to smart object",
  Selection: "Selection",
  "Select all": "Select all",
  Deselect: "Deselect",
  Invert: "Invert",
  "Feather…": "Feather…",
  "From luminosity channel": "From luminosity channel",
  Fill: "Fill",
  "Gradient…": "Gradient…",
  "Noise…": "Noise…",
  "Content-aware": "Content-aware",
  "Foreground colour": "Foreground colour",
  "Define pattern": "Define pattern",
  Pattern: "Pattern",
  Filter: "Filter",
  "Shape blur": "Shape blur",
  Median: "Median",
  Maximum: "Maximum",
  Minimum: "Minimum",
  "Apply crop": "Apply crop",
  "Set type": "Set type",
  "Load brush library (.abr)…": "Load brush library (.abr)…",
  "Commit edits to the document": "Commit edits to the document",
  File: "File",
  "Apply adjustments to the file": "Apply adjustments to the file",
  "Save the adjusted file": "Save the adjusted file",
  "Selection to path": "Selection to path",
  "Path to selection": "Path to selection",
});

const C = "media.paged.image.command";

/** `[path, command suffix, group]`. */
const ENTRIES: [path: string, suffix: string, group: string][] = [
  ["Image/Open image panel", "openImage", "session"],

  ["Image/Adjust…", "adjustSelected", "adjust"],
  ["Image/Auto-enhance", "autoEnhance", "adjust"],
  ["Image/Bake adjustments into layer", "bakeAdjustToLayer", "adjust-bake"],

  ["Image/Rotate 90° clockwise", "rotateCw", "canvas"],
  ["Image/Rotate 90° counter-clockwise", "rotateCcw", "canvas"],
  ["Image/Rotate 180°", "rotate180", "canvas"],
  ["Image/Flip horizontal", "flipHorizontal", "canvas"],
  ["Image/Flip vertical", "flipVertical", "canvas"],

  ["Image/Layer/Add", "addLayer", "layer"],
  ["Image/Layer/Add mask (reveal all)", "addLayerMask", "layer-mask"],
  ["Image/Layer/Add mask (hide all)", "addLayerMaskHideAll", "layer-mask"],
  ["Image/Layer/Convert to smart object", "convertLayerToSmart", "layer-smart"],

  ["Image/Selection/Select all", "selectAll", "sel"],
  ["Image/Selection/Deselect", "deselect", "sel"],
  ["Image/Selection/Invert", "invertSelection", "sel"],
  ["Image/Selection/Feather…", "featherSelection", "sel-edit"],
  ["Image/Selection/From luminosity channel", "channelToSelection", "sel-conv"],

  ["Image/Fill/Gradient…", "fillSelection", "fill"],
  ["Image/Fill/Noise…", "fillNoise", "fill"],
  ["Image/Fill/Content-aware", "contentAwareFill", "fill"],
  ["Image/Fill/Foreground colour", "fillForeground", "fill"],
  ["Image/Fill/Define pattern", "definePattern", "fill-pattern"],
  ["Image/Fill/Pattern", "fillPattern", "fill-pattern"],
  ["Image/Filter/Shape blur", "shapeBlur", "filter"],
  ["Image/Filter/Median", "median", "filter-rank"],
  ["Image/Filter/Maximum", "maximum", "filter-rank"],
  ["Image/Filter/Minimum", "minimum", "filter-rank"],

  ["Image/Apply crop", "commitCrop", "crop"],
  ["Image/Set type", "setType", "type"],
  ["Image/Load brush library (.abr)…", "loadBrushLibrary", "brush"],

  ["Image/Commit edits to the document", "commitImage", "commit"],

  ["Image/File/Apply adjustments to the file", "applyToFile", "file"],
  ["Image/File/Save the adjusted file", "saveToFile", "file"],

  // These two convert between the DOCUMENT's paths and the image's
  // selection, so they belong beside the host's selection verbs rather
  // than buried three levels into a plugin menu.
  ["Edit/Selection to path", "selectionToPath", "img-sel-conv"],
  ["Edit/Path to selection", "pathToSelection", "img-sel-conv"],
];

/** Register every entry; one Disposable drops them all. */
export function contributeMenu(host: BundleHost): Disposable {
  const handles: Disposable[] = [];
  const perGroup = new Map<string, number>();
  for (const [path, suffix, group] of ENTRIES) {
    const n = (perGroup.get(group) ?? 0) + 1;
    perGroup.set(group, n);
    handles.push(
      host.contribute.menu({
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

/** Exported for the bundle's own test. */
export const MENU_ENTRIES = ENTRIES;
export const MENU_COMMAND_PREFIX = C;
