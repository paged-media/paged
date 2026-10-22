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

// Features: what an editor OFFERS, switched on and off at runtime
// (docs/composable-editor.md §6). A feature id is a surface id
// (`command:paged.object.lock`, `panel:paged.layers`, `menu:Window/Layers`,
// ADR 227) or a chrome id (`chrome:rulers`). A rule is a boolean or a
// predicate over the editor state and the answer before it; rules apply in
// the order they were set, so the newest wins and a predicate may defer to
// the older answer. Everything is on until a rule says otherwise.
//
// Features shape the UI. They are not security: a disabled command is still
// reachable from a script or a plugin. What must not happen to a document is
// a permission, checked by the engine.

import { globMatches } from "../profile/adjust";
import type { Disposable } from "../registries/types";

export const FEATURE_KINDS = [
  "command",
  "panel",
  "tool",
  "menu",
  "keybinding",
  "overlay",
  "chrome",
] as const;

export type FeatureKind = (typeof FEATURE_KINDS)[number];

/** The `chrome:` features: parts of the chrome that are not registry
 *  entries. Anything gated by `allows("chrome", …)` is listed here. */
export const CHROME_FEATURES = [
  "rulers",
  "title-bar",
  "thumbnails",
  "context-menu",
] as const;

/** `command:paged.object.lock`, `menu:Window/*`, `chrome:rulers`, … */
export type FeatureId = `${FeatureKind}:${string}`;

export interface FeatureContext {
  /** The concrete feature asked about. */
  id: FeatureId;
  /** The editor state, as `when` predicates see it. */
  state: unknown;
  /** The answer of the rules set before this one. */
  previous: boolean;
}

export type FeatureRule = boolean | ((ctx: FeatureContext) => boolean);

export interface FeatureStore {
  enable(pattern: FeatureId | readonly FeatureId[]): void;
  disable(pattern: FeatureId | readonly FeatureId[]): void;
  /** Sets a rule for an id or a glob (`command:paged.object.*`). */
  set(pattern: FeatureId | readonly FeatureId[], rule: FeatureRule): void;
  /** Removes every rule set for exactly this pattern. */
  reset(pattern: FeatureId): void;
  /** Whether a concrete feature is enabled now. */
  isEnabled(id: FeatureId): boolean;
  /** Shorthand for `isEnabled(\`${kind}:${id}\`)`. */
  allows(kind: FeatureKind, id: string): boolean;
  /** The rules, oldest first. */
  rules(): readonly { pattern: FeatureId; rule: FeatureRule }[];
  /** Fires after any rule changes. */
  onChange(handler: () => void): Disposable;
}

export function createFeatureStore(
  getState: () => unknown = () => undefined,
): FeatureStore {
  let rules: { pattern: FeatureId; rule: FeatureRule }[] = [];
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        console.error("feature listener threw", error);
      }
    }
  };
  const asList = (p: FeatureId | readonly FeatureId[]) =>
    typeof p === "string" ? [p] : [...p];

  const store: FeatureStore = {
    enable: (pattern) => store.set(pattern, true),
    disable: (pattern) => store.set(pattern, false),
    set(pattern, rule) {
      rules = [...rules, ...asList(pattern).map((p) => ({ pattern: p, rule }))];
      changed();
    },
    reset(pattern) {
      const before = rules.length;
      rules = rules.filter((r) => r.pattern !== pattern);
      if (rules.length !== before) changed();
    },
    isEnabled(id) {
      let answer = true;
      for (const { pattern, rule } of rules) {
        if (!globMatches(pattern, id)) continue;
        if (typeof rule === "boolean") {
          answer = rule;
          continue;
        }
        try {
          answer = rule({ id, state: getState(), previous: answer }) === true;
        } catch {
          // A throwing predicate offers nothing, as a throwing `when` does.
          answer = false;
        }
      }
      return answer;
    },
    allows: (kind, id) => store.isEnabled(`${kind}:${id}`),
    rules: () => rules,
    onChange(handler) {
      listeners.add(handler);
      return { dispose: () => listeners.delete(handler) };
    },
  };
  return store;
}
