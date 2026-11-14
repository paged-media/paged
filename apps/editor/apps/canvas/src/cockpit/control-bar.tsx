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

// The Design mode's control bar — the second row, about the SELECTION
// (InDesign's Control panel idiom), on one line:
//
//   nothing selected  page ‹ n / N › · page size · Bleed · Preview
//   page items        kind · X Y W H · rotation · stroke · opacity ·
//                     align (2+) · arrange · group / ungroup · Preview
//   text caret/range  paragraph style · character style · font · size ·
//                     leading · alignment · Preview
//
// (A plugin's edit context replaces the bar with its own segment —
// ContextToolbar's job, unchanged.) A document a bundle holds the DOCUMENT
// CONTEXT for (a Word document opened as the whole document, extensions
// ADR 348) shows that bundle's control-bar groups in place of the text and
// document controls (editor ADR 298): the Word user's Home group, on every
// page and with the caret anywhere.
//
// The row used to repeat five of the rail's tools, the one place above
// the canvas where the selection's numbers belong. Every field reads and
// writes through the same doors the panels use — `host.objects`
// (`useObjectProperty`: one batch = one undo step, refusals reported)
// and the page-footprint hook behind the Object panel's Bounds row — so
// the bar and the panels cannot disagree.

import {
  useEffect,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import { type ElementId, type FontSummary } from "@paged-media/client";
import {
  ContributedControlBarGroups,
  currentPageIndex,
  useActiveScopeContext,
  useHasControlBarGroups,
  usePageNavigation,
  useCamera,
  useCanvasClient,
  useCollection,
  useContentSelection,
  useDocument,
  useObjectModel,
  useObjectProperty,
  useRegistries,
  useScreenMode,
  useSelection,
  useSelectionObjectType,
  useTool,
  useToolSettings,
} from "@paged-media/shell";
import {
  BOX_MODES,
  FREE_TRANSFORM_TOOL_ID,
  REFERENCE_KEYS,
  freeTransformBoxOf,
  referencePointOf,
  shearSelectionBy,
  type ReferenceKey,
} from "@paged-media/tools";
import {
  formatLengthPair,
  NumericField,
  useDocumentUnit,
} from "@paged-media/ui";

import { ALIGN_COMMAND, type AlignKind } from "../align-plan";
import { usePagePosition } from "../panels/page-position";
import { layoutPages } from "../ui/layout";
import { Chip, Sep, ToolPill } from "./toolbars";
import { defineMessages, useStrings, type Strings } from "@paged-media/strings";

const M = defineMessages("app.cockpitControlBar", {
  noDocument: "No document — File ▸ New document… or drop an IDML file here",
  page: "Page",
  previousPage: "Previous page",
  nextPage: "Next page",
  pageSize: "Page size",
  normalView: "Back to normal view",
  showBleed: "Show the bleed area",
  bleed: "Bleed",
  normalViewW: "Back to normal view (W)",
  previewW: "Proof view (W)",
  preview: "Proof",
  rectangle: "Rectangle",
  oval: "Ellipse",
  polygon: "Polygon",
  graphicLine: "Line",
  textFrame: "Text frame",
  group: "Group",
  image: "Image",
  object: "Object",
  objects: "{count, plural, one {# object} other {# objects}}",
  resizeHint:
    "Rotated, sheared, grouped or multiple objects resize through Transform",
  leftEdge: "Left edge (pt)",
  topEdge: "Top edge (pt)",
  widthLabel: "W",
  width: "Width (pt)",
  heightLabel: "H",
  height: "Height (pt)",
  rotation: "Rotation (degrees)",
  strokeLabel: "Stroke",
  strokeWeight: "Stroke weight (pt)",
  opacityLabel: "Opacity",
  opacity: "Opacity (%)",
  alignLeft: "Align left",
  centerHorizontally: "Center horizontally",
  alignRight: "Align right",
  alignTop: "Align top",
  centerVertically: "Center vertically",
  alignBottom: "Align bottom",
  bringToFront: "Bring to front",
  sendToBack: "Send to back",
  groupAction: "Group",
  groupTitle: "Group (⌘G)",
  ungroupTitle: "Ungroup (⇧⌘G)",
  ungroup: "Ungroup",
  alignCenter: "Align center",
  justify: "Justify",
  paragraphStyle: "Paragraph style",
  characterStyle: "Character style",
  fontFamily: "Font family",
  sizeLabel: "Size",
  fontSize: "Font size (pt)",
  leadLabel: "Lead",
  leading: "Leading (pt)",
  auto: "Auto",
  mixed: "— mixed —",
  referencePoint: "Reference point",
  referenceAt: "Reference point: {point}",
  refNw: "top left",
  refN: "top centre",
  refNe: "top right",
  refW: "centre left",
  refC: "centre",
  refE: "centre right",
  refSw: "bottom left",
  refS: "bottom centre",
  refSe: "bottom right",
  modeFreeTransform: "Free Transform",
  modeConstrain: "Constrain",
  modeFreeDistort: "Free Distort",
  modePerspective: "Perspective",
  shearLabel: "Shear",
  shear: "Shear angle (degrees), about the reference point",
});

const REF_LABEL: Record<ReferenceKey, string> = {
  nw: M.refNw,
  n: M.refN,
  ne: M.refNe,
  w: M.refW,
  c: M.refC,
  e: M.refE,
  sw: M.refSw,
  s: M.refS,
  se: M.refSe,
};

const MODE_LABEL: Record<(typeof BOX_MODES)[number], string> = {
  freeTransform: M.modeFreeTransform,
  constrain: M.modeConstrain,
  freeDistort: M.modeFreeDistort,
  perspective: M.modePerspective,
};

export function DesignControlBar() {
  const { elementSelection } = useSelection();
  const { contentSelection } = useContentSelection();
  const scoped = useActiveScopeContext();
  const contributed = useHasControlBarGroups(scoped);
  // Selected page items keep their own controls; text and the document
  // level belong to the contributed groups when the document has some.
  const kind = contributed
    ? elementSelection.length > 0 && !contentSelection
      ? "object"
      : "contributed"
    : contentSelection
      ? "text"
      : elementSelection.length > 0
        ? "object"
        : "document";
  const body =
    kind === "contributed" ? (
      <ContributedControlBarGroups editContext={scoped} />
    ) : kind === "text" ? (
      <TextControls />
    ) : kind === "object" ? (
      <ObjectControls ids={elementSelection} />
    ) : (
      <DocumentControls />
    );
  return (
    <div
      data-control-bar={kind}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        minWidth: 0,
        overflowX: "auto",
        scrollbarWidth: "none",
      }}
    >
      {body}
      <Sep />
      <PreviewChip />
    </div>
  );
}

// ── nothing selected ───────────────────────────────────────────────

function DocumentControls() {
  const navigateToPages = usePageNavigation();
  const strings = useStrings();
  const { handle } = useDocument();
  const { camera, viewportSize } = useCamera();
  const screenMode = useScreenMode();
  const unit = useDocumentUnit();
  const sizes = handle?.pageSizesPt ?? [];
  if (!handle || sizes.length === 0) {
    return (
      <span
        className="pg-ui-xs"
        style={{ paddingLeft: 4, color: "var(--pg-muted-fg)" }}
      >
        {strings.t(M.noDocument)}
      </span>
    );
  }
  // The one current page (the shell's `currentPageIndex`, UXI-CAM-015):
  // the page at the viewport's centre, else the nearest, rotation
  // included — the page Fit page fits and an insert lands on.
  const rects = layoutPages(sizes, handle.pageOriginsPt);
  const at = currentPageIndex(rects, camera, viewportSize);
  const current = at < 0 ? 0 : at;
  const go = (i: number) =>
    navigateToPages([Math.max(0, Math.min(sizes.length - 1, i))]);
  const [w, h] = sizes[current];
  const bleedOn = screenMode.screenMode === "bleed";
  return (
    <>
      <Label>{strings.t(M.page)}</Label>
      <ToolPill
        icon="ui-chevron-left"
        title={strings.t(M.previousPage)}
        disabled={current === 0}
        onClick={() => go(current - 1)}
        testId="page-prev"
      />
      <span
        className="pg-value"
        data-control-page
        style={{ ...valueText, minWidth: 54, textAlign: "center" }}
      >
        {current + 1} / {sizes.length}
      </span>
      <ToolPill
        icon="ui-chevron-right"
        title={strings.t(M.nextPage)}
        disabled={current >= sizes.length - 1}
        onClick={() => go(current + 1)}
        testId="page-next"
      />
      <Sep />
      <span
        className="pg-value"
        title={strings.t(M.pageSize)}
        style={{ ...valueText, color: "var(--pg-muted-fg)" }}
      >
        {formatLengthPair(w, h, unit)}
      </span>
      <Sep />
      <Chip
        icon="ui-page"
        on={bleedOn}
        testId="design-bleed"
        title={bleedOn ? strings.t(M.normalView) : strings.t(M.showBleed)}
        onClick={() => screenMode.setScreenMode(bleedOn ? "normal" : "bleed")}
      >
        {strings.t(M.bleed)}
      </Chip>
    </>
  );
}

function PreviewChip() {
  const strings = useStrings();
  const screenMode = useScreenMode();
  const previewOn = screenMode.screenMode === "preview";
  return (
    <Chip
      icon={previewOn ? "ui-eye-off" : "ui-eye"}
      on={previewOn}
      testId="preview-toggle"
      title={previewOn ? strings.t(M.normalViewW) : strings.t(M.previewW)}
      onClick={() => screenMode.togglePreview()}
    >
      {strings.t(M.preview)}
    </Chip>
  );
}

// ── page items ─────────────────────────────────────────────────────

const KIND_LABEL: Record<string, string> = {
  rectangle: M.rectangle,
  oval: M.oval,
  polygon: M.polygon,
  graphicLine: M.graphicLine,
  textFrame: M.textFrame,
  group: M.group,
  image: M.image,
};

function kindLabel(strings: Strings, ids: readonly ElementId[]): string {
  if (ids.length > 1) return strings.t(M.objects, { count: ids.length });
  const kind = (ids[0] as unknown as { kind?: string }).kind ?? "";
  const key = Object.hasOwn(KIND_LABEL, kind) ? KIND_LABEL[kind] : undefined;
  if (key) return strings.t(key);
  return kind
    ? kind.charAt(0).toUpperCase() + kind.slice(1)
    : strings.t(M.object);
}

function ObjectControls({ ids }: { ids: readonly ElementId[] }) {
  const strings = useStrings();
  const { box, edgeLeaf, moveBy, setEdges } = usePagePosition();
  const rotation = useObjectProperty({ path: "frameRotationAngle" });
  const stroke = useObjectProperty({ path: "frameStrokeWeight" });
  const opacity = useObjectProperty({ path: "frameOpacity" });
  const { commands } = useRegistries();
  const model = useObjectModel();
  // F-45 — content a module owns is named as the module names it ("Web
  // frame", "Spreadsheet"), not by the host kind it is drawn with.
  const owned = useSelectionObjectType()?.editContext?.label ?? null;
  const multi = ids.length >= 2;
  const isGroup =
    ids.length === 1 &&
    (ids[0] as unknown as { kind?: string }).kind === "group";
  const run = (id: string, args?: unknown) =>
    void commands.invoke(id, args as never).catch(() => {});
  const align = (kind: AlignKind) => {
    if (!model) return;
    run(ALIGN_COMMAND, { kind, targets: ids.map((id) => model.addressOf(id)) });
  };
  const resizeHint = strings.t(M.resizeHint);
  return (
    <>
      <span
        className="pg-ui-xs"
        data-control-kind
        style={{
          fontWeight: 600,
          color: "var(--pg-fg)",
          padding: "0 4px",
          whiteSpace: "nowrap",
        }}
      >
        {(!multi && owned) || kindLabel(strings, ids)}
      </span>
      <Sep />
      <NumField
        label="X"
        title={strings.t(M.leftEdge)}
        value={box?.left ?? null}
        unit="pt"
        onCommit={box ? (x) => moveBy(x - box.left, 0) : null}
        onStep={(d) => moveBy(d, 0)}
        testId="x"
        length
      />
      <NumField
        label="Y"
        title={strings.t(M.topEdge)}
        value={box?.top ?? null}
        unit="pt"
        onCommit={box ? (y) => moveBy(0, y - box.top) : null}
        onStep={(d) => moveBy(0, d)}
        testId="y"
        length
      />
      <NumField
        label={strings.t(M.widthLabel)}
        title={edgeLeaf ? strings.t(M.width) : resizeHint}
        value={box ? box.right - box.left : null}
        unit="pt"
        min={0.1}
        onCommit={
          box && edgeLeaf
            ? (w) => setEdges({ ...box, right: box.left + w })
            : null
        }
        testId="w"
        length
      />
      <NumField
        label={strings.t(M.heightLabel)}
        title={edgeLeaf ? strings.t(M.height) : resizeHint}
        value={box ? box.bottom - box.top : null}
        unit="pt"
        min={0.1}
        onCommit={
          box && edgeLeaf
            ? (h) => setEdges({ ...box, bottom: box.top + h })
            : null
        }
        testId="h"
        length
      />
      <Sep />
      <PropertyNum
        label="∠"
        title={strings.t(M.rotation)}
        field={rotation}
        unit="°"
        testId="rotation"
      />
      <PropertyNum
        label={strings.t(M.strokeLabel)}
        title={strings.t(M.strokeWeight)}
        field={stroke}
        unit="pt"
        min={0}
        step={0.25}
        digits={2}
        testId="stroke"
      />
      <PropertyNum
        label={strings.t(M.opacityLabel)}
        title={strings.t(M.opacity)}
        field={opacity}
        unit="%"
        min={0}
        max={100}
        digits={0}
        testId="opacity"
      />
      <FreeTransformControls ids={ids} />
      <Sep />
      {multi && (
        <>
          {(
            [
              ["left", "ui-obj-align-left", M.alignLeft],
              ["centerH", "ui-obj-align-center-h", M.centerHorizontally],
              ["right", "ui-obj-align-right", M.alignRight],
              ["top", "ui-obj-align-top", M.alignTop],
              ["centerV", "ui-obj-align-center-v", M.centerVertically],
              ["bottom", "ui-obj-align-bottom", M.alignBottom],
            ] as const
          ).map(([kind, icon, title]) => (
            <ToolPill
              key={kind}
              icon={icon}
              title={strings.t(title)}
              onClick={() => align(kind)}
              testId={`align-${kind}`}
            />
          ))}
          <Sep />
        </>
      )}
      <ToolPill
        icon="ui-arrange-front"
        title={strings.t(M.bringToFront)}
        onClick={() => run("paged.object.bringToFront")}
        testId="bring-front"
      />
      <ToolPill
        icon="ui-arrange-back"
        title={strings.t(M.sendToBack)}
        onClick={() => run("paged.object.sendToBack")}
        testId="send-back"
      />
      {multi && (
        <Chip
          testId="group"
          title={strings.t(M.groupTitle)}
          onClick={() => run("paged.object.group")}
        >
          {strings.t(M.groupAction)}
        </Chip>
      )}
      {isGroup && (
        <Chip
          testId="ungroup"
          title={strings.t(M.ungroupTitle)}
          onClick={() => run("paged.object.ungroup")}
        >
          {strings.t(M.ungroup)}
        </Chip>
      )}
    </>
  );
}

// ── Free Transform (editor ADR 295) ────────────────────────────────

/** A tool setting of the Free Transform tool, read through the store's
 *  subscription (the store's context value never changes identity). */
function useFreeTransformSetting(key: string, fallback: string): string {
  const settings = useToolSettings();
  const value = useSyncExternalStore(
    (onChange) => settings.subscribe(FREE_TRANSFORM_TOOL_ID, onChange),
    () => settings.getValue(FREE_TRANSFORM_TOOL_ID, key),
  );
  return typeof value === "string" ? value : fallback;
}

/** While the Free Transform tool is in hand: the reference-point grid,
 *  the four modes and a numeric shear about the reference point. X, Y,
 *  W, H and the angle are the bar's own fields beside it. */
function FreeTransformControls({ ids }: { ids: readonly ElementId[] }) {
  const strings = useStrings();
  const { effectiveTool } = useTool();
  const settings = useToolSettings();
  const client = useCanvasClient();
  const { placedGeometry } = useSelection();
  const reference = useFreeTransformSetting("reference", "c") as ReferenceKey;
  const mode = useFreeTransformSetting("mode", "freeTransform");
  if (effectiveTool !== FREE_TRANSFORM_TOOL_ID || ids.length === 0) return null;
  const box = freeTransformBoxOf(placedGeometry);
  const set = (key: string, value: string) =>
    settings.set(FREE_TRANSFORM_TOOL_ID, key, value);
  return (
    <>
      <Sep />
      <span
        data-free-transform-controls
        style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
      >
        <span
          role="group"
          aria-label={strings.t(M.referencePoint)}
          style={{
            display: "inline-grid",
            gridTemplateColumns: "repeat(3, 8px)",
            gap: 2,
            padding: 2,
          }}
        >
          {REFERENCE_KEYS.map((k) => (
            <button
              key={k}
              type="button"
              data-reference={k}
              aria-pressed={k === reference}
              title={strings.t(M.referenceAt, {
                point: strings.t(REF_LABEL[k]),
              })}
              onClick={() => set("reference", k)}
              style={{
                width: 8,
                height: 8,
                padding: 0,
                border: "1px solid var(--pg-fg)",
                borderRadius: 1,
                background: k === reference ? "var(--pg-fg)" : "transparent",
                cursor: "pointer",
              }}
            />
          ))}
        </span>
        {BOX_MODES.map((m) => (
          <span key={m} data-box-mode={m} aria-pressed={m === mode}>
            <Chip
              on={m === mode}
              title={strings.t(MODE_LABEL[m])}
              onClick={() => set("mode", m)}
              testId={`ft-mode-${m}`}
            >
              {strings.t(MODE_LABEL[m])}
            </Chip>
          </span>
        ))}
        <NumField
          label={strings.t(M.shearLabel)}
          title={strings.t(M.shear)}
          value={0}
          unit="°"
          min={-85}
          max={85}
          onCommit={
            box
              ? (deg) =>
                  void shearSelectionBy(
                    client,
                    box,
                    referencePointOf(box.quad, reference),
                    deg,
                  ).catch(() => {})
              : null
          }
          testId="ft-shear"
        />
      </span>
    </>
  );
}

// ── text ───────────────────────────────────────────────────────────

const JUSTIFY: ReadonlyArray<readonly [string, string, string]> = [
  ["LeftAlign", "ui-align-left", M.alignLeft],
  ["CenterAlign", "ui-align-center", M.alignCenter],
  ["RightAlign", "ui-align-right", M.alignRight],
  ["LeftJustified", "ui-align-justify", M.justify],
];

function TextControls() {
  const strings = useStrings();
  const paraStyle = useObjectProperty({
    path: "appliedParagraphStyle",
    scope: "content",
  });
  const charStyle = useObjectProperty({
    path: "appliedCharacterStyle",
    scope: "content",
  });
  const family = useObjectProperty({
    path: "characterFontFamily",
    scope: "content",
  });
  const size = useObjectProperty({
    path: "characterFontSize",
    scope: "content",
  });
  const leading = useObjectProperty({
    path: "characterLeading",
    scope: "content",
  });
  const justify = useObjectProperty({
    path: "paragraphJustification",
    scope: "content",
  });
  const paraStyles = useStyleRows("paragraphStyles");
  const charStyles = useStyleRows("characterStyles");
  const fonts = useCollection<FontSummary>("fonts") ?? [];
  const current =
    typeof justify.state === "object" && justify.state.state === "value"
      ? String(justify.state.value)
      : null;
  return (
    <>
      <PropertySelect
        title={strings.t(M.paragraphStyle)}
        field={paraStyle}
        width={150}
        testId="paragraph-style"
        options={paraStyles.map((r) => [r.selfId, cleanStyleName(r.name)])}
      />
      <PropertySelect
        title={strings.t(M.characterStyle)}
        field={charStyle}
        width={130}
        testId="character-style"
        options={charStyles.map((r) => [r.selfId, cleanStyleName(r.name)])}
      />
      <Sep />
      <PropertySelect
        title={strings.t(M.fontFamily)}
        field={family}
        width={150}
        testId="font-family"
        options={fonts.map((f) => [f.family, f.family])}
      />
      <PropertyNum
        label={strings.t(M.sizeLabel)}
        title={strings.t(M.fontSize)}
        field={size}
        unit="pt"
        min={0.1}
        step={0.5}
        testId="font-size"
      />
      <PropertyNum
        label={strings.t(M.leadLabel)}
        title={strings.t(M.leading)}
        field={leading}
        unit="pt"
        min={0}
        step={0.5}
        testId="leading"
        placeholder={strings.t(M.auto)}
      />
      <Sep />
      {JUSTIFY.map(([value, icon, title]) => (
        <ToolPill
          key={value}
          icon={icon}
          title={strings.t(title)}
          on={current === value}
          disabled={!justify.commit}
          onClick={() => void justify.commit?.(value)}
          testId={`justify-${value}`}
        />
      ))}
    </>
  );
}

interface StyleRow {
  selfId: string;
  name: string;
}

/** A style collection, re-read whenever the document changes. */
function useStyleRows(
  collection: "paragraphStyles" | "characterStyles",
): StyleRow[] {
  const client = useCanvasClient();
  const [rows, setRows] = useState<StyleRow[]>([]);
  useEffect(() => {
    let live = true;
    const refresh = () =>
      void client
        .collection<StyleRow>(collection)
        .then((r) => live && setRows([...r]))
        .catch(() => live && setRows([]));
    refresh();
    const off = client.subscribe((msg) => {
      if (
        msg.kind === "documentLoaded" ||
        msg.kind === "mutationApplied" ||
        msg.kind === "undoApplied" ||
        msg.kind === "redoApplied"
      )
        refresh();
    });
    return () => {
      live = false;
      off();
    };
  }, [client, collection]);
  return rows;
}

/** `$ID/[No paragraph style]` → `[No paragraph style]`; `Body/Lead` keeps its group. */
function cleanStyleName(name: string): string {
  return name.replace(/^\$ID\//, "");
}

// ── fields ─────────────────────────────────────────────────────────

type Prop = ReturnType<typeof useObjectProperty>;

function readNumber(field: Prop): number | null | "mixed" {
  const s = field.state;
  if (s.state === "mixed") return "mixed";
  // Unset on a writable target reads as the schema's default (an
  // untouched frame's opacity is 100, not blank).
  if (
    s.state === "absent" &&
    field.commit &&
    typeof field.row?.default === "number"
  ) {
    return field.row.default;
  }
  if (s.state !== "value") return null;
  const v = s.value as unknown;
  // Inherited (the run sets nothing): the schema default when it has one.
  if (v === null && typeof field.row?.default === "number")
    return field.row.default;
  if (typeof v === "number") return v;
  if (
    v &&
    typeof v === "object" &&
    typeof (v as { value?: unknown }).value === "number"
  )
    return (v as { value: number }).value;
  return null;
}

function PropertyNum(p: {
  label: string;
  title: string;
  field: Prop;
  unit: string;
  min?: number;
  max?: number;
  step?: number;
  digits?: number;
  testId: string;
  /** Shown when the value is inherited and has no default ("Auto"). */
  placeholder?: string;
}) {
  const commit = p.field.commit;
  return (
    <NumField
      label={p.label}
      title={p.field.error ? `${p.title} — ${p.field.error}` : p.title}
      value={readNumber(p.field)}
      unit={p.unit}
      min={p.min}
      max={p.max}
      step={p.step}
      digits={p.digits}
      onCommit={commit ? (n) => void commit(n) : null}
      testId={p.testId}
      fieldState={p.field.state.state}
      placeholder={p.placeholder}
    />
  );
}

/** A compact numeric field: label · value · unit on one line — the one
 *  numeric field's `bar` variant: expressions and units ("10mm + 2pt",
 *  "+=5"), Enter or blur commits, Escape reverts, ↑/↓ steps (⇧ ×10), the
 *  label scrubs (one commit on release), a mixed selection reads "Mixed".
 *  Read-only (no commit) renders muted. */
function NumField(p: {
  label: string;
  title: string;
  value: number | null | "mixed";
  unit: string;
  onCommit: ((n: number) => void) | null;
  min?: number;
  max?: number;
  step?: number;
  digits?: number;
  testId: string;
  /** The object-model read verdict, stamped for scripts and specs. */
  fieldState?: string;
  placeholder?: string;
  /** Relative write for a step (a move by `delta`), where an absolute
   *  commit would be computed against a position not yet re-read. */
  onStep?: (delta: number) => void;
  /** A geometry length: shown and stepped in the document unit (ADR 245);
   *  `value`, `min` and the commits stay in points. */
  length?: boolean;
}) {
  const docUnit = useDocumentUnit();
  const title = p.length ? p.title.replace("(pt)", `(${docUnit})`) : p.title;
  const commit = p.onCommit;
  return (
    <NumericField
      variant="bar"
      label={p.label}
      title={title}
      aria-label={title}
      value={p.value === "mixed" ? null : p.value}
      mixed={p.value === "mixed"}
      length={p.length}
      suffix={p.length ? undefined : p.unit}
      precision={p.length ? undefined : (p.digits ?? 1)}
      min={p.min}
      max={p.max}
      step={p.step ?? 1}
      placeholder={p.placeholder}
      readOnly={!commit || (p.value === null && !p.placeholder)}
      onCommit={commit ? (n) => commit(n) : undefined}
      onStep={p.onStep}
      dataAttributes={{
        "data-control-field": p.testId,
        ...(p.fieldState ? { "data-field-state": p.fieldState } : {}),
      }}
    />
  );
}

function PropertySelect(p: {
  title: string;
  field: Prop;
  options: ReadonlyArray<readonly [string, string]>;
  width: number;
  testId: string;
}) {
  const strings = useStrings();
  const s = p.field.state;
  const value = s.state === "value" ? String(s.value ?? "") : "";
  const known = p.options.some(([v]) => v === value);
  return (
    <select
      title={p.field.error ? `${p.title} — ${p.field.error}` : p.title}
      aria-label={p.title}
      data-control-field={p.testId}
      value={s.state === "value" ? value : "__none__"}
      disabled={!p.field.commit}
      onChange={(e) => {
        if (e.target.value !== "__none__")
          void p.field.commit?.(e.target.value);
      }}
      onKeyDown={(e) => e.stopPropagation()}
      style={{ ...selectBox, width: p.width }}
    >
      {s.state !== "value" && (
        <option value="__none__" disabled>
          {s.state === "mixed" ? strings.t(M.mixed) : p.title}
        </option>
      )}
      {p.options.map(([v, label]) => (
        <option key={v} value={v}>
          {label}
        </option>
      ))}
      {s.state === "value" && !known && value !== "" && (
        <option value={value}>{cleanStyleName(value)}</option>
      )}
    </select>
  );
}

function Label({ children }: { children: ReactNode }) {
  return (
    <span
      className="pg-ui-xs"
      style={{ color: "var(--pg-muted-fg)", paddingLeft: 4 }}
    >
      {children}
    </span>
  );
}

const valueText: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontVariantNumeric: "tabular-nums",
  fontSize: 12,
  color: "var(--pg-fg)",
  whiteSpace: "nowrap",
};

const selectBox: CSSProperties = {
  height: 28,
  padding: "0 6px",
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--chrome-divider)",
  background: "var(--pg-muted)",
  color: "var(--pg-fg)",
  fontFamily: "var(--font-sans)",
  fontSize: 12,
  flexShrink: 0,
};
