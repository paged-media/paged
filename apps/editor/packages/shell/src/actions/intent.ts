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

// Editor ADR 1240 — what a recorded step MEANT (the interaction
// specification's `UXI-MUT-013`): the selection it acted on, as an intent
// rather than the ids of the recorded document, and the values the user may
// change before a run (its parameters). THIS FILE IS PURE: no React, no DOM.
//
// A selection token stands where the recorded payload named exactly what was
// selected when the step ran:
//
//   { "$selection": "elements" }  the selected page items' addresses (a list)
//   { "$selection": "element" }   the one selected page item's address
//   { "$selection": "text" }      the text selection's story range
//
// At replay the token is the replay-time selection, so "align the selection"
// aligns what is selected then, not the objects of another document. Ids
// that were NOT the selection stay as recorded: they are object references,
// and the replay checks that they exist before anything runs.

/** What a selection token stands for. */
export type SelectionTokenKind = "elements" | "element" | "text";

export interface SelectionToken {
  $selection: SelectionTokenKind;
}

/** The selection as addresses (ADR 131), at record or at replay time. */
export interface SelectionAddresses {
  /** The selected page items, in selection order. */
  elements: readonly string[];
  /** The text selection's story range (`storyRange:<story>@<a>..<b>`), or
   *  null without one. */
  text: string | null;
}

export const NO_SELECTION: SelectionAddresses = { elements: [], text: null };

export function isSelectionToken(value: unknown): value is SelectionToken {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const rec = value as Record<string, unknown>;
  const keys = Object.keys(rec);
  return (
    keys.length === 1 &&
    (rec.$selection === "elements" ||
      rec.$selection === "element" ||
      rec.$selection === "text")
  );
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean => {
  if (a.length !== b.length || a.length === 0) return false;
  const set = new Set(b);
  return a.every((x) => set.has(x));
};

/**
 * Replace every place `payload` names exactly the record-time selection with
 * a selection token. A list of addresses equal (as a set) to the selected
 * items becomes `{ $selection: "elements" }`; a string equal to the one
 * selected item's address `{ $selection: "element" }`; a string equal to the
 * text selection's range `{ $selection: "text" }`. Everything else is kept.
 * Returns the payload unchanged (the same value) when nothing matched.
 */
export function tokenizeSelection(
  payload: unknown,
  selection: SelectionAddresses,
): unknown {
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") {
      if (selection.text !== null && value === selection.text)
        return { $selection: "text" } satisfies SelectionToken;
      if (selection.elements.length === 1 && value === selection.elements[0])
        return { $selection: "element" } satisfies SelectionToken;
      return value;
    }
    if (Array.isArray(value)) {
      if (
        value.every((v) => typeof v === "string") &&
        sameSet(value as string[], selection.elements)
      ) {
        return { $selection: "elements" } satisfies SelectionToken;
      }
      return value.map(walk);
    }
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = walk(v);
      return out;
    }
    return value;
  };
  return walk(payload);
}

/** Does `payload` hold a selection token anywhere? Which kinds? */
export function selectionTokensIn(payload: unknown): Set<SelectionTokenKind> {
  const found = new Set<SelectionTokenKind>();
  const walk = (value: unknown): void => {
    if (isSelectionToken(value)) {
      found.add(value.$selection);
      return;
    }
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object")
      Object.values(value).forEach(walk);
  };
  walk(payload);
  return found;
}

/** Why a token cannot be resolved against a selection, or null. */
export function unresolvableToken(
  kind: SelectionTokenKind,
  selection: SelectionAddresses,
): "noElements" | "notOneElement" | "noText" | null {
  if (kind === "elements")
    return selection.elements.length > 0 ? null : "noElements";
  if (kind === "element")
    return selection.elements.length === 1 ? null : "notOneElement";
  return selection.text !== null ? null : "noText";
}

/** `payload` with every selection token replaced by `selection`'s
 *  addresses. A token the selection cannot answer throws: the plan refuses
 *  such a step before a run, so reaching here is a bug, not a user error. */
export function resolveSelection(
  payload: unknown,
  selection: SelectionAddresses,
): unknown {
  const walk = (value: unknown): unknown => {
    if (isSelectionToken(value)) {
      const why = unresolvableToken(value.$selection, selection);
      if (why) throw new Error(`selection token ${value.$selection}: ${why}`);
      if (value.$selection === "elements") return [...selection.elements];
      if (value.$selection === "element") return selection.elements[0];
      return selection.text;
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = walk(v);
      return out;
    }
    return value;
  };
  return walk(payload);
}

/** The ADR 131 address forms that name ONE object of a document (`doc`
 *  always exists and is left out). */
const OBJECT_ADDRESS =
  /^(?:textFrame|rectangle|oval|polygon|graphicLine|group|frame|instance|storyRange|story|page|spread|layer|master|table|cell|style|swatch|gradient|colorGroup|numberingList|guide|condition|conditionSet|section|hyperlink|textVariable|field|plugin):\S/;

/** Is `s` an object address (a recorded object reference)? */
export function isObjectAddress(s: string): boolean {
  return OBJECT_ADDRESS.test(s);
}

/** Every address a payload names that is NOT a selection token: the
 *  recorded object references the replay must find in the document. */
export function objectReferencesIn(
  payload: unknown,
  isAddress: (s: string) => boolean,
): string[] {
  const out = new Set<string>();
  const walk = (value: unknown): void => {
    if (isSelectionToken(value)) return;
    if (typeof value === "string") {
      if (isAddress(value)) out.add(value);
      return;
    }
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object")
      Object.values(value).forEach(walk);
  };
  walk(payload);
  return [...out];
}

// ───────────────────────────────────────────────────────── parameters

/** One key or index on the way to a payload leaf. */
export type PayloadKey = string | number;

/**
 * An action parameter: a value of one step's payload the user may change
 * before a run (a distance, a style name, a colour). `value` is what the
 * next run uses; the step's recorded value stays as recorded.
 */
export interface ActionParam {
  id: string;
  label: string;
  /** The step (index in `PagedAction.steps`) whose payload it sets. */
  step: number;
  /** The leaf inside that payload. */
  path: readonly PayloadKey[];
  value: string | number | boolean;
}

/** A payload leaf a parameter can stand for: a number, a string or a
 *  boolean that is not a selection token and not an object reference. */
export interface PayloadLeaf {
  path: PayloadKey[];
  value: string | number | boolean;
}

/** The scalar leaves of `payload` a parameter may stand for, in order. */
export function parameterLeaves(
  payload: unknown,
  isAddress: (s: string) => boolean,
): PayloadLeaf[] {
  const out: PayloadLeaf[] = [];
  const walk = (value: unknown, path: PayloadKey[]): void => {
    if (isSelectionToken(value)) return;
    if (typeof value === "number" && Number.isFinite(value)) {
      out.push({ path, value });
      return;
    }
    if (typeof value === "boolean") {
      out.push({ path, value });
      return;
    }
    if (typeof value === "string") {
      if (!isAddress(value)) out.push({ path, value });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, [...path, i]));
      return;
    }
    if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) walk(v, [...path, k]);
    }
  };
  walk(payload, []);
  return out;
}

/** The value at `path` in `payload`, or undefined. */
export function leafAt(payload: unknown, path: readonly PayloadKey[]): unknown {
  let at: unknown = payload;
  for (const key of path) {
    if (at === null || typeof at !== "object") return undefined;
    at = (at as Record<PayloadKey, unknown>)[key];
  }
  return at;
}

/** `payload` with the leaf at `path` replaced by `value` (a copy). */
export function withLeaf(
  payload: unknown,
  path: readonly PayloadKey[],
  value: unknown,
): unknown {
  if (path.length === 0) return value;
  const [head, ...rest] = path;
  if (Array.isArray(payload)) {
    const copy = [...payload];
    copy[head as number] = withLeaf(copy[head as number], rest, value);
    return copy;
  }
  const rec =
    payload && typeof payload === "object"
      ? { ...(payload as Record<string, unknown>) }
      : {};
  rec[head as string] = withLeaf(rec[head as string], rest, value);
  return rec;
}

/** The payload a step runs with: its recorded payload with every parameter
 *  of that step applied. A parameter whose type differs from the recorded
 *  leaf's is applied anyway; the command's declared args refuse it. */
export function applyParams(
  payload: unknown,
  stepIndex: number,
  params: readonly ActionParam[] | undefined,
): unknown {
  let out = payload;
  for (const p of params ?? []) {
    if (p.step !== stepIndex) continue;
    if (leafAt(out, p.path) === undefined) continue;
    out = withLeaf(out, p.path, p.value);
  }
  return out;
}

/** A parameter's label from its path (`spacing`, `fill colour`): the last
 *  key, words split at capitals. */
export function paramLabelOf(path: readonly PayloadKey[]): string {
  const last = [...path].reverse().find((k) => typeof k === "string");
  const word = typeof last === "string" ? last : "value";
  return word
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .trim();
}

/** Is `value` a well-formed parameter list? */
export function isParamList(value: unknown): value is ActionParam[] {
  return (
    Array.isArray(value) &&
    value.every((p) => {
      const r = p as ActionParam | undefined;
      return (
        !!r &&
        typeof r.id === "string" &&
        typeof r.label === "string" &&
        typeof r.step === "number" &&
        Array.isArray(r.path) &&
        r.path.every((k) => typeof k === "string" || typeof k === "number") &&
        (typeof r.value === "string" ||
          typeof r.value === "number" ||
          typeof r.value === "boolean")
      );
    })
  );
}
