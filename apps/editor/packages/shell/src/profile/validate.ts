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

// The shape check of a profile a host hands in. A profile is data from
// outside, so it is read field by field, as stored settings are (ADR 247):
// a field of the wrong shape is dropped and reported, the rest is kept, and
// nothing throws. An unknown key is reported too, so a typo in a host's
// profile does not pass silently.

import { isRecord, isStringArray } from "../lib/stored-settings";
import { FEATURE_KINDS } from "../state/features";
import {
  REGION_IDS,
  type EditorProfile,
  type ItemMatcher,
  type ProfileMode,
  type ProfileProblem,
  type RegionEdit,
  type RegionId,
  type RegionItem,
  type RegionSpec,
} from "./types";

const PROFILE_KEYS = new Set([
  "extends",
  "title",
  "blurb",
  "bundles",
  "panels",
  "modes",
  "regions",
  "adjust",
  "canvas",
  "documentSizePt",
  "storageScope",
  "features",
  "role",
  "compact",
]);

const ROLES: ReadonlySet<string> = new Set([
  "author",
  "editor",
  "filler",
  "viewer",
]);

const REGION_SET: ReadonlySet<string> = new Set(REGION_IDS);
const FEATURE_KIND_SET: ReadonlySet<string> = new Set(FEATURE_KINDS);

function isRegionId(value: unknown): value is RegionId {
  return typeof value === "string" && REGION_SET.has(value);
}

function isMatcher(value: unknown): value is ItemMatcher {
  return (
    (typeof value === "string" && value.length > 0) ||
    (typeof value === "number" && Number.isInteger(value))
  );
}

function readItem(
  value: unknown,
  path: string,
  problems: ProfileProblem[],
): RegionItem | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (isRecord(value)) {
    if (value.kind === "separator" || value.kind === "spacer") {
      return { kind: value.kind };
    }
    if (value.kind === "host" && typeof value.id === "string" && value.id) {
      return { kind: "host", id: value.id };
    }
    if (
      value.kind === "group" &&
      typeof value.id === "string" &&
      value.id &&
      Array.isArray(value.items)
    ) {
      return {
        kind: "group",
        id: value.id,
        items: readItems(value.items, `${path}.items`, problems),
      };
    }
  }
  problems.push({ path, message: "not a region item; dropped" });
  return null;
}

function readItems(
  values: readonly unknown[],
  path: string,
  problems: ProfileProblem[],
): RegionItem[] {
  const out: RegionItem[] = [];
  values.forEach((value, i) => {
    const item = readItem(value, `${path}[${i}]`, problems);
    if (item !== null) out.push(item);
  });
  return out;
}

function readRegionSpec(
  value: unknown,
  path: string,
  problems: ProfileProblem[],
): RegionSpec | null | undefined {
  if (value === null) return null;
  if (isRecord(value)) {
    if (value.items === "all") return { items: "all" };
    if (Array.isArray(value.items)) {
      return { items: readItems(value.items, `${path}.items`, problems) };
    }
  }
  problems.push({
    path,
    message: 'a region is null or { items: "all" | [...] }; ignored',
  });
  return undefined;
}

function readEdit(
  value: unknown,
  path: string,
  problems: ProfileProblem[],
): RegionEdit | null {
  if (!isRecord(value) || !isRegionId(value.region)) {
    problems.push({ path, message: "an edit names a known region; dropped" });
    return null;
  }
  const region = value.region;
  if (value.op === "remove" && isMatcher(value.match)) {
    return { region, op: "remove", match: value.match };
  }
  if (
    (value.op === "insert" || value.op === "set") &&
    Array.isArray(value.items)
  ) {
    const items = readItems(value.items, `${path}.items`, problems);
    if (value.op === "set") return { region, op: "set", items };
    const before = isMatcher(value.before) ? value.before : undefined;
    const after = isMatcher(value.after) ? value.after : undefined;
    return {
      region,
      op: "insert",
      items,
      ...(before !== undefined ? { before } : {}),
      ...(after !== undefined ? { after } : {}),
    };
  }
  problems.push({ path, message: "not a remove, insert or set edit; dropped" });
  return null;
}

function readMode(
  value: unknown,
  path: string,
  problems: ProfileProblem[],
): ProfileMode | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !value.id ||
    typeof value.title !== "string"
  ) {
    problems.push({ path, message: "a mode needs an id and a title; dropped" });
    return null;
  }
  const mode: {
    -readonly [K in keyof ProfileMode]: ProfileMode[K];
  } = { id: value.id, title: value.title };
  if (typeof value.blurb === "string") mode.blurb = value.blurb;
  if (isRecord(value.slots) && typeof value.slots.left === "string") {
    mode.slots = value.slots as unknown as ProfileMode["slots"];
  }
  if (isStringArray(value.paletteSuggestions)) {
    mode.paletteSuggestions = value.paletteSuggestions as string[];
  }
  if (isStringArray(value.menus)) mode.menus = value.menus as string[];
  return mode;
}

function readSelection(
  value: unknown,
  path: string,
  problems: ProfileProblem[],
): "all" | readonly string[] | undefined {
  if (value === "all") return "all";
  if (isStringArray(value)) return value as string[];
  problems.push({ path, message: 'expected "all" or a list of ids; ignored' });
  return undefined;
}

/** Reads a profile from unknown data, keeping what has the right shape. */
export function validateProfile(input: unknown): {
  profile: EditorProfile;
  problems: ProfileProblem[];
} {
  const problems: ProfileProblem[] = [];
  if (!isRecord(input)) {
    problems.push({ path: "", message: "a profile is an object; ignored" });
    return { profile: {}, problems };
  }
  const out: { -readonly [K in keyof EditorProfile]: EditorProfile[K] } = {};

  for (const key of Object.keys(input)) {
    if (!PROFILE_KEYS.has(key)) {
      problems.push({ path: key, message: "unknown key; ignored" });
    }
  }

  const str = (key: "extends" | "title" | "blurb" | "storageScope") => {
    const value = input[key];
    if (value === undefined) return;
    if (typeof value === "string") out[key] = value;
    else problems.push({ path: key, message: "expected a string; ignored" });
  };
  str("extends");
  str("title");
  str("blurb");
  str("storageScope");

  if (input.bundles !== undefined) {
    const bundles = readSelection(input.bundles, "bundles", problems);
    if (bundles !== undefined) out.bundles = bundles;
  }
  if (input.panels !== undefined) {
    const panels = readSelection(input.panels, "panels", problems);
    if (panels !== undefined) out.panels = panels;
  }

  if (input.modes !== undefined) {
    if (input.modes === "all") out.modes = "all";
    else if (Array.isArray(input.modes)) {
      const modes: ProfileMode[] = [];
      input.modes.forEach((m, i) => {
        const mode = readMode(m, `modes[${i}]`, problems);
        if (mode) modes.push(mode);
      });
      out.modes = modes;
    } else {
      problems.push({
        path: "modes",
        message: 'expected "all" or a list of modes; ignored',
      });
    }
  }

  if (input.regions !== undefined) {
    if (!isRecord(input.regions)) {
      problems.push({
        path: "regions",
        message: "expected an object; ignored",
      });
    } else {
      const regions: Partial<Record<RegionId, RegionSpec | null>> = {};
      for (const [key, value] of Object.entries(input.regions)) {
        if (!isRegionId(key)) {
          problems.push({
            path: `regions.${key}`,
            message: "unknown region; ignored",
          });
          continue;
        }
        const spec = readRegionSpec(value, `regions.${key}`, problems);
        if (spec !== undefined) regions[key] = spec;
      }
      out.regions = regions;
    }
  }

  if (input.adjust !== undefined) {
    if (!Array.isArray(input.adjust)) {
      problems.push({ path: "adjust", message: "expected a list; ignored" });
    } else {
      const edits: RegionEdit[] = [];
      input.adjust.forEach((e, i) => {
        const edit = readEdit(e, `adjust[${i}]`, problems);
        if (edit) edits.push(edit);
      });
      out.adjust = edits;
    }
  }

  if (input.canvas !== undefined) {
    if (!isRecord(input.canvas)) {
      problems.push({ path: "canvas", message: "expected an object; ignored" });
    } else {
      const canvas: {
        titleBar?: boolean;
        rulers?: boolean;
        thumbnails?: boolean;
        preview?: boolean;
      } = {};
      for (const key of [
        "titleBar",
        "rulers",
        "thumbnails",
        "preview",
      ] as const) {
        const value = input.canvas[key];
        if (value === undefined) continue;
        if (typeof value === "boolean") canvas[key] = value;
        else {
          problems.push({
            path: `canvas.${key}`,
            message: "expected a boolean; ignored",
          });
        }
      }
      out.canvas = canvas;
    }
  }

  if (input.role !== undefined) {
    if (typeof input.role === "string" && ROLES.has(input.role)) {
      out.role = input.role as EditorProfile["role"];
    } else {
      problems.push({
        path: "role",
        message: "expected author, editor, filler or viewer; ignored",
      });
    }
  }

  if (input.compact !== undefined) {
    if (
      input.compact === null ||
      input.compact === "form-first" ||
      input.compact === "field-sheet"
    ) {
      out.compact = input.compact;
    } else {
      problems.push({
        path: "compact",
        message: "expected form-first, field-sheet or null; ignored",
      });
    }
  }

  if (input.features !== undefined) {
    if (!isRecord(input.features)) {
      problems.push({
        path: "features",
        message: "expected an object; ignored",
      });
    } else {
      const features: Record<string, boolean> = {};
      for (const [id, on] of Object.entries(input.features)) {
        const kind = id.split(":")[0] ?? "";
        if (!FEATURE_KIND_SET.has(kind) || id.length <= kind.length + 1) {
          problems.push({
            path: `features.${id}`,
            message: "not a feature id (<kind>:<id>); ignored",
          });
        } else if (typeof on !== "boolean") {
          problems.push({
            path: `features.${id}`,
            message: "expected a boolean; ignored",
          });
        } else {
          features[id] = on;
        }
      }
      out.features = features;
    }
  }

  if (input.documentSizePt !== undefined) {
    const size = input.documentSizePt;
    if (
      Array.isArray(size) &&
      size.length === 2 &&
      size.every((n) => typeof n === "number" && Number.isFinite(n) && n > 0)
    ) {
      out.documentSizePt = [size[0] as number, size[1] as number];
    } else {
      problems.push({
        path: "documentSizePt",
        message: "expected [width, height] in points; ignored",
      });
    }
  }

  return { profile: out, problems };
}
