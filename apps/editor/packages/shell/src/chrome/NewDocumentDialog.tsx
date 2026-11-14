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

// File ▸ New document… (editor ADR 1220; UX audit F-04; the UX strategy's
// §6.5). Purpose presets first (Print, Digital, Structured), every field
// at once beside them (Custom is any change), and a miniature of the page
// with its bleed, margins and columns that follows each change. Create
// remembers the setup, makes its unit the editor's (ADR 245) and runs the
// one New path (`paged.file.new` with the setup: the replace question,
// then the blank document and its setup as one undo step). A field that
// cannot be created says why beside it, and Create waits (UXI-FBK-001).
// Facing pages are a switch (engine ADR 1307): the engine lays the pages
// out as facing spreads, and the miniature shows the spread.

import { useEffect, useState } from "react";
import { defineMessages, useStrings } from "@paged-media/strings";
import { Segment, Tab } from "@paged-media/panel-kit";
import {
  DOCUMENT_UNITS,
  KitSelect,
  LengthInput,
  NumberInput,
  formatLengthPair,
  setDocumentUnit,
  type LengthUnit,
} from "@paged-media/ui";

import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { Row } from "../components/cockpit/kit";
import { parseStored } from "../lib/stored-settings";
import { PAGED_FILE_NEW } from "../state/commands/file-commands";
import {
  createEmitter,
  scoped,
  useScoped,
  type EditorScope,
} from "../state/editor-scope";
import {
  categoryOf,
  defaultSetup,
  isValidSetup,
  orientationOf,
  paperFamilyOf,
  presetsIn,
  previewGeometry,
  PRESET_CATEGORIES,
  readStoredSetup,
  setupOfPreset,
  validateSetup,
  withOrientation,
  type Margins,
  type NewDocumentSetup,
  type Orientation,
  type PaperFamily,
  type PresetCategory,
  type PresetId,
  type SetupProblem,
} from "../state/new-document-presets";
import { useRegistries } from "../state/registries-context";
import { useEditorStorage, type StorageAdapter } from "../state/storage";

const M = defineMessages("shell.newDocumentDialog", {
  title: "New document",
  description:
    "Start from a purpose, then adjust any field. The preview shows the page with its bleed, margins and columns.",
  print: "Print",
  digital: "Digital",
  structured: "Structured",
  custom: "Custom",
  customHint:
    "Every field on the right is yours to set. A change to a preset makes it a custom setup.",
  magazine: "Magazine",
  book: "Book",
  brochure: "Brochure",
  poster: "Poster",
  businessCard: "Business card",
  packaging: "Packaging",
  pdfPublication: "PDF publication",
  presentation: "Presentation",
  webOutput: "Web output",
  marketingGraphic: "Marketing graphic",
  catalog: "Catalog",
  productSheet: "Product sheet",
  variableData: "Variable-data template",
  purpose: "Purpose",
  width: "Width",
  height: "Height",
  orientation: "Orientation",
  portrait: "Portrait",
  landscape: "Landscape",
  units: "Units",
  pages: "Pages",
  facingPages: "Facing pages",
  facingHint: "Page 1 on the right, then left and right pages in spreads.",
  bleed: "Bleed",
  margins: "Margins",
  top: "Top",
  bottom: "Bottom",
  inside: "Inside",
  outside: "Outside",
  columns: "Columns",
  gutter: "Gutter",
  preview: "Preview of the page",
  summary:
    "{size} · {pages, plural, one {# page} other {# pages}} · {columns, plural, one {# column} other {# columns}}",
  cancel: "Cancel",
  create: "Create",
  pt: "Points",
  pc: "Picas",
  in: "Inches",
  mm: "Millimetres",
  cm: "Centimetres",
  px: "Pixels",
  sizeRange: "A page is between 1 pt and 216 in on each side.",
  pagesRange: "Between 1 and 999 pages.",
  bleedRange: "A bleed is between 0 and 6 in.",
  marginsTooTall: "The top and bottom margins leave no room on the page.",
  marginsTooWide: "The inside and outside margins leave no room on the page.",
  columnsRange: "Between 1 and 216 columns.",
  columnsTooNarrow: "The columns and gutters do not fit between the margins.",
});

/** The setting the dialog remembers its last setup under (ADR 247). */
export const NEW_DOCUMENT_KEY = "paged.newDocument.v1";

type DialogAction = "open" | "close";
const DIALOG = scoped("newDocumentDialog", () => createEmitter<DialogAction>());

/** Open (or close) `scope`'s New document dialog. */
export function notifyNewDocumentDialog(
  scope: EditorScope,
  action: DialogAction = "open",
): void {
  scope.get(DIALOG).emit(action);
}

/** The reader's paper family, from the browser's locale. */
function readerPaper(): PaperFamily {
  return paperFamilyOf(globalThis.navigator?.language);
}

/** The setup the dialog opens with: the remembered one, else the
 *  locale's default (ADR 247: a stored value is read field by field). */
export function initialSetup(
  storage: StorageAdapter,
  family: PaperFamily = readerPaper(),
): NewDocumentSetup {
  const fallback = defaultSetup(family);
  let raw: string | null = null;
  try {
    raw = storage.getItem(NEW_DOCUMENT_KEY);
  } catch {
    return fallback;
  }
  return readStoredSetup(parseStored(raw), fallback) ?? fallback;
}

function remember(storage: StorageAdapter, setup: NewDocumentSetup): void {
  try {
    storage.setItem(NEW_DOCUMENT_KEY, JSON.stringify(setup));
  } catch {
    /* quota or a refused storage — remembering is a convenience only */
  }
}

const CATEGORY_WORDS: Record<PresetCategory, string> = {
  print: M.print,
  digital: M.digital,
  structured: M.structured,
  custom: M.custom,
};

export function NewDocumentDialog() {
  const strings = useStrings();
  const storage = useEditorStorage();
  const registries = useRegistries();
  const [open, setOpen] = useState(false);
  const [setup, setSetup] = useState<NewDocumentSetup>(() =>
    initialSetup(storage),
  );
  const [category, setCategory] = useState<PresetCategory>(() =>
    categoryOf(setup),
  );
  const family = readerPaper();

  const dialog = useScoped(DIALOG);
  useEffect(
    () =>
      dialog.subscribe((action) => {
        if (action === "open") {
          const start = initialSetup(storage);
          setSetup(start);
          setCategory(categoryOf(start));
        }
        setOpen(action === "open");
      }),
    [dialog, storage],
  );

  const problems = validateSetup(setup);
  const valid = isValidSetup(setup);
  const problem = (p: SetupProblem | undefined) =>
    p ? (
      <div data-new-document-problem={p} role="alert" style={problemStyle}>
        {strings.t(M[p])}
      </div>
    ) : null;

  /** A field changed: the setup is custom from now on. */
  const edit = (patch: Partial<NewDocumentSetup>) =>
    setSetup((s) => ({ ...s, ...patch, preset: "custom" }));
  const editMargin = (side: keyof Margins, pt: number) =>
    setSetup((s) => ({
      ...s,
      preset: "custom",
      margins: { ...s.margins, [side]: pt },
    }));
  const choose = (id: PresetId) => setSetup(setupOfPreset(id, family));
  const turn = (o: Orientation) =>
    setSetup((s) => ({ ...withOrientation(s, o), preset: "custom" }));

  const create = () => {
    if (!valid) return;
    remember(storage, setup);
    setDocumentUnit(setup.unit);
    setOpen(false);
    // The one New path: the replace question, then the document.
    void registries.commands.invoke(PAGED_FILE_NEW, setup);
  };

  const unit = setup.unit;
  const length = (
    label: string,
    valuePt: number,
    onPt: (pt: number) => void,
    testId: string,
    min = 0,
  ) => (
    <span data-new-document-field={testId} style={{ minWidth: 0 }}>
      <LengthInput
        aria-label={label}
        valuePt={valuePt}
        defaultUnit={unit}
        min={min}
        onChangePt={onPt}
      />
    </span>
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        data-new-document-dialog
        data-new-document-preset={setup.preset}
        className="max-w-[860px]"
      >
        <DialogHeader>
          <DialogTitle>{strings.t(M.title)}</DialogTitle>
          <DialogDescription>{strings.t(M.description)}</DialogDescription>
        </DialogHeader>
        <div style={bodyStyle}>
          {/* Purpose: the categories and their presets. */}
          <div style={{ minWidth: 0 }}>
            <div
              role="tablist"
              aria-label={strings.t(M.purpose)}
              style={tabsStyle}
            >
              {PRESET_CATEGORIES.map((c) => (
                <Tab
                  key={c}
                  selected={category === c}
                  data-new-document-category={c}
                  onClick={() => setCategory(c)}
                  style={tabStyle(category === c)}
                >
                  {strings.t(CATEGORY_WORDS[c])}
                </Tab>
              ))}
            </div>
            {category === "custom" ? (
              <p data-new-document-custom style={hintStyle}>
                {strings.t(M.customHint)}
              </p>
            ) : (
              <div role="tabpanel" style={presetGridStyle}>
                {presetsIn(category).map((p) => {
                  const s = setupOfPreset(p.id, family);
                  return (
                    <Segment
                      key={p.id}
                      pressed={setup.preset === p.id}
                      data-new-document-preset-option={p.id}
                      onClick={() => choose(p.id)}
                      style={presetStyle(setup.preset === p.id)}
                    >
                      <span style={{ fontWeight: 600 }}>
                        {strings.t(M[p.id])}
                      </span>
                      <span style={presetSizeStyle}>
                        {formatLengthPair(s.widthPt, s.heightPt, s.unit)}
                      </span>
                    </Segment>
                  );
                })}
              </div>
            )}
          </div>

          {/* The preview and every field. */}
          <div style={{ minWidth: 0 }}>
            <Preview setup={setup} label={strings.t(M.preview)} />
            <p data-new-document-summary style={summaryStyle}>
              {strings.t(M.summary, {
                size: formatLengthPair(setup.widthPt, setup.heightPt, unit),
                pages: setup.pages,
                columns: setup.columns,
              })}
            </p>
            <div style={pairStyle}>
              <Row label={strings.t(M.width)}>
                {length(
                  strings.t(M.width),
                  setup.widthPt,
                  (pt) => edit({ widthPt: pt }),
                  "width",
                  1,
                )}
              </Row>
              <Row label={strings.t(M.height)}>
                {length(
                  strings.t(M.height),
                  setup.heightPt,
                  (pt) => edit({ heightPt: pt }),
                  "height",
                  1,
                )}
              </Row>
            </div>
            {problem(problems.width ?? problems.height)}
            <Row label={strings.t(M.orientation)}>
              <span style={{ display: "flex", gap: 4 }}>
                {(["portrait", "landscape"] as const).map((o) => (
                  <Segment
                    key={o}
                    pressed={orientationOf(setup) === o}
                    data-new-document-orientation={o}
                    onClick={() => turn(o)}
                    style={segmentStyle(orientationOf(setup) === o)}
                  >
                    {strings.t(M[o])}
                  </Segment>
                ))}
              </span>
            </Row>
            <div style={pairStyle}>
              <Row label={strings.t(M.units)}>
                <KitSelect
                  data-new-document-units=""
                  value={unit}
                  onChange={(e) => {
                    const next = e.target.value as LengthUnit;
                    setSetup((s) => ({ ...s, unit: next }));
                  }}
                >
                  {DOCUMENT_UNITS.map(([u]) => (
                    <option key={u} value={u}>
                      {strings.t(M[u])}
                    </option>
                  ))}
                </KitSelect>
              </Row>
              <Row label={strings.t(M.pages)}>
                <span data-new-document-field="pages">
                  <NumberInput
                    value={setup.pages}
                    precision={0}
                    min={1}
                    max={999}
                    onChange={(n) => edit({ pages: Math.round(n) })}
                  />
                </span>
              </Row>
            </div>
            {problem(problems.pages)}
            <Row label={strings.t(M.facingPages)}>
              <label style={facingStyle}>
                <input
                  type="checkbox"
                  data-new-document-facing=""
                  checked={setup.facingPages === true}
                  onChange={(e) => edit({ facingPages: e.target.checked })}
                />
                <span style={unavailableStyle}>{strings.t(M.facingHint)}</span>
              </label>
            </Row>
            <Row label={strings.t(M.bleed)}>
              {length(
                strings.t(M.bleed),
                setup.bleedPt,
                (pt) => edit({ bleedPt: pt }),
                "bleed",
              )}
            </Row>
            {problem(problems.bleed)}
            <div style={groupLabelStyle}>{strings.t(M.margins)}</div>
            <div style={pairStyle}>
              <Row label={strings.t(M.top)}>
                {length(
                  strings.t(M.top),
                  setup.margins.top,
                  (pt) => editMargin("top", pt),
                  "marginTop",
                )}
              </Row>
              <Row label={strings.t(M.bottom)}>
                {length(
                  strings.t(M.bottom),
                  setup.margins.bottom,
                  (pt) => editMargin("bottom", pt),
                  "marginBottom",
                )}
              </Row>
              <Row label={strings.t(M.inside)}>
                {length(
                  strings.t(M.inside),
                  setup.margins.inside,
                  (pt) => editMargin("inside", pt),
                  "marginInside",
                )}
              </Row>
              <Row label={strings.t(M.outside)}>
                {length(
                  strings.t(M.outside),
                  setup.margins.outside,
                  (pt) => editMargin("outside", pt),
                  "marginOutside",
                )}
              </Row>
            </div>
            {problem(problems.marginsVertical ?? problems.marginsHorizontal)}
            <div style={pairStyle}>
              <Row label={strings.t(M.columns)}>
                <span data-new-document-field="columns">
                  <NumberInput
                    value={setup.columns}
                    precision={0}
                    min={1}
                    max={216}
                    onChange={(n) => edit({ columns: Math.round(n) })}
                  />
                </span>
              </Row>
              <Row label={strings.t(M.gutter)}>
                {length(
                  strings.t(M.gutter),
                  setup.gutterPt,
                  (pt) => edit({ gutterPt: pt }),
                  "gutter",
                )}
              </Row>
            </div>
            {problem(problems.columns ?? problems.gutter)}
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            data-new-document-cancel
            onClick={() => setOpen(false)}
          >
            {strings.t(M.cancel)}
          </Button>
          <Button data-new-document-create disabled={!valid} onClick={create}>
            {strings.t(M.create)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The miniature: bleed, page, margins and columns, drawn to scale. */
function Preview({ setup, label }: { setup: NewDocumentSetup; label: string }) {
  const g = previewGeometry(setup, { width: 240, height: 150 });
  return (
    <svg
      role="img"
      aria-label={label}
      data-new-document-preview
      data-preview-columns={g.columns.length}
      data-preview-bleed={g.bleed ? "true" : "false"}
      data-preview-facing={g.facing ? "true" : "false"}
      width="100%"
      viewBox={`0 0 ${g.width} ${g.height}`}
      style={previewStyle}
    >
      {g.bleed && (
        <rect
          data-preview-bleed-box
          x={g.bleed.x}
          y={g.bleed.y}
          width={g.bleed.w}
          height={g.bleed.h}
          fill="none"
          stroke="var(--status-error)"
          strokeWidth={0.75}
          strokeDasharray="3 2"
        />
      )}
      {g.facing && (
        <>
          <rect
            data-preview-facing-page
            x={g.facing.page.x}
            y={g.facing.page.y}
            width={g.facing.page.w}
            height={g.facing.page.h}
            fill="#ffffff"
            stroke="var(--chrome-border)"
            strokeWidth={0.75}
          />
          <rect
            data-preview-facing-margins
            x={g.facing.margins.x}
            y={g.facing.margins.y}
            width={g.facing.margins.w}
            height={g.facing.margins.h}
            fill="none"
            stroke="var(--overlay-guide)"
            strokeWidth={0.75}
          />
        </>
      )}
      <rect
        data-preview-page
        x={g.page.x}
        y={g.page.y}
        width={g.page.w}
        height={g.page.h}
        // The paper is the content's colour, not a chrome token.
        fill="#ffffff"
        stroke="var(--chrome-border)"
        strokeWidth={0.75}
      />
      {g.columns.map((c, i) => (
        <rect
          key={i}
          data-preview-column={i}
          x={c.x}
          y={c.y}
          width={c.w}
          height={c.h}
          fill="color-mix(in srgb, var(--pg-primary) 10%, transparent)"
        />
      ))}
      <rect
        data-preview-margins
        x={g.margins.x}
        y={g.margins.y}
        width={g.margins.w}
        height={g.margins.h}
        fill="none"
        stroke="var(--overlay-guide)"
        strokeWidth={0.75}
      />
    </svg>
  );
}

const bodyStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 300px) minmax(0, 1fr)",
  gap: 20,
  maxHeight: "min(64vh, 640px)",
  overflowY: "auto",
};

const tabsStyle: React.CSSProperties = {
  display: "flex",
  gap: 2,
  borderBottom: "1px solid var(--chrome-border)",
  marginBottom: 10,
};

const tabStyle = (on: boolean): React.CSSProperties => ({
  border: "none",
  background: "transparent",
  padding: "6px 8px",
  fontSize: 12.5,
  fontFamily: "var(--font-sans)",
  color: on ? "var(--pg-fg)" : "var(--pg-muted-fg)",
  borderBottom: on ? "2px solid var(--pg-primary)" : "2px solid transparent",
  cursor: "pointer",
});

const presetGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: 6,
};

const presetStyle = (on: boolean): React.CSSProperties => ({
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  gap: 2,
  padding: "8px 10px",
  borderRadius: "var(--radius-md)",
  border: `1px solid ${on ? "var(--pg-primary)" : "var(--chrome-border)"}`,
  background: on
    ? "color-mix(in srgb, var(--pg-primary) 12%, transparent)"
    : "transparent",
  color: "var(--pg-fg)",
  fontSize: 12.5,
  fontFamily: "var(--font-sans)",
  textAlign: "left",
  cursor: "pointer",
});

const presetSizeStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  fontVariantNumeric: "tabular-nums",
  color: "var(--pg-muted-fg)",
};

const segmentStyle = (on: boolean): React.CSSProperties => ({
  height: 28,
  padding: "0 10px",
  borderRadius: 6,
  border: `1px solid ${on ? "var(--pg-primary)" : "var(--chrome-border)"}`,
  background: on
    ? "color-mix(in srgb, var(--pg-primary) 12%, transparent)"
    : "transparent",
  color: "var(--pg-fg)",
  fontSize: 12,
  cursor: "pointer",
});

const hintStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 12,
  lineHeight: 1.5,
  color: "var(--pg-muted-fg)",
};

const previewStyle: React.CSSProperties = {
  display: "block",
  maxHeight: 150,
  borderRadius: "var(--radius-md)",
  background: "var(--canvas-surround)",
};

const summaryStyle: React.CSSProperties = {
  margin: "6px 0 10px",
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  fontVariantNumeric: "tabular-nums",
  color: "var(--pg-muted-fg)",
};

const pairStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  columnGap: 12,
};

const groupLabelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  color: "var(--pg-muted-fg)",
  margin: "4px 0 6px",
};

const facingStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
};

const unavailableStyle: React.CSSProperties = {
  fontSize: 12,
  lineHeight: 1.4,
  color: "var(--pg-muted-fg)",
};

const problemStyle: React.CSSProperties = {
  margin: "-4px 0 8px",
  fontSize: 12,
  color: "var(--status-error)",
};
