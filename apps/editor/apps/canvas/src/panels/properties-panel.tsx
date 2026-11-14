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

// Cockpit — the Properties tab: the kit's CONTEXT INSPECTOR
// (inspectors.jsx — swaps Text / Image / Frame / Page by what's
// selected). Routing layer over the existing engine-backed
// compositions; no new bindings, no new wire:
//
//   - Content selection (caret/range)  ⇒ Text: Character + Paragraph.
//   - Element(s) whose geometry hosts a placed image ⇒ Image:
//     Object Transform + Frame fitting + Stroke.
//   - Other element(s) ⇒ Frame: Object Transform + Stroke (+ the
//     text-frame compositions ride the content selection). Titled
//     "Group" for groups, "Objects" for groups and frames together.
//   - Nothing selected ⇒ the panel-rail steer (`inspectorContext`)
//     picks the Page summary or a per-kind guidance hint.
//
// The AI Assistant lives in its own panel (ADR 221); this one links to it.
//
// Track FI2 (editor ADR 1217, the UX strategy's §5.3–5.5): a search field
// finds a property by its label, a synonym or a plugin row's text and
// opens the section that holds it; the sections are grouped Frame /
// Content / Text, common ones open and advanced ones collapsed, as the user
// left them per kind; a multi-selection says what it holds ("3 objects · 2
// text frames, 1 image"), and a section that applies to part of it says so
// ("Applies to 2 of 3") and edits that part only (D-16).

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import type { CompositionNode } from "@paged-media/catalog";
import type { ElementGeometryItem, ElementId } from "@paged-media/client";
import {
  formatLength,
  formatLengthPair,
  useDocumentUnit,
} from "@paged-media/ui";
import {
  CatalogRegistryProvider,
  CockpitBtn,
  openAssistant,
  useEditorScope,
  CockpitPanelHeader,
  CockpitRow,
  CockpitSection,
  CockpitValue,
  CompositionRenderer,
  compositionTerms,
  Icon,
  keywordTerms,
  matchesQuery,
  normalizeSearch,
  PanelHost,
  PropertySearchProvider,
  SelectionSubset,
  useCollection,
  useContentSelection,
  useDocument,
  useOptionalCockpitState,
  useSelection,
  useSelectionMetadataOwner,
  useSelectionObjectType,
  useOptionalCanvasClient,
  useOptionalThreading,
} from "@paged-media/shell";

import { groupMembersOf } from "../object-commands";
import { appCatalogRegistry } from "./catalog-registry";
import { characterComposition } from "./character.composition";
import { frameFittingComposition } from "./frame-fitting.composition";
import { objectTransformComposition } from "./object-transform.composition";
import { paragraphComposition } from "./paragraph.composition";
import { strokeComposition } from "./stroke.composition";
import { AnchorPointsSection } from "./anchor-points-section";
import { ShapeSuggestionsSection } from "./shape-suggestions-section";
import { defineMessages, useStrings } from "@paged-media/strings";

import {
  useInspectorDisclosure,
  type InspectorDisclosure,
  type SectionLevel,
} from "./inspector/inspector-disclosure";

const M = defineMessages("app.propertiesPanel", {
  frame: "Frame",
  group: "Group",
  objects: "Objects",
  text: "Text",
  image: "Image",
  page: "Page",
  points: "Points",
  shapeSuggestions: "Shape suggestions",
  kwPoints:
    "point, points, anchor, anchors, corner, smooth, align, average, delete, x, y",
  kwShape:
    "suggestion, round corners, smooth, simplify, offset, repeat, mirror, shape",
  properties: "Properties",
  objectCount: "{count, plural, one {# object} other {# objects}}",
  groupCount: "{count, plural, one {# group} other {# groups}}",
  frameCount: "{count, plural, one {# frame} other {# frames}}",
  textSelection: "Text selection",
  oversetTitle:
    "This frame's story does not fit — text continues past the last frame in its chain",
  fitsTitle: "This frame's story fits",
  overset: "overset",
  oversetNo: "overset · no",
  empty: "Select a frame or place a text caret to see its properties.",
  editInPlace: "{type} — double-click to edit in place.",
  noImage:
    "The selection holds no placed image. File ▸ Place… puts one in the selected frame.",
  askAssistant: "Ask the AI Assistant…",
  geometry: "Geometry",
  pages: "Pages",
  size: "Size",
  margins: "Margins",
  columns: "Columns",
  bleed: "Bleed",
  columnsValue: "{count} · gutter {gutter}",
  search: "Search properties",
  clearSearch: "Clear the search",
  noMatch: "No property matches “{query}”.",
  groupFrame: "Frame",
  groupContent: "Content",
  groupText: "Text",
  sectionTransform: "Transform",
  sectionStroke: "Stroke",
  sectionFitting: "Fitting",
  sectionCharacter: "Character",
  sectionParagraph: "Paragraph",
  kwTransform:
    "position, x, y, width, height, size, rotation, angle, scale, flip, bounds, geometry, opacity, transparency, corner",
  kwStroke:
    "stroke, border, outline, line, weight, thickness, dash, arrow, arrowhead, cap, join, miter, gap",
  kwFitting:
    "fit, fitting, crop, scale image, auto fit, frame fitting, fill frame, center content",
  kwCharacter:
    "font, typeface, family, size, type size, tracking, letter spacing, kerning, leading, line height, line spacing, style, case, baseline, skew, language",
  kwParagraph:
    "paragraph, alignment, align, justify, indent, space before, space after, drop cap, keep, keep with next, columns, span, hyphenation, rule",
  kwContent: "content, object, settings, plugin",
  appliesTo: "Applies to {count} of {total}",
  selectThese: "Select these",
  kindTextFrame: "{count, plural, one {# text frame} other {# text frames}}",
  kindImage: "{count, plural, one {# image} other {# images}}",
  kindRectangle: "{count, plural, one {# rectangle} other {# rectangles}}",
  kindEllipse: "{count, plural, one {# ellipse} other {# ellipses}}",
  kindPolygon: "{count, plural, one {# polygon} other {# polygons}}",
  kindLine: "{count, plural, one {# line} other {# lines}}",
  kindGroup: "{count, plural, one {# group} other {# groups}}",
  kindOther: "{count, plural, one {# other object} other {# other objects}}",
  nameTextFrame: "Text frame",
  nameImage: "Image",
  nameRectangle: "Rectangle",
  nameEllipse: "Ellipse",
  namePolygon: "Polygon",
  nameLine: "Line",
  nameGroup: "Group",
  nameOther: "Object",
  showObjects: "Show the objects",
  hideObjects: "Hide the objects",
  selectOnly: "Select only this one",
  relativeHint:
    "Type +=5 mm or *110% in a field to change each object by its own value.",
});

type InspectorKind = "text" | "image" | "frame" | "page" | "points" | "none";

/** The path kinds the Shape suggestions apply to (paged.draw ADR 370). */
const SHAPE_KINDS = new Set(["polygon", "rectangle", "graphicLine"]);
type Group = "frame" | "content" | "text";

/** One section of the inspector. */
interface SectionDef {
  /** `data-properties-section`. */
  id: string;
  group: Group;
  level: SectionLevel;
  title: string;
  /** A composition it renders (its labels are searched). */
  composition?: CompositionNode;
  /** Or a body of its own (a plugin's panel; its text is searched). */
  body?: ReactNode;
  /** Synonyms and keywords, comma-separated (a localized message). */
  keywords: string;
  /** For a multi-selection: the objects it applies to (D-16). */
  applies?: (geometry: ElementGeometryItem | undefined) => boolean;
  attrs?: Record<string, string>;
}

const GROUP_TITLE: Record<Group, string> = {
  frame: M.groupFrame,
  content: M.groupContent,
  text: M.groupText,
};

export function PropertiesPanel() {
  const scope = useEditorScope();
  const strings = useStrings();
  const {
    elementSelection,
    elementGeometry,
    pathEditMode,
    pathEditSession,
    selectedAnchors,
  } = useSelection();
  const { contentSelection } = useContentSelection();
  const cockpit = useOptionalCockpitState();
  // Plugin-owned content: SELECTING a classified object (webFrame,
  // sheetFrame, wordDocument, …) now surfaces the owning bundle in the
  // inspector — previously object types were consulted only on
  // double-click (the edit-context entry chain).
  const owned = useSelectionObjectType();
  // Artwork a plugin made or annotated without an object type of its own
  // (paged.draw's repeats, blends, styled paths): that plugin's surface,
  // inline — the "Draw settings" panel used to be a separate tab only.
  const metadataOwner = useSelectionMetadataOwner();

  const hasElement = elementSelection.length > 0;
  const hasContent = !!contentSelection;
  const hasImage =
    hasElement &&
    elementGeometry.some(
      (g) => (g as { hasImage?: boolean }).hasImage === true,
    );

  // D1 — the frame whose overset state the chip reports. A text caret
  // means the content selection's frame; a frame selection means that
  // frame. Null when neither, which is why the chip renders only when
  // it has something real to say rather than showing a dash.
  const threading = useOptionalThreading();
  // `ElementId.id` is a union — a StoryRange carries a struct, not a
  // string — and narrowing on `kind` does not narrow it, so the string
  // check is the narrowing.
  const oversetFrameId = (() => {
    const hit = elementGeometry.find((g) => g.id.kind === "textFrame");
    return typeof hit?.id.id === "string" ? hit.id.id : null;
  })();

  // Live selection wins; the panel-rail steer covers the empty case —
  // and one more. The rail's Image button pressed with a frame selected
  // used to change nothing at all (the selection won, so the click had
  // no visible effect). It now opens the Image inspector for THAT
  // selection, which says plainly when the frame holds no image. The
  // steer is pinned to the selection it was pressed on, so picking
  // something else falls back to what that is.
  const steer = cockpit?.inspectorContext ?? null;
  const selectionKey = JSON.stringify(elementSelection);
  // The selection a steer was pressed on, kept in state and moved during
  // render when the steer changes (React's pattern for state that follows
  // a prop; a ref written during render keeps the component uncompiled).
  const [steerAt, setSteerAt] = useState({ steer, key: selectionKey });
  if (steerAt.steer !== steer) setSteerAt({ steer, key: selectionKey });
  const pinnedKey = steerAt.steer === steer ? steerAt.key : selectionKey;
  const imageSteer = steer === "image" && pinnedKey === selectionKey;
  // Anchors selected inside the path being edited: the points, not the
  // frame (the UX strategy's §7.1; paged.draw ADR 370).
  const pointsSelected =
    pathEditMode && pathEditSession !== null && selectedAnchors.length > 0;
  const kind: InspectorKind = pointsSelected
    ? "points"
    : hasContent
      ? "text"
      : hasImage
        ? "image"
        : hasElement
          ? imageSteer
            ? "image"
            : "frame"
          : (steer ?? "none");

  // A group is not a frame: InDesign names it "Group". A selection of
  // groups and frames together is named for both.
  const groups = elementSelection.filter((id) => id.kind === "group").length;
  const frames = elementSelection.length - groups;
  const noun =
    groups === 0
      ? strings.t(M.frame)
      : frames === 0
        ? strings.t(M.group)
        : strings.t(M.objects);
  const loneGroup =
    groups === 1 && frames === 0 ? groupIdOf(elementSelection[0]) : null;
  const members = useGroupMemberCount(loneGroup, elementGeometry);

  const ownedTitle =
    kind === "frame" && owned ? humanizeType(owned.objectType.type) : null;
  const title =
    ownedTitle ??
    (kind === "text"
      ? strings.t(M.text)
      : kind === "image"
        ? strings.t(M.image)
        : kind === "frame"
          ? noun
          : kind === "page"
            ? strings.t(M.page)
            : kind === "points"
              ? strings.t(M.points)
              : strings.t(M.properties));

  // The gallery's selection sub-header — "Text · 1 frame", "Group · 2
  // objects" (a lone group counts what is in it).
  const counted = loneGroup
    ? members === null
      ? null
      : strings.t(M.objectCount, { count: members })
    : [
        groups > 0 ? strings.t(M.groupCount, { count: groups }) : null,
        frames > 0 ? strings.t(M.frameCount, { count: frames }) : null,
      ]
        .filter(Boolean)
        .join(", ");
  const selectionLabel =
    kind === "points"
      ? null
      : kind === "text"
        ? strings.t(M.textSelection)
        : hasElement
          ? [kind === "image" ? strings.t(M.image) : noun, counted]
              .filter(Boolean)
              .join(" · ")
          : null;

  // The sections, in the order they are offered (grouped when shown).
  const sections: SectionDef[] = [];
  const typeSections = () => {
    sections.push(
      {
        id: "character",
        group: "text",
        level: "common",
        title: strings.t(M.sectionCharacter),
        composition: characterComposition(strings),
        keywords: strings.t(M.kwCharacter),
      },
      {
        id: "paragraph",
        group: "text",
        level: "common",
        title: strings.t(M.sectionParagraph),
        composition: paragraphComposition(strings),
        keywords: strings.t(M.kwParagraph),
      },
    );
  };
  // PN-22 (UX F-37): with a caret or a text range the type settings lead,
  // as InDesign's Properties panel puts Character and Paragraph first in
  // text context; the frame's Object and Stroke sections follow.
  if (kind === "text") typeSections();
  if (kind === "frame" && owned) {
    sections.push({
      id: "object-type",
      group: "content",
      level: "common",
      title: humanizeType(owned.objectType.type),
      keywords: strings.t(M.kwContent),
      attrs: { "data-object-type": owned.objectType.type },
      body: owned.editContext?.panelIds?.length ? (
        // The owning bundle's inspector surface, inline — the same
        // registered panel the edit context raises.
        <PanelHost id={owned.editContext.panelIds[0]} />
      ) : (
        <div
          className="pg-ui-xs"
          style={{ padding: "4px 2px", opacity: 0.7, lineHeight: 1.5 }}
        >
          {strings.t(M.editInPlace, {
            type: humanizeType(owned.objectType.type),
          })}
        </div>
      ),
    });
  }
  if (kind === "frame" && !owned && metadataOwner?.panelIds?.[0]) {
    sections.push({
      id: "plugin-owned",
      group: "content",
      level: "common",
      title: humanizeType(metadataOwner.type),
      keywords: strings.t(M.kwContent),
      attrs: { "data-properties-owner": metadataOwner.type },
      body: <PanelHost id={metadataOwner.panelIds[0]} />,
    });
  }
  // paged.draw ADR 370 — the selected anchors, in place of the frame's
  // sections.
  if (kind === "points") {
    sections.push({
      id: "points",
      group: "content",
      level: "common",
      title: strings.t(M.points),
      keywords: strings.t(M.kwPoints),
      body: <AnchorPointsSection session={pathEditSession} />,
    });
  }
  if (hasElement && kind !== "points") {
    const transform = objectTransformComposition(strings);
    sections.push({
      id: "object",
      group: "frame",
      level: "common",
      title: strings.t(M.sectionTransform),
      // The section's header names it; the composition's kicker goes.
      composition: {
        ...transform,
        props: { ...transform.props, heading: false },
      },
      keywords: strings.t(M.kwTransform),
    });
  }
  if (kind === "image" && hasImage) {
    sections.push({
      id: "fitting",
      group: "content",
      level: "common",
      title: strings.t(M.sectionFitting),
      composition: frameFittingComposition(strings),
      keywords: strings.t(M.kwFitting),
      // Fitting is about the picture: it applies to the frames holding
      // one, and beside others it says so and edits those (D-16).
      applies: (g) =>
        (g as { hasImage?: boolean } | undefined)?.hasImage === true,
    });
  }
  if (hasElement && kind !== "points") {
    sections.push({
      id: "stroke",
      group: "frame",
      // With text in hand the frame's stroke is the rare setting (the
      // strategy's §5.4): collapsed until opened.
      level: kind === "text" ? "advanced" : "common",
      title: strings.t(M.sectionStroke),
      composition: strokeComposition(strings),
      keywords: strings.t(M.kwStroke),
    });
  }
  // paged.draw ADR 370 — quick actions for one selected path.
  if (
    kind === "frame" &&
    elementSelection.length === 1 &&
    SHAPE_KINDS.has(elementSelection[0].kind)
  ) {
    sections.push({
      id: "shape-suggestions",
      group: "frame",
      level: "common",
      title: strings.t(M.shapeSuggestions),
      keywords: strings.t(M.kwShape),
      body: <ShapeSuggestionsSection id={elementSelection[0]} />,
    });
  }
  if (hasContent && kind !== "text") typeSections();

  return (
    <CatalogRegistryProvider registry={appCatalogRegistry()}>
      <div
        data-properties-panel="ready"
        data-inspector-kind={kind}
        data-has-element={hasElement ? "true" : "false"}
        data-has-content={hasContent ? "true" : "false"}
        style={{ display: "flex", flexDirection: "column", minHeight: 0 }}
      >
        <CockpitPanelHeader title={title} />
        {selectionLabel && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              padding: "0 14px 8px",
            }}
          >
            <span className="pg-label" data-selection-label>
              {selectionLabel}
            </span>
            {/* D1 — the overset chip reads `StorySummary.overset` through
                the ThreadingContext, the same accessor the canvas ports
                use, so the panel and the canvas cannot disagree. */}
            {kind === "text" && oversetFrameId && (
              <span
                data-overset-state={
                  threading?.isOverset(oversetFrameId) ? "overset" : "fits"
                }
                title={
                  threading?.isOverset(oversetFrameId)
                    ? strings.t(M.oversetTitle)
                    : strings.t(M.fitsTitle)
                }
                className="pg-ui-xs"
                style={{
                  opacity: threading?.isOverset(oversetFrameId) ? 1 : 0.55,
                  whiteSpace: "nowrap",
                  color: threading?.isOverset(oversetFrameId)
                    ? "var(--status-error)"
                    : undefined,
                }}
              >
                {threading?.isOverset(oversetFrameId)
                  ? strings.t(M.overset)
                  : strings.t(M.oversetNo)}
              </span>
            )}
          </div>
        )}

        {elementSelection.length >= 2 && (
          <SelectionScope ids={elementSelection} geometry={elementGeometry} />
        )}

        {kind === "none" && (
          <div
            className="pg-ui-xs"
            data-properties-empty
            style={{ padding: "0 14px 12px", lineHeight: 1.5 }}
          >
            {strings.t(M.empty)}
          </div>
        )}

        {kind === "page" && <PageSummary />}

        {kind === "image" && hasElement && !hasImage ? (
          <div
            className="pg-ui-xs"
            data-properties-no-image
            style={{ padding: "0 14px 8px", lineHeight: 1.5 }}
          >
            {strings.t(M.noImage)}
          </div>
        ) : null}

        {sections.length > 0 && (
          <InspectorSections
            kind={kind}
            sections={sections}
            elementSelection={elementSelection}
            elementGeometry={elementGeometry}
          />
        )}

        {kind !== "none" && (
          <div
            data-ai-assistant-link
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "4px 14px 16px",
            }}
          >
            <CockpitBtn
              sm
              tone="soft"
              onClick={() => openAssistant(scope, { view: "ask" })}
              testId="open-ai-assistant"
            >
              {strings.t(M.askAssistant)}
            </CockpitBtn>
          </div>
        )}
      </div>
    </CatalogRegistryProvider>
  );
}

// ── sections: search, disclosure, groups, subsets ─────────────────

const sameId = (a: ElementId, b: ElementId) =>
  a.kind === b.kind && JSON.stringify(a.id) === JSON.stringify(b.id);

/** The form control nearest a matching label: the field a search's Enter
 *  goes to. */
function controlNear(el: Element): HTMLElement | null {
  let at: Element | null = el;
  for (let i = 0; at && i < 5; i++, at = at.parentElement) {
    const control = at.querySelector<HTMLElement>(
      "input:not([disabled]), select:not([disabled]), textarea:not([disabled])",
    );
    if (control) return control;
  }
  return null;
}

/** Elements inside `root` whose own text matches (labels, not values):
 *  leaf elements with text and no form control inside. */
function textHits(root: HTMLElement, query: string): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const el of root.querySelectorAll<HTMLElement>("*")) {
    if (el.children.length > 0) continue;
    if (/^(INPUT|SELECT|TEXTAREA|OPTION|BUTTON|svg)$/i.test(el.tagName))
      continue;
    const text = el.textContent ?? "";
    if (text.trim() !== "" && matchesQuery(query, [text])) out.push(el);
  }
  return out;
}

function InspectorSections(props: {
  kind: InspectorKind;
  sections: SectionDef[];
  elementSelection: readonly ElementId[];
  elementGeometry: readonly ElementGeometryItem[];
}) {
  const strings = useStrings();
  const { setElementSelection } = useSelection();
  const disclosure = useInspectorDisclosure(props.kind);
  // The query, and the sections whose RENDERED text matched it when it was
  // typed (a plugin's rows; collapsed bodies stay rendered for this).
  const [search, setSearch] = useState<{ query: string; dom: string[] }>({
    query: "",
    dom: [],
  });
  const bodies = useRef(new Map<string, HTMLElement>());
  const listRef = useRef<HTMLDivElement | null>(null);
  const query = search.query;
  const active = normalizeSearch(query) !== "";

  const onQuery = (next: string) => {
    const dom: string[] = [];
    if (normalizeSearch(next) !== "")
      for (const [id, el] of bodies.current)
        if (matchesQuery(next, [el.textContent ?? ""])) dom.push(id);
    setSearch({ query: next, dom });
  };

  // Mark the matching labels in the shown sections (a highlight, not a
  // filter); cleared with the query.
  useLayoutEffect(() => {
    const root = listRef.current;
    if (!root || !active) return;
    const hits = textHits(root, query);
    for (const el of hits) el.setAttribute("data-search-hit", "");
    hits[0]?.scrollIntoView?.({ block: "nearest" });
    return () => {
      for (const el of hits) el.removeAttribute("data-search-hit");
    };
  }, [query, active]);

  const total = props.elementSelection.length;
  const geometryOf = (id: ElementId) =>
    props.elementGeometry.find((g) => sameId(g.id, id));

  interface Shown {
    def: SectionDef;
    match: boolean;
    subset: ElementId[] | null;
  }
  const shown: Shown[] = [];
  for (const def of props.sections) {
    let subset: ElementId[] | null = null;
    if (def.applies && total >= 2) {
      const compatible = props.elementSelection.filter((id) =>
        def.applies!(geometryOf(id)),
      );
      if (compatible.length === 0) continue;
      if (compatible.length < total) subset = compatible;
    }
    const terms = [
      def.title,
      strings.t(GROUP_TITLE[def.group]),
      ...keywordTerms(def.keywords),
      ...(def.composition ? compositionTerms(def.composition) : []),
    ];
    const match =
      active && (matchesQuery(query, terms) || search.dom.includes(def.id));
    shown.push({ def, match, subset });
  }
  const groupsShown = [...new Set(shown.map((s) => s.def.group))];
  const ordered = groupsShown.flatMap((g) =>
    shown.filter((s) => s.def.group === g),
  );
  const anyMatch = ordered.some((s) => s.match);

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape" && query !== "") {
      e.preventDefault();
      e.stopPropagation();
      onQuery("");
    } else if (e.key === "Enter" && active) {
      // The first matching field takes focus: the one by a matching label,
      // else the first of the first matching section (a synonym names the
      // section, not a label in it).
      e.preventDefault();
      const root = listRef.current;
      const hit = root?.querySelector("[data-search-hit]");
      const section = root?.querySelector(
        "[data-search-match] > [data-properties-section]",
      );
      const control = hit
        ? controlNear(hit)
        : (section?.querySelector<HTMLElement>(
            "input:not([disabled]), select:not([disabled]), textarea:not([disabled])",
          ) ?? null);
      control?.focus();
    }
  };

  return (
    <PropertySearchProvider query={active ? query : ""}>
      <div className="px-3 pb-2" data-inspector-search>
        <div
          className="flex h-[28px] items-center gap-[6px] rounded-[6px] border border-input bg-background px-2"
          style={{ color: "var(--pg-muted-fg)" }}
        >
          <Icon name="ui-search" size={13} />
          <input
            type="search"
            value={query}
            placeholder={strings.t(M.search)}
            aria-label={strings.t(M.search)}
            data-inspector-search-input
            className="min-w-0 flex-1 bg-transparent text-[12px] outline-none"
            style={{ color: "var(--pg-fg)" }}
            onChange={(e) => onQuery(e.target.value)}
            onKeyDown={onSearchKey}
          />
          {query !== "" && (
            <button
              type="button"
              aria-label={strings.t(M.clearSearch)}
              title={strings.t(M.clearSearch)}
              data-inspector-search-clear
              className="border-0 bg-transparent p-0"
              onClick={() => onQuery("")}
            >
              <Icon name="ui-x" size={12} />
            </button>
          )}
        </div>
        {active && !anyMatch && (
          <div className="pg-ui-xs pt-2" data-inspector-no-match role="status">
            {strings.t(M.noMatch, { query })}
          </div>
        )}
      </div>
      <div
        ref={listRef}
        className="p-3 pt-0 flex flex-col gap-3"
        data-inspector-sections
      >
        {ordered.map(({ def, match, subset }, i) => {
          const firstOfGroup =
            i === 0 || ordered[i - 1]!.def.group !== def.group;
          return (
            <div key={def.id} className="contents">
              {groupsShown.length > 1 && firstOfGroup && (
                <div
                  className="pg-label"
                  data-inspector-group={def.group}
                  hidden={
                    active &&
                    !ordered.some((s) => s.match && s.def.group === def.group)
                  }
                >
                  {strings.t(GROUP_TITLE[def.group])}
                </div>
              )}
              <InspectorSection
                def={def}
                disclosure={disclosure}
                searching={active}
                match={match}
                subset={subset}
                total={total}
                onSelect={(ids) => setElementSelection([...ids])}
                registerBody={(el) => {
                  if (el) bodies.current.set(def.id, el);
                  else bodies.current.delete(def.id);
                }}
              />
            </div>
          );
        })}
      </div>
    </PropertySearchProvider>
  );
}

function InspectorSection(props: {
  def: SectionDef;
  disclosure: InspectorDisclosure;
  searching: boolean;
  match: boolean;
  subset: ElementId[] | null;
  total: number;
  onSelect: (ids: readonly ElementId[]) => void;
  registerBody: (el: HTMLElement | null) => void;
}) {
  const strings = useStrings();
  const {
    def,
    disclosure,
    searching,
    match,
    subset,
    total,
    onSelect,
    registerBody,
  } = props;
  const remembered = disclosure.isOpen(def.id, def.level);
  // A search opens a matching section for as long as it lasts; the
  // remembered state comes back with the query cleared.
  const open = searching ? match : remembered;
  const hidden = searching && !match;
  const content = def.composition ? (
    <CompositionRenderer composition={def.composition} />
  ) : (
    def.body
  );
  return (
    <section
      data-inspector-section={def.id}
      data-section-level={def.level}
      data-section-open={open ? "true" : "false"}
      data-search-match={searching && match ? "" : undefined}
      data-applies-count={subset ? subset.length : undefined}
      hidden={hidden}
      className="-mx-3 border-t border-input px-3"
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-expanded={open}
          data-section-header={def.id}
          className="flex min-w-0 flex-1 cursor-pointer items-center justify-between border-0 bg-transparent py-[8px] text-left"
          onClick={() => {
            if (!searching) disclosure.setOpen(def.id, !remembered);
          }}
        >
          <span
            className="whitespace-nowrap text-[12px] font-semibold"
            style={{
              color: "var(--pg-fg)",
              background:
                searching && match
                  ? "color-mix(in srgb, var(--pg-primary) 22%, transparent)"
                  : undefined,
              borderRadius: 3,
              padding: "0 2px",
            }}
          >
            {def.title}
          </span>
          <Icon
            name={open ? "ui-chevron-down" : "ui-chevron-right"}
            size={14}
            style={{ color: "var(--pg-muted-fg)" }}
          />
        </button>
        {subset && (
          <span
            className="pg-ui-xs whitespace-nowrap"
            data-applies-to
            title={strings.t(M.appliesTo, {
              count: subset.length,
              total,
            })}
          >
            {strings.t(M.appliesTo, {
              count: subset.length,
              total,
            })}
            {" · "}
            <button
              type="button"
              data-select-compatible
              className="border-0 bg-transparent p-0 underline"
              onClick={() => onSelect(subset)}
            >
              {strings.t(M.selectThese)}
            </button>
          </span>
        )}
      </div>
      <div
        ref={registerBody}
        hidden={!open}
        className="pb-3"
        data-properties-section={def.id}
        {...def.attrs}
      >
        {subset ? (
          <SelectionSubset ids={subset}>{content}</SelectionSubset>
        ) : (
          content
        )}
      </div>
    </section>
  );
}

/** One selected object's kind for the scope header: its counted message
 *  ("2 text frames") and its name ("Text frame"). */
function kindOf(
  id: ElementId,
  geometry: ElementGeometryItem | undefined,
): { count: string; name: string } {
  if ((geometry as { hasImage?: boolean } | undefined)?.hasImage === true)
    return { count: M.kindImage, name: M.nameImage };
  switch (id.kind) {
    case "textFrame":
      return { count: M.kindTextFrame, name: M.nameTextFrame };
    case "rectangle":
      return { count: M.kindRectangle, name: M.nameRectangle };
    case "oval":
      return { count: M.kindEllipse, name: M.nameEllipse };
    case "polygon":
      return { count: M.kindPolygon, name: M.namePolygon };
    case "graphicLine":
      return { count: M.kindLine, name: M.nameLine };
    case "group":
      return { count: M.kindGroup, name: M.nameGroup };
    default:
      return { count: M.kindOther, name: M.nameOther };
  }
}

/** "3 objects · 2 text frames, 1 image" — the scope of a multi-selection
 *  (UXI-PNL-010), with the objects listed on request and narrowed from
 *  there. */
function SelectionScope(props: {
  ids: readonly ElementId[];
  geometry: readonly ElementGeometryItem[];
}) {
  const strings = useStrings();
  const { setElementSelection } = useSelection();
  const [listed, setListed] = useState(false);
  const kinds = new Map<string, number>();
  const rows = props.ids.map((id) => {
    const k = kindOf(
      id,
      props.geometry.find((g) => sameId(g.id, id)),
    );
    kinds.set(k.count, (kinds.get(k.count) ?? 0) + 1);
    return { id, name: k.name };
  });
  const breakdown = [...kinds.entries()]
    .map(([key, count]) => strings.t(key, { count }))
    .join(", ");
  return (
    <div className="px-[14px] pb-2" data-inspector-scope>
      <div className="pg-ui-xs flex items-center justify-between gap-2">
        <span data-inspector-scope-label>
          {strings.t(M.objectCount, { count: props.ids.length })} · {breakdown}
        </span>
        <button
          type="button"
          aria-expanded={listed}
          data-inspector-scope-toggle
          className="border-0 bg-transparent p-0 underline"
          onClick={() => setListed(!listed)}
        >
          {strings.t(listed ? M.hideObjects : M.showObjects)}
        </button>
      </div>
      {listed && (
        <ul className="m-0 list-none p-0 pt-1" data-inspector-scope-list>
          {rows.map(({ id, name }) => (
            <li
              key={`${id.kind}:${JSON.stringify(id.id)}`}
              className="pg-ui-xs flex items-center justify-between gap-2"
            >
              <span>{strings.t(name)}</span>
              <button
                type="button"
                data-select-only={typeof id.id === "string" ? id.id : ""}
                className="border-0 bg-transparent p-0 underline"
                onClick={() => setElementSelection([id])}
              >
                {strings.t(M.selectOnly)}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="pg-ui-xs pt-1" style={{ opacity: 0.75 }}>
        {strings.t(M.relativeHint)}
      </div>
    </div>
  );
}

function groupIdOf(id: ElementId | undefined): string | null {
  return id?.kind === "group" && typeof id.id === "string" ? id.id : null;
}

/** How many objects the group holds directly (a nested group is one),
 *  read off the scene tree; null until it has answered. `refresh` is the
 *  geometry mirror, which every change to the selection's content
 *  replaces. */
function useGroupMemberCount(
  groupId: string | null,
  refresh: unknown,
): number | null {
  const client = useOptionalCanvasClient();
  const [answer, setAnswer] = useState<{
    groupId: string;
    count: number;
  } | null>(null);
  useEffect(() => {
    if (!client || !groupId) return;
    let live = true;
    client
      .sceneTree()
      .then((roots) => {
        if (live)
          setAnswer({ groupId, count: groupMembersOf(roots, groupId).length });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [client, groupId, refresh]);
  return answer && answer.groupId === groupId ? answer.count : null;
}

/** "webFrame" → "Web frame" — the breadcrumb's title-casing rule. */
function humanizeType(type: string): string {
  const spaced = type.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** The first page's geometry as the pages collection reports it. */
interface PageGeometry {
  marginTopPt?: number;
  marginLeftPt?: number;
  marginBottomPt?: number;
  marginRightPt?: number;
  columnCount?: number;
  columnGutterPt?: number;
  bleedTopPt?: number;
  bleedLeftPt?: number;
  bleedBottomPt?: number;
  bleedRightPt?: number;
}

/** Four sides as InDesign's fields list them: top, left, bottom, right;
 *  one value when all four agree. */
function formatSides(
  sides: readonly (number | undefined)[],
  unit: Parameters<typeof formatLength>[1],
): string {
  const v = sides.map((s) => s ?? 0);
  return v.every((x) => x === v[0])
    ? formatLength(v[0]!, unit)
    : v.map((x) => formatLength(x, unit)).join(" · ");
}

/** Page geometry summary (kit PageInspector). REAL: size from the
 *  document handle; margins, columns and bleed from the pages
 *  collection, which carries them (PN-23: the seam that said they waited
 *  for engine accessors outlived its gap). Section/status await
 *  collaboration. */
function PageSummary() {
  const strings = useStrings();
  const { handle } = useDocument();
  const first = handle?.pageSizesPt[0];
  const unit = useDocumentUnit();
  const page = useCollection<PageGeometry>("pages")?.[0] ?? null;
  return (
    <CockpitSection title={strings.t(M.geometry)}>
      <CockpitRow label={strings.t(M.pages)}>
        <CockpitValue>{handle ? handle.pageCount : "—"}</CockpitValue>
      </CockpitRow>
      <CockpitRow label={strings.t(M.size)}>
        <CockpitValue>
          {first ? formatLengthPair(first[0], first[1], unit) : "—"}
        </CockpitValue>
      </CockpitRow>
      <CockpitRow label={strings.t(M.margins)}>
        <CockpitValue>
          {page
            ? formatSides(
                [
                  page.marginTopPt,
                  page.marginLeftPt,
                  page.marginBottomPt,
                  page.marginRightPt,
                ],
                unit,
              )
            : "—"}
        </CockpitValue>
      </CockpitRow>
      <CockpitRow label={strings.t(M.columns)}>
        <CockpitValue>
          {page
            ? strings.t(M.columnsValue, {
                count: page.columnCount ?? 1,
                gutter: formatLength(page.columnGutterPt ?? 0, unit),
              })
            : "—"}
        </CockpitValue>
      </CockpitRow>
      <CockpitRow label={strings.t(M.bleed)}>
        <CockpitValue>
          {page
            ? formatSides(
                [
                  page.bleedTopPt,
                  page.bleedLeftPt,
                  page.bleedBottomPt,
                  page.bleedRightPt,
                ],
                unit,
              )
            : "—"}
        </CockpitValue>
      </CockpitRow>
    </CockpitSection>
  );
}
