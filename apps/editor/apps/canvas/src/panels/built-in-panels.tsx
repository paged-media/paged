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

// The editor's own panels: the registry entries main.tsx hands to
// <PagedShell panels>. Kept apart from main.tsx so the panel lane
// (test/panels) can enumerate and mount every entry without booting the
// app; the surface gates read the literal here.

import { AIAssistant, type PanelContribution } from "@paged-media/shell";

import { CharacterPanel } from "./character-panel";
import { ArticlesPanel } from "./articles-panel";
import { BookmarksPanel } from "./bookmarks-panel";
import { CharacterStylesPanel } from "./character-styles-panel";
import { ColorGroupsPanel } from "./color-groups-panel";
import { ColorSettingsPanel } from "./color-settings-panel";
import { StyleOptionsPanel, STYLE_OPTIONS_PANEL } from "./style-options-panel";
import {
  DocumentSetupPanel,
  MarginsColumnsPanel,
} from "./document-setup-panel";
import { ObjectOptionsPanel } from "./object-options-panel";
import {
  GradientOptionsPanel,
  ColorGroupOptionsPanel,
  NumberingListOptionsPanel,
  ConditionOptionsPanel,
  MasterOptionsPanel,
  FieldOptionsPanel,
  GuidesPanel,
  SectionOptionsPanel,
  SwatchOptionsPanel,
  TextVariablesPanel,
} from "./object-options-panels";
import { InkManagerPanel } from "./ink-manager-panel";
import { ConditionSetsPanel } from "./condition-sets-panel";
import { ConditionsPanel } from "./conditions-panel";
import { CrossReferencesPanel } from "./cross-references-panel";
import { HyperlinksPanel } from "./hyperlinks-panel";
import { IndexPanel } from "./index-panel";
import { InfoPanel } from "./info-panel";
import { LinksPanel } from "./links-panel";
import { EffectsPanel } from "./effects-panel";
import { FrameFittingPanel } from "./frame-fitting-panel";
import { GradientsPanel } from "./gradients-panel";
import { ObjectStylesPanel } from "./object-styles-panel";
import { ObjectTransformPanel } from "./object-transform-panel";
import { AlignPanel } from "./align-panel";
import { AttributesPanel } from "./attributes-panel";
import { ControlPanel } from "./control-panel";
import { PropertiesPanel } from "./properties-panel";
import { PathfinderPanel } from "./pathfinder-panel";
import { CellStylesPanel } from "./cell-styles-panel";
import { ColorPanel } from "./color-panel";
import { ColorWheelPanel } from "./color-wheel-panel";
import { FontsPanel } from "./fonts-panel";
import { TablePanel } from "./table-panel";
import { TabsPanel } from "./concept/tabs-panel";
import { GlyphsPanel } from "./concept/glyphs-panel";
import { BulletsPanel } from "./concept/bullets-panel";
import { AnchoredPanel } from "./concept/anchored-panel";
import { ObjectExportPanel } from "./concept/object-export-panel";
import { ExportTaggingPanel } from "./concept/export-tagging-panel";
import { MasterPagesPanel } from "./master-pages-panel";
import { PagesListPanel } from "./pages-list-panel";
import { SpreadsPanel } from "./spreads-panel";
import { TableStylesPanel } from "./table-styles-panel";
import { SwatchesPanel } from "./swatches-panel";
import { SchemaListDemoPanel } from "./schema-list-demo-panel";
import { SchemaTreeDemoPanel } from "./schema-tree-demo-panel";
import { TextFrameOptionsPanel } from "./text-frame-options-panel";
import { TextWrapPanel } from "./text-wrap-panel";
import { ParagraphPanel } from "./paragraph-panel";
import { ParagraphStylesPanel } from "./paragraph-styles-panel";
import { StrokePanel } from "./stroke-panel";
import { InspectorPanel } from "./inspector-panel";
import { LayersPanel } from "./layers-panel";
import { NavigatorPanel } from "./navigator-panel";
import { OutlinePanel } from "./outline-panel";
import { ActionsPanel } from "./actions-panel";
import { ReplPanel } from "./repl-panel";
import { ScriptEditorPanel } from "./script-editor";
import { KeyboardShortcutsPanel } from "./keyboard-shortcuts-panel";
import { ProblemsPanel } from "./problems-panel";
import { JournalPanel } from "./journal-panel";
import { LibraryPanel } from "./library-panel";
import { TreePanel } from "./tree-panel";
import { ExportCenterPanel } from "./cockpit/export-center-panel";
import { PreflightPanel } from "./cockpit/preflight-panel";
import { PublicationHealthPanel } from "./cockpit/publication-health-panel";
import { SeparationsPanel } from "./cockpit/separations-panel";
import { CommentsPanel, ComponentLibraryPanel } from "./cockpit/stub-panels";
import { StoriesPanel } from "./cockpit/stories-panel";
import { DocumentMapPanel } from "./cockpit/document-map-panel";
import { ExportInspectorPanel, OutputsPanel } from "./cockpit/export-views";
import { DataGridPanel, DataSourcePanel } from "./cockpit/data-views";
import {
  OutputReadinessPanel,
  ReviewInspectorPanel,
  StoryInspectorPanel,
} from "./cockpit/mode-inspectors";

// The built-in panels for the canvas app. Bundle authors register
// additional panels through the registry once Step 4's loader
// lands; the cockpit's Window menu surfaces every entry. The
// CANVAS itself is not a panel — it is the cockpit's viewport slot
// (`canvasComponent`).
export const BUILT_IN_PANELS: PanelContribution[] = [
  {
    id: "paged.pages",
    title: "Pages",
    component: NavigatorPanel,
    defaultDock: "left",
    defaultGroup: "structure",
  },
  // ── Cockpit panels (styleguide E) — mode-first surfaces. ──
  {
    id: "paged.export-center",
    title: "Export Center",
    component: ExportCenterPanel,
    defaultDock: "left",
    defaultGroup: "cockpit",
    icon: "ui-export",
  },
  {
    id: "paged.preflight",
    title: "Preflight",
    component: PreflightPanel,
    defaultDock: "left",
    defaultGroup: "cockpit",
    icon: "ui-target",
  },
  {
    id: "paged.separations",
    title: "Separations",
    component: SeparationsPanel,
    defaultDock: "right",
    defaultGroup: "cockpit",
    icon: "ui-swatch-fill",
  },
  {
    id: "paged.publication-health",
    title: "Health",
    component: PublicationHealthPanel,
    defaultDock: "left",
    defaultGroup: "cockpit",
    icon: "ui-warn",
  },
  {
    id: "paged.stories",
    title: "Stories",
    component: StoriesPanel,
    defaultDock: "left",
    defaultGroup: "cockpit",
    icon: "panel-character",
  },
  {
    id: "paged.comments",
    title: "Comments",
    component: CommentsPanel,
    defaultDock: "left",
    defaultGroup: "cockpit",
    icon: "ui-comment",
  },
  // U8 — the old `paged.data-mapping` ComingSoon stub is retired: the
  // LIVE paged.data bindings panel (media.paged.data.panel.bindings)
  // superseded it and nothing referenced the stub's id.
  {
    id: "paged.component-library",
    title: "Library",
    component: ComponentLibraryPanel,
    defaultDock: "right",
    defaultGroup: "cockpit",
    icon: "ui-component",
  },
  // ── Cockpit fixed-slot panels (kit left panels + per-mode right
  //    inspectors + canvas-area mains). Registered like any panel;
  //    the mode `slots` select where they render. ──
  {
    id: "paged.document-map",
    title: "Document Map",
    component: DocumentMapPanel,
    defaultDock: "left",
    defaultGroup: "cockpit",
    icon: "panel-pages",
  },
  {
    id: "paged.outputs",
    title: "Outputs",
    component: OutputsPanel,
    defaultDock: "left",
    defaultGroup: "cockpit",
    icon: "ui-export",
  },
  {
    // U8 — the LIVE paged.data plugin panels own the data surface;
    // this built-in stays only as the honest data-suite seam, titled
    // so it can't be mistaken for the live plugin panel.
    id: "paged.data-source",
    title: "Data suite (preview)",
    component: DataSourcePanel,
    defaultDock: "left",
    defaultGroup: "cockpit",
    icon: "ui-database",
    // No longer OFFERED in Window: "not connected" / "coming soon" beside
    // the live Data sources panel read as a second, broken data surface.
    // Still registered and openable (specs, the palette).
    devOnly: true,
  },
  {
    id: "paged.data-grid",
    title: "Generated pages",
    component: DataGridPanel,
    defaultDock: "center",
    defaultGroup: "cockpit",
    icon: "ui-bolt",
    // Same: a ComingSoon card that overlapped paged.data's live panels.
    devOnly: true,
  },
  {
    id: "paged.story-inspector",
    title: "Story",
    component: StoryInspectorPanel,
    defaultDock: "right",
    defaultGroup: "cockpit",
    icon: "panel-paragraph",
  },
  {
    id: "paged.output-readiness",
    title: "Output readiness",
    component: OutputReadinessPanel,
    defaultDock: "right",
    defaultGroup: "cockpit",
    icon: "ui-target",
  },
  {
    id: "paged.review-inspector",
    title: "Review",
    component: ReviewInspectorPanel,
    defaultDock: "right",
    defaultGroup: "cockpit",
    icon: "ui-pin",
  },
  {
    id: "paged.export-inspector",
    title: "Export settings",
    component: ExportInspectorPanel,
    defaultDock: "right",
    defaultGroup: "cockpit",
    icon: "ui-export",
  },
  // NOTE: the old `paged.tools` dock panel is retired — the left
  // ToolRail (shell chrome, Concept 1 AC-9) is the only tool surface.
  {
    // SDK Phase 5 (named sweep) — Links list. Read-only expert
    // leaf consuming useCollection<LinkSummary>("links"). Per-row
    // relocate / update / break actions land with their
    // Operations.
    id: "paged.links",
    title: "Links",
    component: LinksPanel,
    defaultDock: "left",
    defaultGroup: "structure",
  },
  {
    // SDK Phase 5 (v1 sweep) — Conditions list. Read-only expert
    // leaf consuming useCollection<ConditionSummary>("conditions").
    // Per-condition visibility toggle lands with
    // `Operation::SetConditionVisible`.
    id: "paged.conditions",
    title: "Conditions",
    component: ConditionsPanel,
    defaultDock: "left",
    defaultGroup: "structure",
  },
  {
    id: "paged.condition-sets",
    title: "Condition Sets",
    component: ConditionSetsPanel,
    defaultDock: "left",
    defaultGroup: "structure",
  },
  {
    id: "paged.color-groups",
    title: "Color groups",
    component: ColorGroupsPanel,
    defaultDock: "right",
    defaultGroup: "styles",
  },
  {
    id: "paged.ink-manager",
    title: "Ink Manager",
    component: InkManagerPanel,
    defaultDock: "right",
    defaultGroup: "styles",
  },
  {
    id: "paged.color-settings",
    title: "Color settings",
    component: ColorSettingsPanel,
    defaultDock: "right",
    defaultGroup: "styles",
  },
  // ADR 323 — schema-driven options over object-model addresses
  // (style definitions, the document, pages, swatches, text variables,
  // sections, guides). Every field is a PropertyField on the address.
  {
    id: STYLE_OPTIONS_PANEL,
    title: "Style Options",
    component: StyleOptionsPanel,
    defaultDock: "right",
    defaultGroup: "styles",
  },
  {
    id: "paged.object-options",
    title: "Object Options",
    component: ObjectOptionsPanel,
    defaultDock: "right",
    defaultGroup: "properties",
  },
  {
    id: "paged.document-setup",
    title: "Document Setup",
    component: DocumentSetupPanel,
    defaultDock: "right",
    defaultGroup: "structure",
  },
  {
    id: "paged.margins-columns",
    title: "Margins and Columns",
    component: MarginsColumnsPanel,
    defaultDock: "right",
    defaultGroup: "structure",
  },
  {
    id: "paged.swatch-options",
    title: "Swatch Options",
    component: SwatchOptionsPanel,
    defaultDock: "right",
    defaultGroup: "styles",
  },
  {
    id: "paged.gradient-options",
    title: "Gradient Options",
    component: GradientOptionsPanel,
    defaultDock: "right",
    defaultGroup: "styles",
  },
  {
    id: "paged.text-variables",
    title: "Text Variables",
    component: TextVariablesPanel,
    defaultDock: "right",
    defaultGroup: "structure",
  },
  {
    id: "paged.color-group-options",
    title: "Color Group Options",
    component: ColorGroupOptionsPanel,
    defaultDock: "right",
    defaultGroup: "styles",
  },
  {
    id: "paged.numbering-list-options",
    title: "Numbering List Options",
    component: NumberingListOptionsPanel,
    defaultDock: "right",
    defaultGroup: "styles",
  },
  {
    id: "paged.condition-options",
    title: "Condition Options",
    component: ConditionOptionsPanel,
    defaultDock: "right",
    defaultGroup: "structure",
  },
  {
    id: "paged.master-options",
    title: "Master Options",
    component: MasterOptionsPanel,
    defaultDock: "right",
    defaultGroup: "structure",
  },
  {
    id: "paged.text-fields",
    title: "Text Fields",
    component: FieldOptionsPanel,
    defaultDock: "right",
    defaultGroup: "structure",
  },
  {
    id: "paged.section-options",
    title: "Numbering & Section Options",
    component: SectionOptionsPanel,
    defaultDock: "right",
    defaultGroup: "structure",
  },
  {
    id: "paged.guides",
    title: "Guides",
    component: GuidesPanel,
    defaultDock: "right",
    defaultGroup: "structure",
  },
  {
    id: "paged.articles",
    title: "Articles",
    component: ArticlesPanel,
    defaultDock: "left",
    defaultGroup: "structure",
  },
  {
    id: "paged.hyperlinks",
    title: "Hyperlinks",
    component: HyperlinksPanel,
    defaultDock: "left",
    defaultGroup: "structure",
  },
  {
    id: "paged.bookmarks",
    title: "Bookmarks",
    component: BookmarksPanel,
    defaultDock: "left",
    defaultGroup: "structure",
  },
  {
    id: "paged.cross-references",
    title: "Cross References",
    component: CrossReferencesPanel,
    defaultDock: "left",
    defaultGroup: "structure",
  },
  {
    id: "paged.index",
    title: "Index",
    component: IndexPanel,
    defaultDock: "left",
    defaultGroup: "structure",
  },
  // ── SDK Phase 5 (v1 sweep) — Wave 1 structural-collection
  // panels. Each is a read-only list backed by the matching
  // documentCollection accessor.
  {
    id: "paged.pages-list",
    title: "Pages list",
    component: PagesListPanel,
    defaultDock: "left",
    defaultGroup: "structure",
  },
  {
    id: "paged.spreads",
    title: "Spreads",
    component: SpreadsPanel,
    defaultDock: "left",
    defaultGroup: "structure",
  },
  {
    id: "paged.master-pages",
    title: "Master Pages",
    component: MasterPagesPanel,
    defaultDock: "left",
    defaultGroup: "structure",
  },
  {
    id: "paged.cell-styles",
    title: "Cell Styles",
    component: CellStylesPanel,
    defaultDock: "right",
    defaultGroup: "styles",
  },
  {
    id: "paged.table-styles",
    title: "Table Styles",
    component: TableStylesPanel,
    defaultDock: "right",
    defaultGroup: "styles",
  },
  {
    id: "paged.fonts",
    title: "Fonts",
    component: FontsPanel,
    defaultDock: "left",
    defaultGroup: "structure",
  },
  {
    // SDK Phase 5 (v1 sweep) — Align palette. Reads element
    // selection + each frame's bounds, dispatches N SetProperty
    // mutations to align. v1 limitation: each frame is its own
    // undo entry (wire-level Batch lands as a follow-up).
    id: "paged.align",
    title: "Align",
    component: AlignPanel,
    defaultDock: "right",
    defaultGroup: "properties",
  },
  {
    // SDK Phase 5 (v1 sweep) — Pathfinder. v1 ships Union via
    // BBox math; Subtract / Intersect / Exclude buttons exist
    // but are disabled (need Bezier CSG, v2).
    id: "paged.pathfinder",
    title: "Pathfinder",
    component: PathfinderPanel,
    defaultDock: "right",
    defaultGroup: "properties",
  },
  {
    id: "paged.outline",
    title: "Outline",
    component: OutlinePanel,
    defaultDock: "left",
    defaultGroup: "structure",
  },
  {
    id: "paged.tree",
    title: "Tree",
    component: TreePanel,
    defaultDock: "left",
    defaultGroup: "structure",
  },
  {
    id: "paged.inspector",
    title: "Inspector",
    component: InspectorPanel,
    defaultDock: "right",
    defaultGroup: "inspector",
  },
  {
    // SDK Phase 3 — Character panel rendered as a declarative
    // composition over `@paged-media/catalog`. Bindings target content-
    // scope (the current text selection mapped to an
    // ElementId.storyRange); the apply arm at
    // (NodeId::StoryRange, Character*) commits each edit.
    id: "paged.character",
    title: "Character",
    component: CharacterPanel,
    defaultDock: "right",
    defaultGroup: "properties",
  },
  {
    // SDK Phase 3 — Paragraph panel. Content-scope bindings;
    // apply layer rounds the range to whole paragraphs.
    id: "paged.paragraph",
    title: "Paragraph",
    component: ParagraphPanel,
    defaultDock: "right",
    defaultGroup: "properties",
  },
  {
    // SDK Phase 5 — Paragraph Styles list (expert leaf, hybrid
    // candidate). Reads documentCollection:paragraphStyles;
    // applies via appliedParagraphStyle write. Per the
    // panel-catalog doc §5.3 + §5.5.
    id: "paged.paragraph-styles",
    title: "Paragraph Styles",
    component: ParagraphStylesPanel,
    defaultDock: "right",
    defaultGroup: "styles",
  },
  {
    // SDK Phase 5 — Character Styles. Direct twin of
    // Paragraph Styles using the same PAGED_INPUT_COLLECTION_SELECT
    // primitive with collectionName: "characterStyles" + a
    // content-scope binding to appliedCharacterStyle. Validates
    // the §9 ≥2-panels rule for the new primitive.
    id: "paged.character-styles",
    title: "Character Styles",
    component: CharacterStylesPanel,
    defaultDock: "right",
    defaultGroup: "styles",
  },
  {
    // SDK Phase 5 (v1 sweep) — Object Styles. Element-scope
    // binding to appliedObjectStyle (uses the apply arm shipped
    // with Track A's Task G). collectionName: "objectStyles"
    // routes through the new model accessor.
    id: "paged.object-styles",
    title: "Object Styles",
    component: ObjectStylesPanel,
    defaultDock: "right",
    defaultGroup: "styles",
  },
  {
    // SDK Phase 5 (named sweep) — Swatches. Validates the
    // `valueType: "colorRef"` extension to
    // PAGED_INPUT_COLLECTION_SELECT — same primitive that drives
    // Paragraph / Character / Object Styles, now writing a
    // Value::ColorRef payload. Element-scope binding to
    // frameFillColor.
    id: "paged.swatches",
    title: "Swatches",
    component: SwatchesPanel,
    defaultDock: "right",
    defaultGroup: "styles",
  },
  {
    // B-01/G3 (schema v1.1) — the list-widget + applyEntity CONSUMER
    // PROOF: a schema-driven panel over the REAL swatches collection
    // (row selection published back as a binding; Fill = applyEntity
    // write, Stroke = command dispatch with the row id as payload).
    // Rendered through the SAME SchemaPanelRenderer the bundle host
    // injects. Driven by tests/e2e/schema-list-panel.spec.ts.
    id: "paged.schema-list-demo",
    devOnly: true,
    title: "Swatch list (schema)",
    component: SchemaListDemoPanel,
    defaultDock: "right",
    defaultGroup: "styles",
  },
  {
    // Schema v1.2 — the TREE ROWS / DRAG-REORDER / INLINE RENAME
    // consumer proof (ADR 023 phase B). Two declared lists: the real
    // scene outline as a tree whose drag emits the engine's
    // `reorderElement`, and the live `layers` collection whose rename
    // and reorder go through commands (`layerSetName` / `layerMove`
    // are dedicated ops, not property writes). NOT the Layers panel —
    // phase C owns that. Driven by tests/e2e/schema-tree-panel.spec.ts.
    id: "paged.schema-tree-demo",
    devOnly: true,
    title: "Structure (schema tree)",
    component: SchemaTreeDemoPanel,
    defaultDock: "right",
    defaultGroup: "styles",
  },
  {
    // SDK Phase 5 (v1 sweep) — Color editor. Fill swatch picker
    // + fill tint scrub. Complements Swatches (the palette
    // browser) per `docs/design/panel-catalog.md` §6
    // Tier 2b. CMYK/RGB sliders are v2.
    id: "paged.color",
    title: "Color",
    component: ColorPanel,
    defaultDock: "right",
    defaultGroup: "styles",
  },
  {
    // Panel-gallery pass — the colour wheel (brand kit
    // color-wheel.jsx, fully live). HSV wheel + value track,
    // HEX/RGB/CMYK/HSL synced fields, colour-theory harmonies;
    // "Add to Swatches" lands the palette as real swatches via
    // one batched createSwatch (single undo). Also reachable
    // from the Color panel.
    id: "paged.color-wheel",
    title: "Color Wheel",
    component: ColorWheelPanel,
    defaultDock: "right",
    defaultGroup: "styles",
    icon: "panel-color",
  },
  {
    // SDK Phase 5 (v1 sweep) — Gradients. Direct twin of Swatches
    // but reading documentCollection:gradients. Both gradients
    // and swatches commit through the same FrameFillColor apply
    // arm (Value::ColorRef payload carrying either a Swatch or
    // Gradient self_id).
    id: "paged.gradients",
    title: "Gradients",
    component: GradientsPanel,
    defaultDock: "right",
    defaultGroup: "styles",
  },
  {
    // SDK Phase 3 — Stroke panel as a declarative composition.
    // Element-scope bindings over existing FrameStrokeWeight +
    // FrameStrokeColor apply arms.
    id: "paged.stroke",
    title: "Stroke",
    component: StrokePanel,
    defaultDock: "right",
    defaultGroup: "properties",
  },
  {
    // SDK Phase 3 — Object/Transform panel. Element-scope bindings
    // over FrameBounds + FrameOpacity.
    id: "paged.object-transform",
    title: "Object",
    component: ObjectTransformPanel,
    defaultDock: "right",
    defaultGroup: "properties",
  },
  {
    // SDK Phase 5 (v1 sweep) — Text Frame Options. Element-scope
    // binding to frameInsetSpacing (the [top, left, bottom, right]
    // in pt). Vertical-justify + columns + auto-sizing rows join
    // as their apply arms ship.
    id: "paged.text-frame-options",
    title: "Text Frame",
    component: TextFrameOptionsPanel,
    defaultDock: "right",
    defaultGroup: "properties",
  },
  {
    // SDK Phase 5 (v1 sweep) — Text Wrap. Element-scope bindings
    // to frameTextWrapMode (toggle-group) + frameTextWrapOffsets
    // (bounds). Both share the same Option<TextWrap> backing
    // field — the apply layer preserves the unset half.
    id: "paged.text-wrap",
    title: "Text Wrap",
    component: TextWrapPanel,
    defaultDock: "right",
    defaultGroup: "properties",
  },
  {
    // SDK Phase 5 (v1 sweep) — Frame Fitting. Rectangle-only.
    // Two rows on the shared Option<FrameFittingOption> field
    // (type toggle-group + crops bounds). Apply arms preserve
    // the unset half.
    id: "paged.frame-fitting",
    title: "Frame Fitting",
    component: FrameFittingPanel,
    defaultDock: "right",
    defaultGroup: "properties",
  },
  {
    // SDK Phase 5 (named sweep) — Effects (v1 stub). Drop-shadow
    // enabled toggle only; the apply layer materialises a default
    // DropShadowSetting on true. Per-field editors (color,
    // offset, blur) land when their PropertyPaths ship.
    id: "paged.effects",
    title: "Effects",
    component: EffectsPanel,
    defaultDock: "right",
    defaultGroup: "properties",
  },
  {
    id: "paged.layers",
    title: "Layers",
    component: LayersPanel,
    defaultDock: "right",
    defaultGroup: "inspector",
  },
  {
    // SDK Phase 5 (v1 sweep) — read-only document info. Expert
    // leaf wrapping `useDocumentMeta()`. Per the
    // `docs/design/panel-catalog.md` §6 Tier 5 + §5.6.
    id: "paged.info",
    title: "Info",
    component: InfoPanel,
    defaultDock: "right",
    defaultGroup: "inspector",
  },
  {
    // SDK Phase 5 (v1 sweep) — Attributes editor. v1 surface
    // is the Nonprinting toggle. Per `panel-catalog-and-sdk-
    // extension.md` §6 Tier 5.
    id: "paged.attributes",
    title: "Attributes",
    component: AttributesPanel,
    defaultDock: "right",
    defaultGroup: "inspector",
  },
  {
    // SDK Phase 5 (v1 sweep) — Properties context router. Per
    // `docs/design/panel-catalog.md` §6 Tier 6 — the
    // "Properties" idiom. Composes Object Transform + Stroke
    // (element scope) and Character + Paragraph (content scope)
    // conditionally on selection state.
    id: "paged.properties",
    title: "Properties",
    component: PropertiesPanel,
    defaultDock: "right",
    defaultGroup: "properties",
  },
  {
    // ADR 221 — the one place Claude works: Ask (diagnosis, suggestions,
    // requests), New document from a brief, and each run's progress.
    id: "paged.ai-assistant",
    title: "AI Assistant",
    component: AIAssistant,
    defaultDock: "right",
    defaultGroup: "properties",
  },
  {
    // SDK Phase 5 (v1 sweep) — Control bar. Horizontal-strip
    // variant of Properties (same compositions, scrollable row
    // layout). Per `docs/design/panel-catalog.md` §6
    // Tier 6.
    id: "paged.control",
    title: "Control",
    component: ControlPanel,
    defaultDock: "bottom",
    defaultGroup: "chrome",
  },
  {
    id: "paged.repl",
    devOnly: true,
    title: "REPL",
    component: ReplPanel,
    defaultDock: "bottom",
    defaultGroup: "console",
  },
  {
    // A designer surface since the Ask bar (ADR 221): Claude writes the
    // script, so it no longer takes a developer to use it.
    id: "paged.script-editor",
    title: "Script",
    component: ScriptEditorPanel,
    defaultDock: "bottom",
    defaultGroup: "console",
  },
  {
    // Actions — record/replay a command sequence. Sits beside the REPL
    // and the script editor because it is the third member of the
    // automation family (Illustrator's "scripting / actions / plugins"
    // row); the recorder itself lives in the shell, above the dock.
    id: "paged.actions",
    title: "Actions",
    component: ActionsPanel,
    defaultDock: "right",
    defaultGroup: "console",
    icon: "panel-actions",
  },
  {
    id: "paged.keyboard-shortcuts",
    title: "Keyboard shortcuts",
    component: KeyboardShortcutsPanel,
    defaultDock: "right",
    defaultGroup: "workspace",
  },
  {
    // paged.web W-05 — the host problems panel: consumes
    // `host.diagnostics` from EVERY loaded bundle via the injected
    // sink (problems-store), not just inline in a plugin's own panel.
    id: "paged.problems",
    title: "Problems",
    component: ProblemsPanel,
    defaultDock: "bottom",
    defaultGroup: "console",
  },
  {
    // ADR 025 — the journal: a LOCAL flight recorder. Sits beside Problems
    // because they are the two halves of the same question and are read
    // together: Problems is what is wrong with the DOCUMENT, the journal is
    // what the PROGRAM did. Nothing here is ever transmitted.
    id: "paged.journal",
    title: "Journal",
    component: JournalPanel,
    defaultDock: "bottom",
    defaultGroup: "console",
  },
  {
    // ADR 180 — the local library: this document's versions (save = a
    // version; restore commits an old one again on top) and every document
    // kept in the browser's private file system.
    id: "paged.library",
    title: "Library",
    component: LibraryPanel,
    defaultDock: "right",
  },
  // ── Panel-gallery pass — CONCEPT panels (INDESIGN_PARITY.md).
  //    The four ●●● parity surfaces + the two in-scope output/a11y
  //    surfaces, shipped as kit-shaped honest seams with Concept
  //    badges + Target footnotes so the roadmap reads honestly.
  //    Window-menu reachable like every registered panel. ────────
  {
    // W3.A2 — LIVE Table panel: cell fill/insets/vert-justify/applied
    // styles + table style + row-height/col-width + insert/delete
    // row/column, driven by the table cell selection. Cell text edit
    // and row/col counts remain engine-v1 gaps (noted in-panel).
    id: "paged.table",
    title: "Table",
    component: TablePanel,
    defaultDock: "right",
    defaultGroup: "text",
    icon: "panel-table-styles",
  },
  {
    // W2.4 — LIVE: the stop editor rides the whole-list
    // `paragraphTabStops` path (protocol v28).
    id: "paged.tabs",
    title: "Tabs",
    component: TabsPanel,
    defaultDock: "right",
    defaultGroup: "text",
    icon: "ui-flow",
  },
  {
    // PARTIALLY LIVE — the glyph grid inserts via insertText at
    // the caret; font scope awaits the font registry.
    id: "paged.glyphs",
    title: "Glyphs",
    component: GlyphsPanel,
    defaultDock: "right",
    defaultGroup: "text",
    icon: "panel-character",
  },
  {
    // W2.4 — PARTIALLY LIVE: list type + bullet glyph + numbering
    // format ride the v28 list-authoring text paths; list
    // definitions / level / position remain seams.
    id: "paged.bullets-numbering",
    title: "Bullets & Numbering",
    component: BulletsPanel,
    defaultDock: "right",
    defaultGroup: "text",
    icon: "ui-rows",
  },
  {
    // W2.12 — LIVE: anchored-object position controls for a frame
    // anchored into a text story (the W1.16 AnchoredObjectSetting
    // surface). Non-anchored selection states it honestly.
    id: "paged.anchored",
    title: "Anchored Object",
    component: AnchoredPanel,
    defaultDock: "right",
    defaultGroup: "object",
    icon: "ui-pin",
  },
  {
    // Per-object alt text / tagged-PDF role / EPUB conversion —
    // the accessible-output surface (in scope per the parity doc).
    id: "paged.object-export",
    title: "Object Export Options",
    component: ObjectExportPanel,
    defaultDock: "right",
    defaultGroup: "output",
    icon: "ui-accessibility",
  },
  {
    // Style → HTML tag/CSS class/PDF tag mapping for EPUB + tagged
    // PDF.
    id: "paged.export-tagging",
    title: "Export Tagging",
    component: ExportTaggingPanel,
    defaultDock: "right",
    defaultGroup: "output",
    icon: "ui-export",
  },
];
