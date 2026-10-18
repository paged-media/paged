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

import type * as Api from "@paged-media/plugin-api";

import type { Disposable, Registrable } from "./types";

/**
 * Concept 1 (toolbar) — the fifth registry / fifth Contribution-API
 * arm alongside Panel / Command / SemanticGroup / Keybinding. A tool
 * is DATA: an icon, a label, a shortcut, a flyout group, a cursor,
 * optional options, an enablement predicate, and — once the gesture
 * spine lands (Phase 2) — the `gesture` handler factory the spine
 * mounts on the canvas overlay when the tool is active.
 *
 * `gesture` / `cursor` / `options` are OPTIONAL so a tool can be
 * registered as pure rail data before its handler / cursor / options
 * exist. The rail renders whatever is registered; bundles contribute
 * tools through the identical `register` path the built-ins use.
 */
export type ToolId = Api.ToolId;

/**
 * Flyout group — one rail SLOT. Tools that share a group occupy the
 * same slot, with the non-default members hidden behind the flyout
 * triangle (e.g. Pen + Add/Delete/Convert-Anchor; Rectangle + Ellipse
 * + Polygon). Free-form string so bundles can introduce new slots.
 */
export type ToolGroupId = Api.ToolGroupId;

/**
 * The four lettered clusters of the InDesign toolbox (A–D). These are
 * VISUAL section dividers between runs of slots, distinct from the
 * flyout `group`. (The toolbar concept's single `ToolGroupId` enum is
 * refined here into group = slot + section = divider, matching the
 * `toolbar.png` reference: a section contains several flyout slots.)
 */
export type ToolSectionId = Api.ToolSectionId;

/**
 * A named run of slots on the two-column rail — what a tool is FOR
 * (select, draw & type, frames & shapes, transform, colour, view), finer
 * than the four sections. The built-in ids are {@link BUILT_IN_TOOL_CLUSTERS};
 * a bundle may name its own (it is labelled from the id). Optional: an
 * undeclared tool joins its flyout group's cluster, then the cluster of
 * the edit context whose `toolIds` claim it, then its section's.
 */
export type ToolClusterId = string;

/** The built-in clusters in rail order, with their labels. */
export const BUILT_IN_TOOL_CLUSTERS: ReadonlyArray<{
  id: ToolClusterId;
  label: string;
}> = [
  { id: "select", label: "Select" },
  { id: "draw", label: "Draw & type" },
  { id: "shapes", label: "Frames & shapes" },
  { id: "transform", label: "Transform" },
  { id: "colour", label: "Colour" },
  { id: "view", label: "View" },
];

/**
 * Honest-stub marker (design-system rule: "new product surfaces
 * without engine support ship as VISIBLE stubs, never
 * fake-interactive").
 *
 * `"ready"` (the default when omitted) — the tool does something when
 * picked: it either carries a `gesture` or an app-level consumer
 * routes its id.
 *
 * `"planned"` — the capability does not exist yet. The rail still
 * renders the slot (so the toolbox reads complete and the eventual
 * home of the tool is visible) but dims it, marks it
 * `data-tool-status="planned"`, refuses activation, and the shell
 * registers NEITHER an activation command NOR a keybinding for it.
 * A `shortcut` on a planned tool is a RESERVATION only — it keeps the
 * key off-limits for other bundles under INV-REG-1 without binding a
 * dead key.
 *
 * There is deliberately no third state: a tool that neither works nor
 * says so is the bug this type exists to prevent.
 */
export type ToolStatus = "ready" | "planned";

/**
 * A tool as the shell's registry holds it: the contract's
 * `ToolContribution` (id, title, icon, shortcut, group, section, order,
 * slotOrder, isGroupDefault, cursor, gesture, options, when — the single
 * definition, in `@paged-media/plugin-api`) plus the fields only the
 * editor's own tools set. A bundle's contribution carries none of them
 * and registers unchanged (`_ToolRegistrable` below).
 */
export interface ToolContribution extends Api.ToolContribution {
  /** The rail cluster the slot sits in — see {@link ToolClusterId}. */
  cluster?: ToolClusterId;
  /** One sentence for the rail tooltip: what the tool does, in the
   *  user's terms. The title names it; this says what a drag does. */
  description?: string;
  /** Honest-stub marker — see {@link ToolStatus}. Omitted ⇒ `"ready"`. */
  status?: ToolStatus;
  /** Transitional bridge to the legacy scalar `ActiveTool` union
   *  (`"select"` / `"text"`) the canvas spine still routes through.
   *  Drop once consumers read `ToolId` directly. */
  legacyKey?: "select" | "text";
}

/** A contract-authored tool registers here unchanged. */
export type _ToolRegistrable = Registrable<
  ToolContribution,
  Api.ToolContribution
>;

/** Transitional alias — existing code that imported `Tool` keeps
 *  compiling against the richer shape. */
export type Tool = ToolContribution;

export type ToolRegistryEvent =
  | { kind: "registered"; contribution: ToolContribution }
  | { kind: "unregistered"; id: ToolId };

export interface ToolRegistry extends Api.ToolRegistry {
  register(contribution: ToolContribution): Disposable;
  unregister(id: ToolId): void;
  get(id: ToolId): ToolContribution | undefined;
  list(): ToolContribution[];
  /** Group → ordered members, derived. The rail renders one slot per
   *  group, first-seen group order preserved; members sorted by
   *  `order`. */
  groups(): Map<ToolGroupId, ToolContribution[]>;
  onChange(handler: (event: ToolRegistryEvent) => void): Disposable;
}

/**
 * Default in-memory `ToolRegistry`. Insertion order is preserved so
 * the rail renders slots deterministically.
 */
export function createToolRegistry(): ToolRegistry {
  const byId = new Map<ToolId, ToolContribution>();
  const listeners = new Set<(event: ToolRegistryEvent) => void>();

  function emit(event: ToolRegistryEvent) {
    for (const fn of listeners) fn(event);
  }

  return {
    register(contribution) {
      if (byId.has(contribution.id)) {
        throw new Error(
          `ToolRegistry: id "${contribution.id}" already registered`,
        );
      }
      byId.set(contribution.id, contribution);
      emit({ kind: "registered", contribution });
      return {
        dispose() {
          if (byId.delete(contribution.id)) {
            emit({ kind: "unregistered", id: contribution.id });
          }
        },
      };
    },
    unregister(id) {
      if (byId.delete(id)) {
        emit({ kind: "unregistered", id });
      }
    },
    get(id) {
      return byId.get(id);
    },
    list() {
      return Array.from(byId.values());
    },
    groups() {
      // First-seen group order preserved (Map insertion order); members
      // sorted by `order` (stable sort keeps registration order for ties).
      const out = new Map<ToolGroupId, ToolContribution[]>();
      for (const c of byId.values()) {
        const arr = out.get(c.group);
        if (arr) arr.push(c);
        else out.set(c.group, [c]);
      }
      for (const arr of out.values()) {
        arr.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      }
      return out;
    },
    onChange(handler) {
      listeners.add(handler);
      return {
        dispose() {
          listeners.delete(handler);
        },
      };
    },
  };
}

/**
 * Built-in tools seeded at shell startup so the rail is populated
 * before any bundle runs. Phase 0 ships the two tools the canvas
 * spine already routes pointer events through (Selection, Type); the
 * full InDesign catalog (with gesture factories) lands as
 * `BUILT_IN_TOOLS` in apps/canvas during Phase 1/2. Keys/shortcuts
 * are lowercased to match `KeyboardEvent.key`.
 */
export const DEFAULT_TOOLS: ToolContribution[] = [
  {
    id: "paged.tool.select",
    title: "Selection",
    icon: "tool-select",
    shortcut: "v",
    group: "select",
    section: "selection",
    order: 0,
    isGroupDefault: true,
    legacyKey: "select",
  },
  {
    id: "paged.tool.type",
    title: "Type",
    icon: "tool-type",
    shortcut: "t",
    group: "type",
    section: "drawType",
    order: 0,
    isGroupDefault: true,
    legacyKey: "text",
  },
];
