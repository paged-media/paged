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

// Cockpit — the six workflow modes + the right-edge panel rail
// (design-system ui_kits/editor is the reference). Each mode is a
// VIEW over the registered panels: `slots` selects what mounts,
// `toolbarLeft` (work-in-progress; D4) re-skins the context
// toolbar. The shell renders, this file declares.

import type { ModeContribution, PanelRailItem } from "@paged-media/shell";

import {
  ContentToolbar,
  DataToolbar,
  DesignToolbar,
  ExportToolbar,
  PrepressToolbar,
  ReviewToolbar,
} from "./cockpit/toolbars";
import { defineMessages, t } from "@paged-media/strings";

const M = defineMessages("app.cockpitModes", {
  design: "Design",
  designBlurb: "Composition, typography, grids, components",
  content: "Content",
  contentBlurb: "Safe text editing, stories, review flow",
  prepress: "Prepress",
  prepressBlurb: "Preflight, bleed, colour, output readiness",
  dataLayout: "Data layout",
  dataLayoutBlurb: "Structured data → repeatable pages",
  review: "Review",
  reviewBlurb: "Comments, approvals, versions",
  export: "Export",
  exportBlurb: "Multi-format publishing",
  railText: "Text",
  railImage: "Image",
  railStyles: "Styles",
  railSwatches: "Swatches",
  railData: "Data",
  railPages: "Pages",
  railComments: "Comments",
  railPreflight: "Preflight",
  railProblems: "Problems",
});

export const COCKPIT_MODES: ModeContribution[] = [
  {
    id: "design",
    toolbarLeft: DesignToolbar,
    paletteSuggestions: ["paged.file.openIdml"],
    get title() {
      return t(M.design);
    },
    icon: "panel-canvas",
    order: 10,
    get blurb() {
      return t(M.designBlurb);
    },
    slots: {
      left: "paged.document-map",
      // Layers, not the component library: the library is a "coming
      // soon" card, and it held the second-most prominent tab of the
      // default workspace.
      tabs: ["paged.properties", "paged.swatches", "paged.layers"],
    },
  },
  {
    id: "content",
    toolbarLeft: ContentToolbar,
    get title() {
      return t(M.content);
    },
    icon: "panel-character",
    order: 20,
    get blurb() {
      return t(M.contentBlurb);
    },
    slots: {
      left: "paged.stories",
      inspector: "paged.story-inspector",
    },
  },
  {
    id: "prepress",
    toolbarLeft: PrepressToolbar,
    get title() {
      return t(M.prepress);
    },
    icon: "ui-target",
    order: 30,
    get blurb() {
      return t(M.prepressBlurb);
    },
    slots: {
      left: "paged.preflight",
      inspector: "paged.output-readiness",
    },
  },
  {
    id: "data",
    toolbarLeft: DataToolbar,
    paletteSuggestions: [
      "media.paged.data.command.importData",
      "media.paged.data.command.lowerBinding",
    ],
    get title() {
      return t(M.dataLayout);
    },
    icon: "ui-database",
    order: 40,
    get blurb() {
      return t(M.dataLayoutBlurb);
    },
    // The Data menu is a context menu (it shows while a binding is
    // selected or entered); in this mode it is the workspace's own.
    menus: ["Data"],
    // The paged.data bundle's LIVE panels, not the ComingSoon stubs the
    // mode shipped with: sources = the record/field intake, bindings = the
    // field mapping. No canvas override — lowered bindings render INTO the
    // document, so the real canvas IS the generated-layout preview.
    // NOTE: `tabs` wins over `inspector` when both are set
    // (cockpit-state-context seeds tabs ?? [inspector]) — declare the
    // seeded dock as tabs, bindings first (the active tab).
    slots: {
      left: "media.paged.data.panel.sources",
      tabs: [
        "media.paged.data.panel.bindings",
        "media.paged.data.panel.dataset",
      ],
    },
  },
  {
    id: "review",
    toolbarLeft: ReviewToolbar,
    get title() {
      return t(M.review);
    },
    icon: "ui-comment",
    order: 50,
    get blurb() {
      return t(M.reviewBlurb);
    },
    slots: {
      left: "paged.comments",
      inspector: "paged.review-inspector",
    },
  },
  {
    id: "export",
    toolbarLeft: ExportToolbar,
    paletteSuggestions: ["paged.file.exportPdf", "paged.library.exportAse"],
    get title() {
      return t(M.export);
    },
    icon: "ui-export",
    order: 60,
    get blurb() {
      return t(M.exportBlurb);
    },
    slots: {
      left: "paged.outputs",
      inspector: "paged.export-inspector",
      canvas: "panel:paged.export-center",
    },
  },
];

// The kit's panel-selector rail (ui_kits/editor data.jsx PANEL_RAIL):
// Text / Image / Pages steer the Properties inspector; the rest open
// their panel as a right-dock tab. Everything else (Layers, Effects,
// Align, …) stays reachable through the Window menu.
export const PANEL_RAIL: PanelRailItem[] = [
  {
    panelId: "paged.properties",
    get title() {
      return t(M.railText);
    },
    icon: "panel-character",
    inspectorContext: "text",
  },
  {
    panelId: "paged.properties",
    get title() {
      return t(M.railImage);
    },
    icon: "panel-frame-fitting",
    inspectorContext: "image",
  },
  {
    panelId: "paged.object-styles",
    get title() {
      return t(M.railStyles);
    },
    icon: "panel-object-styles",
  },
  {
    panelId: "paged.swatches",
    get title() {
      return t(M.railSwatches);
    },
    icon: "panel-swatches",
  },
  // The live paged.data bindings panel (the rail's first plugin panel).
  // U8: the ComingSoon mapping stub it replaced (`paged.data-mapping`)
  // is retired — the live panel owns the surface.
  {
    panelId: "media.paged.data.panel.bindings",
    get title() {
      return t(M.railData);
    },
    icon: "ui-database",
  },
  {
    panelId: "paged.properties",
    get title() {
      return t(M.railPages);
    },
    icon: "panel-pages",
    inspectorContext: "page",
  },
  {
    panelId: "paged.comments",
    get title() {
      return t(M.railComments);
    },
    icon: "ui-comment",
  },
  {
    panelId: "paged.preflight",
    get title() {
      return t(M.railPreflight);
    },
    icon: "ui-target",
  },
  // Problems. The app writes genuinely good refusal sentences into this
  // panel — "Insert rectangle inserts page items, and you are editing
  // inside a vectorGraphic. Leave the frame (Esc) to insert into the
  // document." — and the panel was in NO mode's slots and on no rail, so
  // the explanation for a greyed command was published where nobody
  // could read it. Save and export failures now land here too, which
  // makes reachability the difference between a reported failure and a
  // silent one.
  {
    panelId: "paged.problems",
    get title() {
      return t(M.railProblems);
    },
    icon: "ui-warn",
  },
];
