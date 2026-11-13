/*
 * This file is part of paged (https://paged.media), the commercial editor
 * for the paged IDML engine.
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

// Where the Window menu lists each of the editor's own panels (UX audit
// F-18). The menu had grown from the dock groups: Window ▸ Styles held
// Color, Color settings, Color wheel, Gradients, Swatches and the Ink
// manager; Window ▸ Properties held Layers, Align, Pathfinder, Info, the
// Inspector and the AI assistant; fifteen panels sat at the top above
// eight sub-menus. It now follows InDesign's categories, with one entry
// per panel and only the panels a designer reaches for all day one click
// deep. A panel this table does not name falls back to its `defaultGroup`
// (PagedShell's `windowMenuGroup`).

import type { PanelContribution, WindowCategory } from "@paged-media/shell";

export const WINDOW_CATEGORY: Readonly<Record<string, WindowCategory>> = {
  // ── one click deep ──
  "paged.properties": "Workspace",
  "paged.pages": "Workspace",
  "paged.layers": "Workspace",
  "paged.links": "Workspace",
  "paged.document-map": "Workspace",
  "paged.stories": "Workspace",
  "paged.library": "Workspace",
  "paged.comments": "Workspace",
  // ── Color ──
  "paged.color": "Color",
  "paged.color-wheel": "Color",
  "paged.swatches": "Color",
  "paged.gradients": "Color",
  "paged.color-groups": "Color",
  "paged.swatch-options": "Color",
  "paged.gradient-options": "Color",
  "paged.color-group-options": "Color",
  "paged.ink-manager": "Color",
  "paged.color-settings": "Color",
  "paged.theme": "Color",
  // ── Styles ──
  "paged.paragraph-styles": "Styles",
  "paged.character-styles": "Styles",
  "paged.object-styles": "Styles",
  "paged.cell-styles": "Styles",
  "paged.table-styles": "Styles",
  "paged.style-options": "Styles",
  "paged.component-library": "Styles",
  // ── Type & Tables ──
  "paged.character": "Type & Tables",
  "paged.paragraph": "Type & Tables",
  "paged.glyphs": "Type & Tables",
  "paged.tabs": "Type & Tables",
  "paged.bullets-numbering": "Type & Tables",
  "paged.numbering-list-options": "Type & Tables",
  "paged.table": "Type & Tables",
  "paged.text-frame-options": "Type & Tables",
  "paged.fonts": "Type & Tables",
  "paged.text-variables": "Type & Tables",
  "paged.text-fields": "Type & Tables",
  "paged.conditions": "Type & Tables",
  "paged.condition-sets": "Type & Tables",
  "paged.condition-options": "Type & Tables",
  "paged.index": "Type & Tables",
  "paged.find-results": "Type & Tables",
  "paged.story-inspector": "Type & Tables",
  // ── Object & Layout ──
  "paged.align": "Object & Layout",
  "paged.pathfinder": "Object & Layout",
  "paged.object-transform": "Object & Layout",
  "paged.stroke": "Object & Layout",
  "paged.effects": "Object & Layout",
  "paged.transparency": "Object & Layout",
  "paged.appearance": "Object & Layout",
  "paged.text-wrap": "Object & Layout",
  "paged.frame-fitting": "Object & Layout",
  "paged.anchored": "Object & Layout",
  "paged.object-options": "Object & Layout",
  "paged.picture-adjustments": "Object & Layout",
  "paged.generate-image": "Object & Layout",
  "paged.document-setup": "Object & Layout",
  "paged.margins-columns": "Object & Layout",
  "paged.guides": "Object & Layout",
  "paged.pages-list": "Object & Layout",
  "paged.spreads": "Object & Layout",
  "paged.artboards": "Object & Layout",
  "paged.master-pages": "Object & Layout",
  "paged.master-options": "Object & Layout",
  "paged.section-options": "Object & Layout",
  "paged.navigator": "Object & Layout",
  // ── Interactive ──
  "paged.hyperlinks": "Interactive",
  "paged.bookmarks": "Interactive",
  "paged.cross-references": "Interactive",
  "paged.articles": "Interactive",
  // ── Output ──
  "paged.outputs": "Output",
  "paged.export-center": "Output",
  "paged.export-inspector": "Output",
  "paged.preflight": "Output",
  "paged.output-readiness": "Output",
  "paged.publication-health": "Output",
  "paged.separations": "Output",
  "paged.object-export": "Output",
  "paged.export-tagging": "Output",
  // ── Utilities ──
  "paged.info": "Utilities",
  "paged.attributes": "Utilities",
  "paged.inspector": "Utilities",
  "paged.tree": "Utilities",
  "paged.outline": "Utilities",
  "paged.history": "Utilities",
  "paged.script-editor": "Utilities",
  "paged.actions": "Utilities",
  "paged.problems": "Utilities",
  "paged.journal": "Utilities",
  "paged.data": "Utilities",
  "paged.ai-assistant": "Utilities",
  "paged.keyboard-shortcuts": "Utilities",
  "paged.models": "Utilities",
  "paged.control": "Utilities",
  "paged.template": "Utilities",
  "paged.template.form": "Utilities",
  "paged.review-inspector": "Utilities",
};

/** The panels with their Window-menu category set from the table (one
 *  the panel sets itself wins). */
export function withWindowCategories(
  panels: readonly PanelContribution[],
): PanelContribution[] {
  return panels.map((p) =>
    p.windowCategory || !WINDOW_CATEGORY[p.id]
      ? p
      : { ...p, windowCategory: WINDOW_CATEGORY[p.id] },
  );
}
