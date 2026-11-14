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

// INSPECTOR SEARCH (the UX strategy's §5.3; the editor ADR on inspector
// search and disclosure): typing "bleed", "tracking" or "corner radius"
// into Properties finds the control. What it searches, per section: the
// field labels and titles of the compositions it renders (and the binding
// paths, read as words), its keywords and synonyms (localized messages, so
// a German user finds "Kontur"), and the text a plugin's panel shows (its
// schema rows' labels, read from the rendered section).
//
// The query reaches nested composition sections through a context, so a
// collapsed sub-section ("Dashes and arrows") that holds a match opens
// while the query lasts and closes again when it is cleared.

import {
  createContext,
  isValidElement,
  useContext,
  type ReactNode,
} from "react";
import type { CompositionNode } from "@paged-media/catalog";

const PropertySearchContext = createContext<string>("");

/** Make `query` the inspector search the sections below answer to. */
export function PropertySearchProvider(props: {
  query: string;
  children: ReactNode;
}) {
  return (
    <PropertySearchContext.Provider value={props.query}>
      {props.children}
    </PropertySearchContext.Provider>
  );
}

/** The inspector search in effect here ("" when none). */
export function usePropertySearchQuery(): string {
  return useContext(PropertySearchContext);
}

/** Lower-cased, without diacritics, single-spaced: what search compares. */
export function normalizeSearch(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** `frameStrokeWeight` → "frame stroke weight". */
export function pathWords(path: string): string {
  return path
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._-]+/g, " ")
    .toLowerCase();
}

/** Every word of the query is in one of the terms (a prefix-free substring
 *  match: "radius" finds "Corner radius", "str wei" finds "stroke
 *  weight"). An empty query matches nothing. */
export function matchesQuery(query: string, terms: readonly string[]): boolean {
  const q = normalizeSearch(query);
  if (q === "") return false;
  const hay = terms.map(normalizeSearch).join(" | ");
  return q.split(" ").every((word) => hay.includes(word));
}

/** Keywords written as one comma-separated message ("stroke, border,
 *  outline") as terms. */
export function keywordTerms(list: string): string[] {
  return list
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
}

const TEXT_PROPS = [
  "label",
  "title",
  "caption",
  "placeholder",
  "unsetText",
  "prefix",
  "suffix",
] as const;

/** The searchable words of a composition: its labels, titles, sub-labels,
 *  option labels and binding paths, all the way down. */
export function compositionTerms(node: CompositionNode): string[] {
  const out: string[] = [];
  const walk = (n: CompositionNode) => {
    const p = n.props ?? {};
    for (const key of TEXT_PROPS) {
      const v = p[key];
      if (typeof v === "string" && v.trim() !== "") out.push(v);
    }
    for (const list of [p.sublabels, p.labels]) {
      if (Array.isArray(list))
        for (const v of list) if (typeof v === "string") out.push(v);
    }
    if (Array.isArray(p.options))
      for (const o of p.options) {
        const label = Array.isArray(o)
          ? o[1]
          : (o as { label?: unknown } | null)?.label;
        if (typeof label === "string") out.push(label);
      }
    for (const b of Object.values(n.bindings ?? {})) {
      const path = (b as { path?: unknown }).path;
      if (typeof path === "string") out.push(pathWords(path));
    }
    for (const child of n.children ?? []) walk(child);
  };
  walk(node);
  return out;
}

/** The terms of a composition leaf's pre-rendered children (`childNodes`,
 *  each a rendered composition node). */
export function childNodeTerms(childNodes: unknown): string[] {
  if (!Array.isArray(childNodes)) return [];
  const out: string[] = [];
  for (const el of childNodes) {
    if (!isValidElement(el)) continue;
    const node = (el.props as { node?: CompositionNode }).node;
    if (node) out.push(...compositionTerms(node));
  }
  return out;
}
