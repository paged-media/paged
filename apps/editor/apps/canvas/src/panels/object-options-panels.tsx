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

// ADR 323 — options panels for the document's named objects, as
// schema-driven forms over their object-model addresses:
//
//   · Swatch Options   `swatch:<id>`        name, model, tint, alpha, ink
//                                             settings — and the colour as
//                                             ONE atomic write of the whole
//                                             `color` struct (space, value,
//                                             model together: setting
//                                             `space` then `value` would
//                                             convert through an
//                                             intermediate colour);
//   · Text Variables   `textVariable:<id>`  the variable's definition;
//   · Section Options  `section:<id>`       prefix, numbering style, start;
//   · Guides           `guide:<id>`         position.
//
// Lists come from the document collections where the wire has one
// (swatches, sections) and from `host.objects.query` otherwise (text
// variables and guides are addressable but have no collection). Every
// field writes through `host.objects`, offers "Bind to data…" and shows
// the binding badge.

import { useEffect, useState, type ReactNode } from "react";

import {
  CockpitBtn,
  CockpitPanelHeader,
  CockpitRow,
  ObjectFieldFrame,
  displayName,
  useCollection,
  useDocument,
  useObjectField,
  useObjectModel,
} from "@paged-media/shell";
import { FieldInput, FieldSelect } from "@paged-media/panel-kit";
import { formatAddress } from "@paged-media/plugin-sdk";
import type {
  ConditionSummary,
  GuideSummary,
  SectionSummary,
  SpreadSummary,
  SwatchSummary,
} from "@paged-media/client";

import { defineMessages, useStrings, type Strings } from "@paged-media/strings";

import { SchemaSections, type SectionSpec } from "./schema-sections";
import { sectionsIn } from "./section-strings";
import { CoreCommandButton, newMasterPrefill } from "../core-command-dialog";

const M = defineMessages("app.objectOptionsPanels", {
  swatch: "Swatch",
  name: "Name",
  type: "Type",
  tint: "Tint",
  alpha: "Alpha",
  alternate: "Alternate",
  space: "Space",
  value: "Value",
  ink: "Ink",
  toProcess: "To process",
  aliasTo: "Alias to",
  definition: "Definition",
  text: "Text",
  textBefore: "Text before",
  textAfter: "Text after",
  dateFormat: "Date format",
  gradient: "Gradient",
  stops: "Stops",
  colour: "Colour",
  location: "Location",
  midpoint: "Midpoint",
  pageNumbering: "Page Numbering",
  prefix: "Prefix",
  style: "Style",
  startAt: "Start at",
  guide: "Guide",
  position: "Position",
  colorGroup: "Color group",
  swatches: "Swatches",
  numberingList: "Numbering list",
  continueAcrossStories: "Continue across stories",
  continueAcrossDocuments: "Continue across documents",
  condition: "Condition",
  visible: "Visible",
  master: "Master",
  field: "Field",
  applyColour: "Apply colour",
  swatchOptions: "Swatch Options",
  noEditableSwatches: "This document has no editable swatches.",
  textVariables: "Text Variables",
  textVariable: "Text Variable",
  pickColorGroup: "Color Group",
  pickNumberingList: "Numbering List",
  noTextVariables: "No text variables (or this engine does not list them yet).",
  new: "New…",
  delete: "Delete",
  newVariable: "New variable",
  gradientOptions: "Gradient Options",
  noGradients: "This document has no gradients.",
  newGradient: "New gradient",
  sectionOptions: "Numbering & Section Options",
  section: "Section",
  deleteSection: "Delete section",
  noSections: "This document has no numbering sections.",
  verticalGuide: "Vertical guide at {at} pt, page {page}",
  horizontalGuide: "Horizontal guide at {at} pt, page {page}",
  guides: "Guides",
  noGuides: "No ruler guides (or this engine does not list them yet).",
  colorGroupOptions: "Color Group Options",
  noColorGroups: "This document has no color groups.",
  numberingListOptions: "Numbering List Options",
  noNumberingLists: "This document has no numbering lists.",
  conditionOptions: "Condition Options",
  noConditions: "This document has no conditions.",
  masterOptions: "Master Options",
  noMasters: "This document has no master spreads.",
  rename: "Rename…",
  textFields: "Text Fields",
  textField: "Text Field",
  noTextFields: "No text fields (Insert ▸ Field adds a placeholder).",
  insert: "Insert…",
  setValue: "Set value…",
});

// Section titles and field labels below are message keys (`sectionsIn`).

const SELECT =
  "h-[28px] w-full rounded-[6px] border border-input bg-background px-2 text-[12px]";

/** Addresses matching a selector, refreshed on every object change. */
function useQuery(selector: string): string[] | null {
  const model = useObjectModel();
  const [list, setList] = useState<string[] | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!model) return;
    const d = model.objects.onDidChange(() => setTick((n) => n + 1));
    return () => d.dispose();
  }, [model]);
  useEffect(() => {
    if (!model) {
      setList([]);
      return;
    }
    let cancelled = false;
    void model.objects
      .query(selector)
      .then((r) => {
        if (!cancelled) setList(r);
      })
      .catch(() => {
        if (!cancelled) setList([]);
      });
    return () => {
      cancelled = true;
    };
  }, [model, selector, tick]);
  return list;
}

/** Each address's own `name`, when it has one: the picker listed raw ids
 *  ("ua400f2") for objects whose names the document carries. */
function useObjectNames(
  list: readonly string[] | null,
  namePath: string,
): Map<string, string> {
  const model = useObjectModel();
  const [names, setNames] = useState<Map<string, string>>(new Map());
  // The addresses by value: the effect reads them back from the key, so a
  // new array with the same addresses does not run it again.
  const key = JSON.stringify(list ?? []);
  // …and again after every change to the objects: a rename keeps the list
  // and changes a name (PN-208).
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!model) return;
    const d = model.objects.onDidChange(() => setTick((n) => n + 1));
    return () => d.dispose();
  }, [model]);
  useEffect(() => {
    const addresses = JSON.parse(key) as string[];
    if (!model || addresses.length === 0) {
      setNames(new Map());
      return;
    }
    let cancelled = false;
    void Promise.all(addresses.map((a) => objectName(model, a, namePath))).then(
      (pairs) => {
        if (!cancelled)
          setNames(
            new Map(
              pairs.filter((p): p is readonly [string, string] => p !== null),
            ),
          );
      },
    );
    return () => {
      cancelled = true;
    };
  }, [model, key, tick, namePath]);
  return names;
}

/** An address and its own name, or null (no name, or a refused read).
 *  Outside the hook: the compiler does not compile a conditional inside a
 *  `try` (ADR 229). */
async function objectName(
  model: NonNullable<ReturnType<typeof useObjectModel>>,
  address: string,
  namePath: string,
): Promise<readonly [string, string] | null> {
  try {
    const v = await model.objects.get(address, namePath);
    return v.kind === "value" && typeof v.value === "string" && v.value !== ""
      ? ([address, v.value] as const)
      : null;
  } catch {
    return null;
  }
}

function Picker({
  testId,
  value,
  options,
  onChange,
}: {
  testId: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange(v: string): void;
}) {
  return (
    <FieldSelect
      data-options-picker={testId}
      className={SELECT}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </FieldSelect>
  );
}

function Empty({ children }: { children: string }) {
  return (
    <div
      className="px-3.5 pb-3 text-xs"
      style={{ color: "var(--pg-muted-fg)" }}
      data-options-empty=""
    >
      {children}
    </div>
  );
}

// ------------------------------------------------------ swatch options

const SWATCH_SECTIONS: readonly SectionSpec[] = [
  {
    title: M.swatch,
    fields: [
      { path: "name", label: M.name },
      { path: "model", label: M.type },
      { path: "tint", label: M.tint },
      { path: "alpha", label: M.alpha },
    ],
  },
  {
    title: M.alternate,
    fields: [
      { path: "alternateSpace", label: M.space },
      { path: "alternateValue", label: M.value },
    ],
  },
  {
    title: M.ink,
    fields: [
      { path: "convertToProcess", label: M.toProcess },
      { path: "inkAliasTo", label: M.aliasTo, collection: "swatches" },
    ],
  },
];

const SPACES = ["CMYK", "RGB", "LAB", "Gray"] as const;
const COMPONENTS: Record<string, number> = { CMYK: 4, RGB: 3, LAB: 3, Gray: 1 };

/** The whole colour (`swatch.color`) as ONE write: space + components
 *  (+ the model it carries) go together. */
function SwatchColorEditor({ address }: { address: string }) {
  const targets = [address];
  const field = useObjectField({ path: "color", targets, schemaKind: address });
  const current =
    field.state.state === "value" &&
    field.state.value &&
    typeof field.state.value === "object"
      ? (field.state.value as { space?: string; value?: number[] } & Record<
          string,
          unknown
        >)
      : null;
  const [space, setSpace] = useState<string>("CMYK");
  const [text, setText] = useState("");
  useEffect(() => {
    setSpace(current?.space ?? "CMYK");
    setText(
      (current?.value ?? [])
        .map((n) => String(Math.round(n * 1000) / 1000))
        .join(", "),
    );
  }, [current?.space, JSON.stringify(current?.value)]); // eslint-disable-line react-hooks/exhaustive-deps
  const parts = text
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number);
  const valid =
    parts.length === COMPONENTS[space] &&
    parts.every((n) => Number.isFinite(n));
  const commit = field.commit;
  const strings = useStrings();
  return (
    <ObjectFieldFrame field={field} className="relative flex flex-col gap-1.5">
      <CockpitRow label={strings.t(M.space)}>
        <FieldSelect
          data-swatch-color-space=""
          className={SELECT}
          value={space}
          disabled={!commit}
          onChange={(e) => setSpace(e.target.value)}
        >
          {SPACES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </FieldSelect>
      </CockpitRow>
      <CockpitRow label={strings.t(M.value)}>
        <FieldInput
          data-swatch-color-value=""
          className={`${SELECT} font-mono`}
          value={text}
          disabled={!commit}
          aria-invalid={!valid}
          onChange={(e) => setText(e.target.value)}
        />
      </CockpitRow>
      <div>
        <CockpitBtn
          sm
          testId="swatch-color-apply"
          disabled={!commit || !valid}
          onClick={() =>
            void commit?.({ ...(current ?? {}), space, value: parts })
          }
        >
          {strings.t(M.applyColour)}
        </CockpitBtn>
      </div>
    </ObjectFieldFrame>
  );
}

const swatchAddress = (selfId: string): string =>
  formatAddress({ kind: "swatch", name: selfId } as never);

export function SwatchOptionsPanel() {
  const strings = useStrings();
  const swatches = useCollection<SwatchSummary>("swatches");
  const [pick, setPick] = useState("");
  // [None], [Registration] and [Black] are reserved, as in the Swatches
  // grid and in InDesign, where Swatch Options cannot edit them (PN-165).
  const editable = (swatches ?? []).filter(
    (s) => s.kind !== "none" && s.kind !== "registration" && s.kind !== "black",
  );
  // A string, said so: the compiler cannot tell an element read off the
  // collection is not mutated later, and would not memoize on it (ADR 229).
  const selfId = String(
    pick && editable.some((s) => s.selfId === pick)
      ? pick
      : (editable[0]?.selfId ?? ""),
  );
  const address = selfId ? swatchAddress(selfId) : null;
  // One array per swatch, for the fields' effects below.
  const targets = address ? [address] : [];
  return (
    <div
      data-swatch-options-panel={swatches ? "ready" : "loading"}
      data-options-target={address ?? ""}
    >
      <CockpitPanelHeader title={strings.t(M.swatchOptions)} />
      <div className="px-3.5 pb-2">
        <CockpitRow label={strings.t(M.swatch)}>
          <Picker
            testId="swatch"
            value={selfId}
            options={editable.map((s) => ({
              value: s.selfId,
              label: displayName(s.name),
            }))}
            onChange={setPick}
          />
        </CockpitRow>
      </div>
      {address ? (
        <>
          <div className="px-3.5 pb-2">
            <SwatchColorEditor key={address} address={address} />
          </div>
          <SchemaSections
            key={address}
            targets={targets}
            sections={sectionsIn(strings, SWATCH_SECTIONS)}
            testId="swatch"
          />
        </>
      ) : (
        <Empty>{strings.t(M.noEditableSwatches)}</Empty>
      )}
    </div>
  );
}

// ------------------------------------------------------ text variables

const TEXT_VARIABLE_SECTIONS: readonly SectionSpec[] = [
  {
    title: M.definition,
    fields: [
      { path: "textVariableName", label: M.name },
      { path: "textVariableType", label: M.type },
      { path: "textVariableContents", label: M.text },
      { path: "textVariableTextBefore", label: M.textBefore },
      { path: "textVariableTextAfter", label: M.textAfter },
      { path: "textVariableDateFormat", label: M.dateFormat },
    ],
  },
];

/** The id half of an address (`textVariable:<id>` → `<id>`). */
const idOf = (address: string) => address.slice(address.indexOf(":") + 1);

function AddressListPanel({
  title,
  picker,
  testId,
  selector,
  sections,
  empty,
  actions,
  namePath = "name",
  labelOf,
}: {
  /** The panel's title, the picker's label and the empty state: message
   *  keys, in the editor's locale when shown. */
  title: string;
  picker: string;
  testId: string;
  selector: string;
  /** The path that holds the object's name, where it is not `name`
   *  (a text variable's is `textVariableName`). */
  namePath?: string;
  /** Words for an address whose kind has no name path (a condition is
   *  named in its collection, a guide is described): R13, ADR 254. */
  labelOf?: (address: string) => string | undefined;
  sections: readonly SectionSpec[];
  empty: string;
  /** Create / delete / … buttons over typed core commands (the picked
   *  address, or null when the list is empty). */
  actions?: (address: string | null) => ReactNode;
}) {
  const strings = useStrings();
  const list = useQuery(selector);
  const names = useObjectNames(list, namePath);
  const [pick, setPick] = useState("");
  const address = pick && list?.includes(pick) ? pick : (list?.[0] ?? null);
  const targets = address ? [address] : [];
  return (
    <div
      data-object-options-panel={list ? testId : "loading"}
      data-options-target={address ?? ""}
    >
      <CockpitPanelHeader title={strings.t(title)} />
      {actions && (
        <div
          className="flex flex-wrap gap-[5px] px-3.5 pb-2"
          data-options-actions={testId}
        >
          {actions(address)}
        </div>
      )}
      {address ? (
        <>
          <div className="px-3.5 pb-2">
            <CockpitRow label={strings.t(picker)}>
              <Picker
                testId={testId}
                value={address}
                options={(list ?? []).map((a) => ({
                  value: a,
                  label: displayName(names.get(a) ?? labelOf?.(a) ?? idOf(a)),
                }))}
                onChange={setPick}
              />
            </CockpitRow>
          </div>
          <SchemaSections
            key={address}
            targets={targets}
            sections={sectionsIn(strings, sections)}
            testId={testId}
          />
        </>
      ) : (
        <Empty>{strings.t(empty)}</Empty>
      )}
    </div>
  );
}

export function TextVariablesPanel() {
  const strings = useStrings();
  return (
    <AddressListPanel
      title={M.textVariables}
      picker={M.textVariable}
      testId="textVariable"
      selector="textVariable"
      namePath="textVariableName"
      sections={TEXT_VARIABLE_SECTIONS}
      empty={M.noTextVariables}
      actions={(address) => (
        <>
          <CoreCommandButton
            op="createTextVariable"
            label={strings.t(M.new)}
            testId="text-variable-new"
            prefill={{ name: strings.t(M.newVariable), contents: "" }}
          />
          <CoreCommandButton
            op="deleteTextVariable"
            label={strings.t(M.delete)}
            testId="text-variable-delete"
            disabled={!address}
            args={address ? { variableId: address } : undefined}
          />
        </>
      )}
    />
  );
}

// ------------------------------------------------------ gradient options

/** A gradient's ramp (`gradient:<id>`, ADR 132 virtual paths over
 *  `editGradient`): its name, type and STOPS. The stops are a list of
 *  records — the PropertyField's item editor adds, removes, reorders and
 *  edits one stop at a time, each edit ONE `set` of the whole ramp = one
 *  undo step (§12.8). */
const GRADIENT_SECTIONS: readonly SectionSpec[] = [
  {
    title: M.gradient,
    fields: [
      { path: "name", label: M.name },
      { path: "kind", label: M.type },
      {
        path: "stops",
        label: M.stops,
        items: {
          itemLabel: "stopColor",
          fields: [
            {
              field: "stopColor",
              label: M.colour,
              style: "collection",
              props: { collectionName: "swatches" },
            },
            { field: "locationPct", label: M.location },
            { field: "midpointPct", label: M.midpoint },
          ],
          newItem: { stopColor: "Color/Black", locationPct: 100 },
        },
      },
    ],
  },
];

export function GradientOptionsPanel() {
  const strings = useStrings();
  return (
    <AddressListPanel
      title={M.gradientOptions}
      picker={M.gradient}
      testId="gradient"
      selector="gradient"
      sections={GRADIENT_SECTIONS}
      empty={M.noGradients}
      actions={(address) => (
        <>
          <CoreCommandButton
            op="createGradient"
            label={strings.t(M.new)}
            testId="gradient-new"
            prefill={{
              spec: {
                selfId: `Gradient/u${Date.now().toString(36)}`,
                name: strings.t(M.newGradient),
                kind: "Linear",
                stops: [
                  { stopColor: "Color/Paper", locationPct: 0 },
                  { stopColor: "Color/Black", locationPct: 100 },
                ],
              },
            }}
          />
          <CoreCommandButton
            op="deleteGradient"
            label={strings.t(M.delete)}
            testId="gradient-delete"
            disabled={!address}
            args={address ? { gradientId: address } : undefined}
          />
        </>
      )}
    />
  );
}

// ------------------------------------------------------ section options

const SECTION_SECTIONS: readonly SectionSpec[] = [
  {
    title: M.pageNumbering,
    fields: [
      { path: "prefix", label: M.prefix },
      { path: "numberingStyle", label: M.style },
      { path: "startAt", label: M.startAt },
    ],
  },
];

export function SectionOptionsPanel() {
  const strings = useStrings();
  const sections = useCollection<SectionSummary>("sections");
  const [pick, setPick] = useState("");
  const selfId =
    pick && sections?.some((s) => s.selfId === pick)
      ? pick
      : (sections?.[0]?.selfId ?? "");
  const address = selfId
    ? formatAddress({ kind: "section", id: selfId } as never)
    : null;
  const targets = address ? [address] : [];
  return (
    <div
      data-section-options-panel={sections ? "ready" : "loading"}
      data-options-target={address ?? ""}
    >
      <CockpitPanelHeader title={strings.t(M.sectionOptions)} />
      {address ? (
        <>
          <div className="px-3.5 pb-2">
            <CockpitRow label={strings.t(M.section)}>
              <Picker
                testId="section"
                value={selfId}
                options={(sections ?? []).map((s, i) => ({
                  value: s.selfId,
                  label: `${i + 1}. ${s.prefix || s.selfId}`,
                }))}
                onChange={setPick}
              />
            </CockpitRow>
          </div>
          <SchemaSections
            key={address}
            targets={targets}
            sections={sectionsIn(strings, SECTION_SECTIONS)}
            testId="section"
          />
          <div className="px-3.5 pb-2">
            <CoreCommandButton
              op="deleteSection"
              label={strings.t(M.deleteSection)}
              testId="section-delete"
              args={{ sectionId: address }}
            />
          </div>
        </>
      ) : (
        <Empty>{strings.t(M.noSections)}</Empty>
      )}
    </div>
  );
}

// --------------------------------------------------------------- guides

const GUIDE_SECTIONS: readonly SectionSpec[] = [
  { title: M.guide, fields: [{ path: "position", label: M.position }] },
];

/** A guide has no name; it is described as InDesign's Guides dialog
 *  would place it ("Vertical guide at 100 pt, page 1"). */
function guideLabel(strings: Strings, guide: GuideSummary): string {
  const at = Math.round(guide.position * 100) / 100;
  return strings.t(
    guide.orientation === "vertical" ? M.verticalGuide : M.horizontalGuide,
    { at, page: guide.pageIndex + 1 },
  );
}

export function GuidesPanel() {
  const strings = useStrings();
  const spreads = useCollection<SpreadSummary>("spreads");
  const labelOf = (address: string) => {
    const id = idOf(address);
    for (const s of spreads ?? [])
      for (const g of s.guides ?? [])
        if (g.id === id) return guideLabel(strings, g);
    return undefined;
  };
  return (
    <AddressListPanel
      title={M.guides}
      picker={M.guide}
      testId="guide"
      selector="guide"
      labelOf={labelOf}
      sections={GUIDE_SECTIONS}
      empty={M.noGuides}
    />
  );
}

// ------------------------------------------- named document objects
//
// ADR 323 §4 — the address kinds that had a schema but no panel: colour
// groups, numbering lists, conditions, master spreads and text fields
// (Data Merge placeholders). Each is the same AddressListPanel: a picker
// over `host.objects.query(<kind>)` and SchemaSections on the picked
// address, so every row the kind's schema names (and any it gains) is a
// PropertyField with "Bind to data…".

const COLOR_GROUP_SECTIONS: readonly SectionSpec[] = [
  {
    title: M.colorGroup,
    fields: [
      { path: "name", label: M.name },
      {
        path: "members",
        label: M.swatches,
        collection: "swatches",
        items: { newItem: "Color/Black" },
      },
    ],
  },
];

export function ColorGroupOptionsPanel() {
  return (
    <AddressListPanel
      title={M.colorGroupOptions}
      picker={M.pickColorGroup}
      testId="colorGroup"
      selector="colorGroup"
      sections={COLOR_GROUP_SECTIONS}
      empty={M.noColorGroups}
    />
  );
}

const NUMBERING_LIST_SECTIONS: readonly SectionSpec[] = [
  {
    title: M.numberingList,
    fields: [
      { path: "name", label: M.name },
      { path: "continueAcrossStories", label: M.continueAcrossStories },
      { path: "continueAcrossDocuments", label: M.continueAcrossDocuments },
    ],
  },
];

export function NumberingListOptionsPanel() {
  return (
    <AddressListPanel
      title={M.numberingListOptions}
      picker={M.pickNumberingList}
      testId="numberingList"
      selector="numberingList"
      sections={NUMBERING_LIST_SECTIONS}
      empty={M.noNumberingLists}
    />
  );
}

const CONDITION_SECTIONS: readonly SectionSpec[] = [
  { title: M.condition, fields: [{ path: "visible", label: M.visible }] },
];

export function ConditionOptionsPanel() {
  // A condition's name lives in its collection (the kind has no name path).
  const conditions = useCollection<ConditionSummary>("conditions");
  const labelOf = (address: string) =>
    conditions?.find((c) => c.selfId === idOf(address))?.name || undefined;
  return (
    <AddressListPanel
      title={M.conditionOptions}
      picker={M.condition}
      testId="condition"
      selector="condition"
      labelOf={labelOf}
      sections={CONDITION_SECTIONS}
      empty={M.noConditions}
    />
  );
}

const MASTER_SECTIONS: readonly SectionSpec[] = [
  { title: M.master, fields: [{ path: "name", label: M.name }] },
];

export function MasterOptionsPanel() {
  const strings = useStrings();
  const pageSize = useDocument().handle?.pageSizesPt[0] ?? null;
  return (
    <AddressListPanel
      title={M.masterOptions}
      picker={M.master}
      testId="master"
      selector="master"
      sections={MASTER_SECTIONS}
      empty={M.noMasters}
      actions={(address) => (
        <>
          <CoreCommandButton
            op="createMaster"
            label={strings.t(M.new)}
            testId="master-new"
            prefill={newMasterPrefill(pageSize)}
          />
          <CoreCommandButton
            op="renameMaster"
            label={strings.t(M.rename)}
            testId="master-rename"
            disabled={!address}
            prefill={address ? { master: address } : undefined}
          />
          <CoreCommandButton
            op="deleteMaster"
            label={strings.t(M.delete)}
            testId="master-delete"
            disabled={!address}
            args={address ? { master: address } : undefined}
          />
        </>
      )}
    />
  );
}

const FIELD_SECTIONS: readonly SectionSpec[] = [
  { title: M.field, fields: [{ path: "value", label: M.value }] },
];

export function FieldOptionsPanel() {
  const strings = useStrings();
  return (
    <AddressListPanel
      title={M.textFields}
      picker={M.textField}
      testId="field"
      selector="field"
      sections={FIELD_SECTIONS}
      empty={M.noTextFields}
      actions={(address) => {
        // `field:<story>@<offset>` — the command addresses the marker by
        // its story and offset.
        const m = address ? /^field:(.+)@(\d+)$/.exec(address) : null;
        return (
          <>
            <CoreCommandButton
              op="insertField"
              label={strings.t(M.insert)}
              testId="field-insert"
              prefill={{
                field: {
                  placeholder: {
                    plugin: "media.paged.data",
                    key: "field",
                    value: "",
                  },
                },
              }}
            />
            <CoreCommandButton
              op="setFieldValue"
              label={strings.t(M.setValue)}
              testId="field-set-value"
              disabled={!m}
              prefill={
                m
                  ? { storyId: `story:${m[1]}`, offset: Number(m[2]) }
                  : undefined
              }
            />
          </>
        );
      }}
    />
  );
}
