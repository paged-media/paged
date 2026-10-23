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

// ADR 323 — Style Options: the paragraph, character, object, cell and
// table style DEFINITIONS as schema-driven forms. The target is a style
// address, `style:<family>/<self id>`; every field is a `PropertyField`
// on it, so an edit is a `set` on that address (core's `Set` resolves a
// style path to `setStyleProperty`), one edit = one undo step, and every
// field offers "Bind to data…".
//
// The sections mirror InDesign's Style Options dialog. They only LAY OUT
// paths; each field's type, range and widget come from the style's
// schema rows, and rows the schema adds for the family that no section
// names appear under "More". "Next style" and the bullet / numbering /
// region cell styles are refs picked from the style collections.
// Fields marked `hideUnreported` are laid out ahead of the engine (a
// paragraph's line setting, a character's No Break): they appear once
// the style's schema and the running engine both report them.
//
// The style panels open it on their applied style ("Style Options…").

import {
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";

import {
  CockpitPanelHeader,
  CockpitRow,
  PropertyField,
  cockpitActionsOf,
  createValueStore,
  scoped,
  useEditorScope,
  type EditorScope,
  displayName,
  useCollection,
} from "@paged-media/shell";
import { formatAddress } from "@paged-media/plugin-sdk";
import { FieldSelect, Tab } from "@paged-media/panel-kit";
import type { CollectionName } from "@paged-media/client";

import { defineMessages, useStrings } from "@paged-media/strings";

import { SchemaSections, type SectionSpec } from "./schema-sections";
import { sectionsIn } from "./section-strings";

export type StyleFamily =
  "paragraph" | "character" | "object" | "cell" | "table";

export const STYLE_OPTIONS_PANEL = "paged.style-options";

/** A family tab: the shell kit's small button look (primary when it is
 *  the selected one), on a real tab (the panel kit's Tab). */
function familyTab(selected: boolean): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    height: 28,
    padding: "0 11px",
    borderRadius: "var(--radius-md)",
    border: selected ? "none" : "1px solid var(--pg-border)",
    background: selected ? "var(--pg-primary)" : "transparent",
    color: selected ? "var(--pg-primary-fg)" : "var(--pg-fg)",
    cursor: "pointer",
    fontFamily: "var(--font-sans)",
    fontSize: 12,
    fontWeight: 600,
    whiteSpace: "nowrap",
  };
}

const M = defineMessages("app.styleOptionsPanel", {
  paragraph: "Paragraph",
  character: "Character",
  object: "Object",
  cell: "Cell",
  table: "Table",
  basicCharacterFormats: "Basic Character Formats",
  fontFamily: "Font family",
  fontStyle: "Font style",
  size: "Size",
  leading: "Leading",
  kerning: "Kerning",
  tracking: "Tracking",
  case: "Case",
  position: "Position",
  underline: "Underline",
  strikethrough: "Strikethrough",
  ligatures: "Ligatures",
  noBreak: "No break",
  advancedCharacterFormats: "Advanced Character Formats",
  baselineShift: "Baseline shift",
  characterColor: "Character Color",
  fill: "Fill",
  general: "General",
  nextStyle: "Next style",
  indentsAndSpacing: "Indents and Spacing",
  alignment: "Alignment",
  balanceRaggedLines: "Balance ragged lines",
  leftIndent: "Left indent",
  rightIndent: "Right indent",
  firstLine: "First line",
  lastLine: "Last line",
  spaceBefore: "Space before",
  spaceAfter: "Space after",
  tabs: "Tabs",
  tabStops: "Tab stops",
  keepOptions: "Keep Options",
  keepWithNext: "Keep with next",
  keepLines: "Keep lines",
  allLines: "All lines",
  firstLines: "First lines",
  lastLines: "Last lines",
  start: "Start",
  hyphenation: "Hyphenation",
  hyphenate: "Hyphenate",
  zone: "Zone",
  justification: "Justification",
  autoLeading: "Auto leading",
  singleWord: "Single word",
  composer: "Composer",
  spanColumns: "Span Columns",
  layout: "Layout",
  columns: "Columns",
  insideGutter: "Inside gutter",
  outsideGutter: "Outside gutter",
  bulletsAndNumbering: "Bullets and Numbering",
  listType: "List type",
  bullet: "Bullet",
  textAfter: "Text after",
  bulletStyle: "Bullet style",
  list: "List",
  format: "Format",
  number: "Number",
  startAt: "Start at",
  continue: "Continue",
  numberStyle: "Number style",
  tint: "Tint",
  stroke: "Stroke",
  weight: "Weight",
  cornerOptions: "Corner Options",
  shape: "Shape",
  text: "Text",
  align: "Align",
  rotation: "Rotation",
  strokes: "Strokes",
  top: "Top",
  topWeight: "Top weight",
  bottom: "Bottom",
  bottomWeight: "Bottom weight",
  left: "Left",
  leftWeight: "Left weight",
  right: "Right",
  rightWeight: "Right weight",
  cellStyles: "Cell Styles",
  headerRows: "Header rows",
  bodyRows: "Body rows",
  footerRows: "Footer rows",
  leftColumn: "Left column",
  rightColumn: "Right column",
  tableBorder: "Table Border",
  fills: "Fills",
  alternating: "Alternating",
  firstFill: "First fill",
  firstRows: "First rows",
  firstTint: "First tint",
  nextFill: "Next fill",
  nextRows: "Next rows",
  nextTint: "Next tint",
  panelTitle: "Style Options",
  style: "Style",
  name: "Name",
  basedOn: "Based on",
  noStyle: "[No style]",
  emptyParagraph: "This document has no paragraph styles.",
  emptyCharacter: "This document has no character styles.",
  emptyObject: "This document has no object styles.",
  emptyCell: "This document has no cell styles.",
  emptyTable: "This document has no table styles.",
  openOptions: "Style Options…",
  options: "Options…",
});

/** A family's empty state, by family. */
const EMPTY: Readonly<Record<StyleFamily, string>> = {
  paragraph: M.emptyParagraph,
  character: M.emptyCharacter,
  object: M.emptyObject,
  cell: M.emptyCell,
  table: M.emptyTable,
};

// Titles and labels below are message keys (`sectionsIn` translates them).
const FAMILIES: ReadonlyArray<{
  family: StyleFamily;
  title: string;
  collection: CollectionName;
}> = [
  { family: "paragraph", title: M.paragraph, collection: "paragraphStyles" },
  { family: "character", title: M.character, collection: "characterStyles" },
  { family: "object", title: M.object, collection: "objectStyles" },
  { family: "cell", title: M.cell, collection: "cellStyles" },
  { family: "table", title: M.table, collection: "tableStyles" },
];

// ------------------------------------------------------------ layout

const CHARACTER_SECTIONS: readonly SectionSpec[] = [
  {
    title: M.basicCharacterFormats,
    fields: [
      { path: "characterFontFamily", label: M.fontFamily },
      { path: "characterFontStyle", label: M.fontStyle },
      { path: "characterFontSize", label: M.size },
      { path: "characterLeading", label: M.leading },
      { path: "characterKerningMethod", label: M.kerning },
      { path: "characterTracking", label: M.tracking },
      { path: "characterCase", label: M.case },
      { path: "characterPosition", label: M.position },
      { path: "characterUnderline", label: M.underline },
      { path: "characterStrikethru", label: M.strikethrough },
      { path: "characterLigatures", label: M.ligatures },
      { path: "characterNoBreak", label: M.noBreak, hideUnreported: true },
    ],
  },
  {
    title: M.advancedCharacterFormats,
    fields: [{ path: "characterBaselineShift", label: M.baselineShift }],
  },
  {
    title: M.characterColor,
    fields: [
      { path: "characterFillColor", label: M.fill, collection: "swatches" },
    ],
  },
];

const PARAGRAPH_SECTIONS: readonly SectionSpec[] = [
  {
    title: M.general,
    fields: [
      {
        path: "paragraphStyleNextStyle",
        label: M.nextStyle,
        collection: "paragraphStyles",
      },
    ],
  },
  {
    title: M.indentsAndSpacing,
    fields: [
      { path: "paragraphJustification", label: M.alignment },
      {
        path: "paragraphBalanceRaggedLines",
        label: M.balanceRaggedLines,
        hideUnreported: true,
      },
      { path: "paragraphLeftIndent", label: M.leftIndent },
      { path: "paragraphRightIndent", label: M.rightIndent },
      { path: "paragraphFirstLineIndent", label: M.firstLine },
      {
        path: "paragraphLastLineIndent",
        label: M.lastLine,
        hideUnreported: true,
      },
      { path: "paragraphSpaceBefore", label: M.spaceBefore },
      { path: "paragraphSpaceAfter", label: M.spaceAfter },
    ],
  },
  {
    title: M.tabs,
    fields: [{ path: "paragraphTabStops", label: M.tabStops }],
  },
  {
    title: M.keepOptions,
    fields: [
      { path: "paragraphKeepWithNext", label: M.keepWithNext },
      { path: "paragraphKeepLinesTogether", label: M.keepLines },
      { path: "paragraphKeepAllLinesTogether", label: M.allLines },
      { path: "paragraphKeepFirstLines", label: M.firstLines },
      { path: "paragraphKeepLastLines", label: M.lastLines },
      { path: "paragraphStartParagraph", label: M.start },
    ],
  },
  {
    title: M.hyphenation,
    fields: [
      { path: "paragraphHyphenation", label: M.hyphenate },
      { path: "paragraphHyphenationZone", label: M.zone },
    ],
  },
  {
    title: M.justification,
    fields: [
      {
        path: "paragraphAutoLeading",
        label: M.autoLeading,
        hideUnreported: true,
      },
      {
        path: "paragraphSingleWordJustification",
        label: M.singleWord,
        hideUnreported: true,
      },
      { path: "paragraphComposer", label: M.composer },
    ],
  },
  {
    title: M.spanColumns,
    fields: [
      { path: "paragraphSpanColumnType", label: M.layout },
      { path: "paragraphSpanSplitColumnCount", label: M.columns },
      { path: "paragraphSpanColumnMinSpaceBefore", label: M.spaceBefore },
      { path: "paragraphSpanColumnMinSpaceAfter", label: M.spaceAfter },
      { path: "paragraphSplitColumnInsideGutter", label: M.insideGutter },
      { path: "paragraphSplitColumnOutsideGutter", label: M.outsideGutter },
    ],
  },
  {
    title: M.bulletsAndNumbering,
    fields: [
      { path: "paragraphListType", label: M.listType },
      { path: "paragraphBulletCharacter", label: M.bullet },
      { path: "paragraphBulletsTextAfter", label: M.textAfter },
      {
        path: "paragraphBulletsCharacterStyle",
        label: M.bulletStyle,
        collection: "characterStyles",
      },
      {
        path: "paragraphAppliedNumberingList",
        label: M.list,
        collection: "numberingLists",
      },
      { path: "paragraphNumberingFormat", label: M.format },
      { path: "paragraphNumberingExpression", label: M.number },
      { path: "paragraphNumberingStartAt", label: M.startAt },
      { path: "paragraphNumberingContinue", label: M.continue },
      {
        path: "paragraphNumberingCharacterStyle",
        label: M.numberStyle,
        collection: "characterStyles",
      },
    ],
  },
  ...CHARACTER_SECTIONS,
];

const OBJECT_SECTIONS: readonly SectionSpec[] = [
  {
    title: M.fill,
    fields: [
      { path: "frameFillColor", label: M.fill, collection: "swatches" },
      { path: "frameFillTint", label: M.tint },
    ],
  },
  {
    title: M.stroke,
    fields: [
      { path: "frameStrokeColor", label: M.stroke, collection: "swatches" },
      { path: "frameStrokeWeight", label: M.weight },
      { path: "objectStyleStrokeTint", label: M.tint },
    ],
  },
  {
    title: M.cornerOptions,
    fields: [
      { path: "objectStyleCornerOption", label: M.shape },
      { path: "objectStyleCornerRadius", label: M.size },
    ],
  },
];

const CELL_SECTIONS: readonly SectionSpec[] = [
  {
    title: M.text,
    fields: [
      { path: "cellVerticalJustification", label: M.align },
      { path: "cellStyleRotationAngle", label: M.rotation },
    ],
  },
  {
    title: M.fill,
    fields: [
      { path: "cellFillColor", label: M.fill, collection: "swatches" },
      { path: "cellFillTint", label: M.tint },
    ],
  },
  {
    title: M.strokes,
    fields: [
      { path: "cellTopEdgeStrokeColor", label: M.top, collection: "swatches" },
      { path: "cellTopEdgeStrokeWeight", label: M.topWeight },
      {
        path: "cellBottomEdgeStrokeColor",
        label: M.bottom,
        collection: "swatches",
      },
      { path: "cellBottomEdgeStrokeWeight", label: M.bottomWeight },
      {
        path: "cellLeftEdgeStrokeColor",
        label: M.left,
        collection: "swatches",
      },
      { path: "cellLeftEdgeStrokeWeight", label: M.leftWeight },
      {
        path: "cellRightEdgeStrokeColor",
        label: M.right,
        collection: "swatches",
      },
      { path: "cellRightEdgeStrokeWeight", label: M.rightWeight },
    ],
  },
];

const TABLE_SECTIONS: readonly SectionSpec[] = [
  {
    title: M.cellStyles,
    fields: [
      {
        path: "tableStyleHeaderRegionCellStyle",
        label: M.headerRows,
        collection: "cellStyles",
      },
      {
        path: "tableStyleBodyRegionCellStyle",
        label: M.bodyRows,
        collection: "cellStyles",
      },
      {
        path: "tableStyleFooterRegionCellStyle",
        label: M.footerRows,
        collection: "cellStyles",
      },
      {
        path: "tableStyleLeftColumnRegionCellStyle",
        label: M.leftColumn,
        collection: "cellStyles",
      },
      {
        path: "tableStyleRightColumnRegionCellStyle",
        label: M.rightColumn,
        collection: "cellStyles",
      },
    ],
  },
  {
    title: M.tableBorder,
    fields: [
      {
        path: "tableStyleTopBorderStrokeColor",
        label: M.top,
        collection: "swatches",
      },
      { path: "tableStyleTopBorderStrokeWeight", label: M.topWeight },
      {
        path: "tableStyleBottomBorderStrokeColor",
        label: M.bottom,
        collection: "swatches",
      },
      { path: "tableStyleBottomBorderStrokeWeight", label: M.bottomWeight },
      {
        path: "tableStyleLeftBorderStrokeColor",
        label: M.left,
        collection: "swatches",
      },
      { path: "tableStyleLeftBorderStrokeWeight", label: M.leftWeight },
      {
        path: "tableStyleRightBorderStrokeColor",
        label: M.right,
        collection: "swatches",
      },
      { path: "tableStyleRightBorderStrokeWeight", label: M.rightWeight },
    ],
  },
  {
    title: M.fills,
    fields: [
      { path: "tableStyleAlternatingFills", label: M.alternating },
      {
        path: "tableStyleStartRowFillColor",
        label: M.firstFill,
        collection: "swatches",
      },
      { path: "tableStyleStartRowFillCount", label: M.firstRows },
      { path: "tableStyleStartRowFillTint", label: M.firstTint },
      {
        path: "tableStyleEndRowFillColor",
        label: M.nextFill,
        collection: "swatches",
      },
      { path: "tableStyleEndRowFillCount", label: M.nextRows },
      { path: "tableStyleEndRowFillTint", label: M.nextTint },
    ],
  },
];

export const STYLE_SECTIONS: Readonly<
  Record<StyleFamily, readonly SectionSpec[]>
> = {
  paragraph: PARAGRAPH_SECTIONS,
  character: CHARACTER_SECTIONS,
  object: OBJECT_SECTIONS,
  cell: CELL_SECTIONS,
  table: TABLE_SECTIONS,
};

// ------------------------------------------------------------ target

/** The style the panel edits, per editor — shared so a style panel can
 *  open the options on ITS applied style. */
const TARGET = scoped("styleOptionsTarget", () =>
  createValueStore<{ family: StyleFamily; selfId: string | null }>({
    family: "paragraph",
    selfId: null,
  }),
);

export function setStyleOptionsTarget(
  scope: EditorScope,
  family: StyleFamily,
  selfId: string | null,
): void {
  scope.get(TARGET).set({ family, selfId });
}

/** "Style Options…": point `scope`'s panel at a style and bring it up. */
export function openStyleOptions(
  scope: EditorScope,
  family: StyleFamily,
  selfId: string | null,
): void {
  setStyleOptionsTarget(scope, family, selfId);
  cockpitActionsOf(scope).openPanel?.(STYLE_OPTIONS_PANEL);
}

/** The ADR 131 address of a style. */
export function styleAddress(family: StyleFamily, selfId: string): string {
  return formatAddress({ kind: "style", family, name: selfId } as never);
}

interface StyleRow {
  selfId: string;
  name: string;
  basedOn?: string | null;
}

// ------------------------------------------------------------- panel

export function StyleOptionsPanel() {
  const strings = useStrings();
  const scope = useEditorScope();
  const target = scope.get(TARGET);
  const current = useSyncExternalStore(target.subscribe, target.get);
  const family = current.family;
  const spec = FAMILIES.find((f) => f.family === family)!;
  const styles = useCollection<StyleRow>(spec.collection);

  // Default to the first editable style of the family (the `[None]` /
  // `[No … style]` roots are not editable in InDesign either).
  const [picked, setPicked] = useState<string | null>(current.selfId);
  useEffect(() => setPicked(current.selfId), [current]);
  // eslint-disable-next-line no-restricted-syntax -- a computed block, not a single expression (ADR 229)
  const selfId = useMemo(() => {
    if (!styles) return null;
    if (picked && styles.some((s) => s.selfId === picked)) return picked;
    return (
      (styles.find((s) => !s.name.startsWith("$ID/")) ?? styles[0])?.selfId ??
      null
    );
  }, [styles, picked]);
  const row = styles?.find((s) => s.selfId === selfId) ?? null;
  const address = selfId ? styleAddress(family, selfId) : null;
  const targets = address ? [address] : [];
  const basedOn = row?.basedOn
    ? styles?.find((s) => s.selfId === row.basedOn)
    : null;

  return (
    <div
      data-style-options-panel={styles ? "ready" : "loading"}
      data-style-family={family}
      data-style-target={address ?? ""}
    >
      <CockpitPanelHeader title={strings.t(M.panelTitle)} />
      <div className="flex flex-wrap gap-1 px-3.5 pb-2" role="tablist">
        {FAMILIES.map((f) => (
          <Tab
            key={f.family}
            selected={f.family === family}
            data-cockpit-action={`style-family-${f.family}`}
            style={familyTab(f.family === family)}
            onClick={() => setStyleOptionsTarget(scope, f.family, null)}
          >
            {strings.t(f.title)}
          </Tab>
        ))}
      </div>
      <div className="flex flex-col gap-1.5 px-3.5 pb-2">
        <CockpitRow label={strings.t(M.style)}>
          <FieldSelect
            data-style-options-select=""
            className="h-[28px] w-full rounded-[6px] border border-input bg-background px-2 text-[12px]"
            value={selfId ?? ""}
            onChange={(e) => setPicked(e.target.value || null)}
          >
            {(styles ?? []).map((s) => (
              <option key={s.selfId} value={s.selfId}>
                {displayName(s.name)}
              </option>
            ))}
          </FieldSelect>
        </CockpitRow>
        {address ? (
          <>
            <PropertyField
              path="name"
              label={strings.t(M.name)}
              targets={targets}
              schemaKind={address}
            />
            <CockpitRow label={strings.t(M.basedOn)}>
              <span
                className="text-xs"
                data-style-based-on={row?.basedOn ?? ""}
              >
                {basedOn ? displayName(basedOn.name) : strings.t(M.noStyle)}
              </span>
            </CockpitRow>
          </>
        ) : (
          <div
            className="text-xs"
            style={{ color: "var(--pg-muted-fg)" }}
            data-style-options-empty=""
          >
            {strings.t(EMPTY[family])}
          </div>
        )}
      </div>
      {address && (
        <SchemaSections
          key={address}
          targets={targets}
          sections={sectionsIn(strings, STYLE_SECTIONS[family])}
          family={family}
          testId={`style:${family}`}
        />
      )}
    </div>
  );
}

/** A row's "Options…" affordance in the cell / table style lists. */
export function StyleOptionsButton({
  family,
  selfId,
}: {
  family: StyleFamily;
  selfId: string;
}) {
  const strings = useStrings();
  const scope = useEditorScope();
  return (
    <button
      type="button"
      data-style-options-open={selfId}
      title={strings.t(M.openOptions)}
      onClick={() => openStyleOptions(scope, family, selfId)}
      className="shrink-0 rounded-[4px] px-1.5 text-[10px] hover:bg-[var(--pg-muted)]"
      style={{ color: "var(--pg-muted-fg)" }}
    >
      {strings.t(M.options)}
    </button>
  );
}
