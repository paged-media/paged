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

// W2.12 (2026-06-07) — Anchored Object panel. LIVE on the W1.16
// anchored-object surface (protocol v35): a frame anchored into a
// text story carries an `<AnchoredObjectSetting>`, which the canvas
// read-side surfaces as ten `anchored*` PropertyEntries on the
// element snapshot. This panel detects an anchored selection (by the
// presence of those entries), reads back the live values, and drives
// the position controls.
//
// Paths (all element scope, `setElementProperty`):
//   anchoredPosition              Value::Text  — InlinePosition / AboveLine / Anchored
//   anchorPoint                   Value::Text  — 9-cell anchor (TopLeftAnchor …)
//   anchoredXOffset               Value::Length (pt)
//   anchoredYOffset               Value::Length (pt)
//   anchoredHorizontalReference   Value::Text  — AnchorLocation / ColumnEdge / TextFrame / PageMargin / PageEdge
//   anchoredVerticalReference     Value::Text  — LineBaseline (the W1.16 line-ref metric) / LineAscent / TextFrame / …
//   anchoredHorizontalAlignment   Value::Text  — LeftAlign / CenterAlign / RightAlign
//   anchoredVerticalAlignment     Value::Text  — TopAlign / CenterAlign / BottomAlign
//   anchoredSpineRelative         Value::Bool
//   anchoredLockPosition          Value::Bool
//
// Custom-position controls (X/Y offsets, reference points, alignment)
// only apply when AnchoredPosition = `Anchored`; in inline / above-line
// modes InDesign hides them, so the panel disables them honestly.
//
// For a NON-anchored selection (or nothing selected) the panel states
// it honestly — no fake enable. Detection: a non-anchored frame's
// snapshot carries NONE of the `anchored*` entries (verified on the
// `anchored.idml` fixture: an ordinary page frame returns []).

import { useEffect, useState } from "react";

import {
  Icon,
  ObjectFieldFrame,
  useCanvasClient,
  useObjectBindings,
  useSelection,
  type ObjectField,
} from "@paged-media/shell";
import { KitSelect, LengthInput } from "@paged-media/ui";
import type {
  ElementId,
  ElementProperties,
  PropertyPath,
  Value,
} from "@paged-media/client";

import { defineMessages, useStrings } from "@paged-media/strings";

import { ConceptShell, Kicker, Row } from "./concept-kit";

const M = defineMessages("app.conceptAnchoredPanel", {
  optInline: "Inline",
  optAboveLine: "Above line",
  optCustomAnchored: "Custom (anchored)",
  optTopLeft: "Top left",
  optTopCenter: "Top center",
  optTopRight: "Top right",
  optLeftCenter: "Left center",
  optCenter: "Center",
  optRightCenter: "Right center",
  optBottomLeft: "Bottom left",
  optBottomCenter: "Bottom center",
  optBottomRight: "Bottom right",
  optAnchorLocation: "Anchor location",
  optColumnEdge: "Column edge",
  optTextFrame: "Text frame",
  optPageMargin: "Page margin",
  optPageEdge: "Page edge",
  optLineBaseline: "Line baseline",
  optLineAscent: "Line ascent",
  optLineXHeight: "Line x-height",
  optTopOfLeading: "Top of leading",
  optEmBoxBottom: "Em-box bottom",
  optLeft: "Left",
  optRight: "Right",
  optTop: "Top",
  optBottom: "Bottom",
  target:
    "Position mode, X/Y offsets, anchor + reference points (incl. the W1.16 line-ref metrics), alignment, spine-relative and lock are live for an anchored object; a non-anchored selection states it honestly.",
  reading: "Reading selection…",
  selectOne: "Select a single object.",
  anchoredKind: "Anchored {kind}",
  anchoredObject: "Anchored object",
  kindNotAnchored: "{kind} is not anchored",
  objectNotAnchored: "Object is not anchored",
  onThePage:
    "This object lives on the page, not anchored into text. Anchor it by cutting and pasting it into a text story (the InDesign inline / anchored flow).",
  selectAnchored:
    "Select an object anchored into a text story to edit its anchored position.",
  position: "Position",
  mode: "Mode",
  spineRelative: "Spine relative",
  lockPosition: "Lock position",
  customPosition: "Custom position",
  customHint:
    "Switch the mode to Custom (anchored) to edit the offset and reference points.",
  xOffset: "X offset",
  yOffset: "Y offset",
  anchorPoint: "Anchor point",
  hReference: "H reference",
  vReference: "V reference",
  hAlign: "H align",
  vAlign: "V align",
});

// ── IDML enum option tables ──────────────────────────────────────
// The selects carry the RAW IDML strings the read-side returns, so
// they reflect + round-trip. The fixtures exercise a subset; the full
// InDesign enum sets are listed so an arbitrary document's value
// always has a matching option.

const POSITION_OPTIONS: Array<[string, string]> = [
  ["InlinePosition", M.optInline],
  ["AboveLine", M.optAboveLine],
  ["Anchored", M.optCustomAnchored],
];

const ANCHOR_POINT_OPTIONS: Array<[string, string]> = [
  ["TopLeftAnchor", M.optTopLeft],
  ["TopCenterAnchor", M.optTopCenter],
  ["TopRightAnchor", M.optTopRight],
  ["LeftCenterAnchor", M.optLeftCenter],
  ["CenterAnchor", M.optCenter],
  ["RightCenterAnchor", M.optRightCenter],
  ["BottomLeftAnchor", M.optBottomLeft],
  ["BottomCenterAnchor", M.optBottomCenter],
  ["BottomRightAnchor", M.optBottomRight],
];

const H_REFERENCE_OPTIONS: Array<[string, string]> = [
  ["AnchorLocation", M.optAnchorLocation],
  ["ColumnEdge", M.optColumnEdge],
  ["TextFrame", M.optTextFrame],
  ["PageMargin", M.optPageMargin],
  ["PageEdge", M.optPageEdge],
];

// VerticalReferencePoint — the W1.16 line-ref metric options. The
// renderer resolves these against real line-ref metrics.
const V_REFERENCE_OPTIONS: Array<[string, string]> = [
  ["LineBaseline", M.optLineBaseline],
  ["LineAscent", M.optLineAscent],
  ["LineXheight", M.optLineXHeight],
  ["TopOfLeading", M.optTopOfLeading],
  ["EmBoxBottom", M.optEmBoxBottom],
  ["ColumnEdge", M.optColumnEdge],
  ["TextFrame", M.optTextFrame],
  ["PageMargin", M.optPageMargin],
  ["PageEdge", M.optPageEdge],
  ["AnchorLocation", M.optAnchorLocation],
];

const H_ALIGN_OPTIONS: Array<[string, string]> = [
  ["LeftAlign", M.optLeft],
  ["CenterAlign", M.optCenter],
  ["RightAlign", M.optRight],
];

const V_ALIGN_OPTIONS: Array<[string, string]> = [
  ["TopAlign", M.optTop],
  ["CenterAlign", M.optCenter],
  ["BottomAlign", M.optBottom],
];

const ANCHORED_PATHS: PropertyPath[] = [
  "anchoredPosition",
  "anchorPoint",
  "anchoredXOffset",
  "anchoredYOffset",
  "anchoredHorizontalReference",
  "anchoredVerticalReference",
  "anchoredHorizontalAlignment",
  "anchoredVerticalAlignment",
  "anchoredSpineRelative",
  "anchoredLockPosition",
];

// ADR 323 — every control is an object-model field on the selection:
// writes go through `host.objects` (one batch over the selection = one
// undo step), and each sits in an `ObjectFieldFrame` ("Bind to data…" +
// badge). Reads stay on the snapshot, which also decides "anchored?".
const FIELDS = {
  anchoredPosition: { path: "anchoredPosition" },
  anchorPoint: { path: "anchorPoint" },
  anchoredXOffset: { path: "anchoredXOffset" },
  anchoredYOffset: { path: "anchoredYOffset" },
  anchoredHorizontalReference: { path: "anchoredHorizontalReference" },
  anchoredVerticalReference: { path: "anchoredVerticalReference" },
  anchoredHorizontalAlignment: { path: "anchoredHorizontalAlignment" },
  anchoredVerticalAlignment: { path: "anchoredVerticalAlignment" },
  anchoredSpineRelative: { path: "anchoredSpineRelative" },
  anchoredLockPosition: { path: "anchoredLockPosition" },
} as const;
type AnchoredKey = keyof typeof FIELDS;

interface AnchoredSnapshot {
  /** True when the selected element carries an AnchoredObjectSetting. */
  anchored: boolean;
  values: Partial<Record<PropertyPath, Value>>;
  /** The single element id (for commits) — null when 0 / >1 selected. */
  id: ElementId | null;
  kind: string | null;
  loading: boolean;
}

/** Read the lone selected element's property snapshot and project the
 *  anchored facts. Re-fetches on every Operation-log push so the
 *  panel stays live with gestures / undo / other panels. */
function useAnchored(): AnchoredSnapshot {
  const client = useCanvasClient();
  const { elementSelection } = useSelection();
  const single = elementSelection.length === 1 ? elementSelection[0] : null;
  const [props, setProps] = useState<ElementProperties | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!single) {
      setProps(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const refetch = () => {
      client
        .elementProperties(single)
        .then((p) => {
          if (!cancelled) {
            setProps(p);
            setLoading(false);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setProps(null);
            setLoading(false);
          }
        });
    };
    refetch();
    const off = client.subscribe((msg) => {
      if (
        msg.kind === "mutationApplied" ||
        msg.kind === "undoApplied" ||
        msg.kind === "redoApplied"
      ) {
        refetch();
      }
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [client, single ? JSON.stringify(single) : null]); // eslint-disable-line react-hooks/exhaustive-deps

  const values: Partial<Record<PropertyPath, Value>> = {};
  let anchored = false;
  if (props) {
    for (const entry of props.entries) {
      if (ANCHORED_PATHS.includes(entry.path) && entry.value) {
        values[entry.path] = entry.value;
        anchored = true;
      }
    }
  }
  return { anchored, values, id: single, kind: props?.kind ?? null, loading };
}

function unwrapText(v: Value | undefined): string {
  return v && v.type === "text" ? v.value : "";
}
function unwrapLength(v: Value | undefined): number | null {
  return v && v.type === "length" ? (v.value ?? 0) : null;
}
function unwrapBool(v: Value | undefined): boolean {
  return v && v.type === "bool" ? v.value : false;
}

/** Kit select bound to one `Value::Text` anchored path. */
function EnumRow({
  field,
  label,
  testId,
  options,
  value,
  disabled,
  onCommit,
}: {
  field: ObjectField;
  label: string;
  testId: string;
  options: Array<[string, string]>;
  value: string;
  disabled?: boolean;
  onCommit: (next: string) => void;
}) {
  const strings = useStrings();
  return (
    <Row label={label}>
      <ObjectFieldFrame field={field} className="relative w-full">
        <KitSelect
          data-anchored-select={testId}
          value={value}
          disabled={disabled}
          onChange={(e) => onCommit(e.target.value)}
        >
          {/* An unset / unknown value still needs a slot so the native
            select shows it rather than silently snapping to option 0. */}
          {value === "" && <option value="">—</option>}
          {options.map(([v, l]) => (
            <option key={v} value={v}>
              {strings.t(l)}
            </option>
          ))}
        </KitSelect>
      </ObjectFieldFrame>
    </Row>
  );
}

/** A small toggle pill bound to one `Value::Bool` anchored path. */
function BoolRow({
  field,
  label,
  testId,
  on,
  icon,
  disabled,
  onCommit,
}: {
  field: ObjectField;
  label: string;
  testId: string;
  on: boolean;
  icon?: string;
  disabled?: boolean;
  onCommit: (next: boolean) => void;
}) {
  return (
    <Row label={label}>
      <ObjectFieldFrame field={field} className="relative">
        <button
          type="button"
          role="switch"
          aria-checked={on}
          data-anchored-toggle={testId}
          disabled={disabled}
          onClick={() => onCommit(!on)}
          className="relative h-[17px] w-[30px] rounded-full border-0 disabled:opacity-45"
          style={{
            background: on ? "var(--pg-primary)" : "var(--chrome-divider)",
          }}
        >
          {icon && (
            <Icon
              name={icon}
              size={10}
              className="pointer-events-none absolute left-[3px] top-1/2 -translate-y-1/2"
              style={{ color: on ? "white" : "var(--pg-muted-fg)" }}
            />
          )}
          <span
            className="absolute top-[2px] h-[13px] w-[13px] rounded-full bg-white shadow"
            style={{ left: on ? 15 : 2 }}
          />
        </button>
      </ObjectFieldFrame>
    </Row>
  );
}

export function AnchoredPanel() {
  const strings = useStrings();
  const { anchored, values, id, kind, loading } = useAnchored();
  const fields = useObjectBindings(FIELDS);
  const write = (key: AnchoredKey, value: unknown) => {
    void fields[key].commit?.(value);
  };
  const setText = (key: AnchoredKey, value: string) => write(key, value);
  const setLength = (key: AnchoredKey, value: number) => write(key, value);
  const setBool = (key: AnchoredKey, value: boolean) => write(key, value);

  const position = unwrapText(values.anchoredPosition);
  // Custom-position controls only matter when the object is in the
  // `Anchored` (custom) position; inline / above-line ignore them, so
  // disable them honestly there.
  const custom = position === "Anchored";

  return (
    <ConceptShell testId="anchored-panel" live target={strings.t(M.target)}>
      {/* Honest status header — anchored vs not. */}
      <div
        data-anchored-status={
          loading
            ? "loading"
            : !id
              ? "none"
              : anchored
                ? "anchored"
                : "not-anchored"
        }
        className="flex items-center gap-[7px] rounded-[7px] border border-input bg-background px-2.5 py-2"
      >
        <Icon
          name="ui-pin"
          size={14}
          style={{
            color: anchored ? "var(--pg-primary)" : "var(--pg-muted-fg)",
            flexShrink: 0,
          }}
        />
        <span className="text-[12px]" style={{ color: "var(--pg-fg)" }}>
          {loading
            ? strings.t(M.reading)
            : !id
              ? strings.t(M.selectOne)
              : anchored
                ? kind
                  ? strings.t(M.anchoredKind, { kind })
                  : strings.t(M.anchoredObject)
                : kind
                  ? strings.t(M.kindNotAnchored, { kind })
                  : strings.t(M.objectNotAnchored)}
        </span>
      </div>

      {!anchored ? (
        <div className="text-xs text-muted-foreground" data-anchored-empty>
          {id ? strings.t(M.onThePage) : strings.t(M.selectAnchored)}
        </div>
      ) : (
        <>
          <Kicker>{strings.t(M.position)}</Kicker>
          <EnumRow
            field={fields.anchoredPosition}
            label={strings.t(M.mode)}
            testId="position"
            options={POSITION_OPTIONS}
            value={position}
            onCommit={(v) => setText("anchoredPosition", v)}
          />
          <BoolRow
            field={fields.anchoredSpineRelative}
            label={strings.t(M.spineRelative)}
            testId="spine-relative"
            on={unwrapBool(values.anchoredSpineRelative)}
            onCommit={(v) => setBool("anchoredSpineRelative", v)}
          />
          <BoolRow
            field={fields.anchoredLockPosition}
            label={strings.t(M.lockPosition)}
            testId="lock-position"
            icon="ui-lock"
            on={unwrapBool(values.anchoredLockPosition)}
            onCommit={(v) => setBool("anchoredLockPosition", v)}
          />

          <Kicker>{strings.t(M.customPosition)}</Kicker>
          {!custom && (
            <div
              className="text-[10.5px] italic opacity-70"
              style={{ color: "var(--pg-muted-fg)" }}
              data-anchored-custom-hint
            >
              {strings.t(M.customHint)}
            </div>
          )}
          <Row label={strings.t(M.xOffset)}>
            <ObjectFieldFrame
              field={fields.anchoredXOffset}
              className="relative w-full"
            >
              <span data-anchored-num="x-offset" className="block w-full">
                <LengthInput
                  aria-label="x-offset"
                  valuePt={unwrapLength(values.anchoredXOffset)}
                  disabled={!custom}
                  onChangePt={() => {}}
                  onCommitPt={(n) => setLength("anchoredXOffset", n)}
                />
              </span>
            </ObjectFieldFrame>
          </Row>
          <Row label={strings.t(M.yOffset)}>
            <ObjectFieldFrame
              field={fields.anchoredYOffset}
              className="relative w-full"
            >
              <span data-anchored-num="y-offset" className="block w-full">
                <LengthInput
                  aria-label="y-offset"
                  valuePt={unwrapLength(values.anchoredYOffset)}
                  disabled={!custom}
                  onChangePt={() => {}}
                  onCommitPt={(n) => setLength("anchoredYOffset", n)}
                />
              </span>
            </ObjectFieldFrame>
          </Row>
          <EnumRow
            field={fields.anchorPoint}
            label={strings.t(M.anchorPoint)}
            testId="anchor-point"
            options={ANCHOR_POINT_OPTIONS}
            value={unwrapText(values.anchorPoint)}
            disabled={!custom}
            onCommit={(v) => setText("anchorPoint", v)}
          />
          <EnumRow
            field={fields.anchoredHorizontalReference}
            label={strings.t(M.hReference)}
            testId="h-reference"
            options={H_REFERENCE_OPTIONS}
            value={unwrapText(values.anchoredHorizontalReference)}
            disabled={!custom}
            onCommit={(v) => setText("anchoredHorizontalReference", v)}
          />
          <EnumRow
            field={fields.anchoredVerticalReference}
            label={strings.t(M.vReference)}
            testId="v-reference"
            options={V_REFERENCE_OPTIONS}
            value={unwrapText(values.anchoredVerticalReference)}
            disabled={!custom}
            onCommit={(v) => setText("anchoredVerticalReference", v)}
          />
          <EnumRow
            field={fields.anchoredHorizontalAlignment}
            label={strings.t(M.hAlign)}
            testId="h-align"
            options={H_ALIGN_OPTIONS}
            value={unwrapText(values.anchoredHorizontalAlignment)}
            disabled={!custom}
            onCommit={(v) => setText("anchoredHorizontalAlignment", v)}
          />
          <EnumRow
            field={fields.anchoredVerticalAlignment}
            label={strings.t(M.vAlign)}
            testId="v-align"
            options={V_ALIGN_OPTIONS}
            value={unwrapText(values.anchoredVerticalAlignment)}
            disabled={!custom}
            onCommit={(v) => setText("anchoredVerticalAlignment", v)}
          />
        </>
      )}
    </ConceptShell>
  );
}
