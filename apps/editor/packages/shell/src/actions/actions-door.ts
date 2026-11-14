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

// Editor ADR 1233 — a recorded action on the platform's ACTIONS door
// (`actions@1`, extensions ADR 344, PM-0015) and as a `paged.*` script.
//
// On the door, an action is a pure step: it computes and never edits. So a
// saved action is registered as `paged.actions/<id>`, input `selection` (a
// snapshot of addresses), output `value`: what the action WOULD invoke over
// that selection — each step's command and its payload with the parameters
// applied and the selection resolved. Any bundle or script lists the user's
// actions and asks what one would do; only the editor's command applies it,
// in one undo step ("a command may apply an action's result in one undo
// step"). The definition's parameter defaults carry the action's revision,
// so the door's content cache never answers for an older recording.
//
// As a `paged.*` script, each recorded property write is a `paged.batch` of
// object ops over `paged.selection()` — exact, and runnable in the Script
// panel, `paged` and `paged-node`. An editor command (Align, Group) has no
// `paged.*` twin: the script says so on that step's line rather than
// pretend.

import type { ActionDefinition, ActionInfo } from "@paged-media/plugin-api";

import {
  createValueStore,
  scoped,
  type EditorScope,
} from "../state/editor-scope";
import {
  applyParams,
  isSelectionToken,
  resolveSelection,
  selectionTokensIn,
  unresolvableToken,
  type SelectionAddresses,
} from "./intent";
import {
  SET_PROPERTY_COMMAND,
  isStopStep,
  planReplay,
  type PagedAction,
} from "./model";

/** The editor's `actions@1` registry, as the provider needs it (plugin-sdk
 *  `createActionRegistry`'s backend). */
export interface ActionsDoorBackend {
  register(owner: string, definition: ActionDefinition): { dispose(): void };
  list?(input?: ActionDefinition["input"]): readonly ActionInfo[];
}

/** The owner the editor registers its users' actions under. */
export const ACTIONS_DOOR_OWNER = "paged.actions";

/** The door id of a saved action. */
export function doorIdOf(action: Pick<PagedAction, "id">): string {
  return `${ACTIONS_DOOR_OWNER}/${action.id}`;
}

const DOOR = scoped("actionsDoor", () =>
  createValueStore<ActionsDoorBackend | null>(null),
);

/** The app hands the shell its `actions@1` registry (mount.tsx). */
export function setActionsDoor(
  scope: EditorScope,
  backend: ActionsDoorBackend | null,
): void {
  scope.get(DOOR).set(backend);
}

/** `scope`'s actions door store. */
export function actionsDoorStore(scope: EditorScope) {
  return scope.get(DOOR);
}

/** FNV-1a of the action's content: its revision on the door. */
export function actionRevision(action: PagedAction): string {
  const text = JSON.stringify([
    action.steps,
    action.params ?? [],
    action.includeDocumentBound,
  ]);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** What the door answers for one action over one selection. */
export interface ActionProjection {
  action: string;
  steps: Array<{
    index: number;
    command: string;
    title: string;
    payload?: unknown;
  }>;
  /** Steps that would not run (turned off, pinned to another document). */
  skipped: number[];
  /** A selection the steps need and the input does not hold. */
  needs: Array<{ index: number; selection: string }>;
}

function selectionOfInput(input: unknown): SelectionAddresses {
  if (Array.isArray(input))
    return {
      elements: input.filter((a): a is string => typeof a === "string"),
      text: null,
    };
  const rec = (input ?? {}) as Partial<SelectionAddresses>;
  return {
    elements: Array.isArray(rec.elements)
      ? rec.elements.filter((a): a is string => typeof a === "string")
      : [],
    text: typeof rec.text === "string" ? rec.text : null,
  };
}

/** What `action` would invoke over `input`, with `values` for its
 *  parameters (by id). PURE. */
export function projectAction(
  action: PagedAction,
  input: unknown,
  values: Readonly<Record<string, unknown>> = {},
): ActionProjection {
  const selection = selectionOfInput(input);
  const params = (action.params ?? []).map((p) => {
    const v = values[p.id];
    return typeof v === "string" ||
      typeof v === "number" ||
      typeof v === "boolean"
      ? { ...p, value: v }
      : p;
  });
  const plan = planReplay(action);
  const out: ActionProjection = {
    action: action.id,
    steps: [],
    skipped: plan.skip.map((s) => s.index),
    needs: [],
  };
  for (const { index, step } of plan.run) {
    if (isStopStep(step)) continue;
    let payload =
      step.payload === undefined
        ? undefined
        : applyParams(step.payload, index, params);
    const kinds = [...selectionTokensIn(payload)];
    const missing = kinds.filter((k) => unresolvableToken(k, selection));
    for (const k of missing) out.needs.push({ index, selection: k });
    if (missing.length === 0 && kinds.length > 0)
      payload = resolveSelection(payload, selection);
    out.steps.push({
      index,
      command: step.command,
      title: step.title,
      ...(payload !== undefined ? { payload } : {}),
    });
  }
  return out;
}

/** `action` as an `actions@1` definition. */
export function definitionOf(action: PagedAction): ActionDefinition {
  const defaults: Record<string, unknown> = {
    revision: actionRevision(action),
  };
  for (const p of action.params ?? []) defaults[p.id] = p.value;
  return {
    id: doorIdOf(action),
    title: action.name,
    input: "selection",
    output: "value",
    params: defaults,
    run: (input, params) => projectAction(action, input, params),
  };
}

// ────────────────────────────────────────────────────── paged.* script

const js = (v: unknown) => JSON.stringify(v);

/** A payload as a script expression: selection tokens become the script's
 *  own selection variables. */
function scriptValue(value: unknown): string {
  if (isSelectionToken(value)) {
    return value.$selection === "elements"
      ? "selection"
      : value.$selection === "element"
        ? "selection[0]"
        : "textSelection";
  }
  if (Array.isArray(value)) return `[${value.map(scriptValue).join(", ")}]`;
  if (value && typeof value === "object")
    return `{ ${Object.entries(value)
      .map(([k, v]) => `${js(k)}: ${scriptValue(v)}`)
      .join(", ")} }`;
  return js(value);
}

/** `action` as a `paged.*` script (Boa: the Script panel, `paged`,
 *  `paged-node`). `editorOnly(command)` words a step a script cannot run. */
export function toPagedScript(
  action: PagedAction,
  editorOnly: (command: string, title: string) => string,
): string {
  const plan = planReplay(action);
  const lines: string[] = [
    `// ${action.name} — paged.* script (editor ADR 1233)`,
  ];
  const uses = new Set<string>();
  for (const { index, step } of plan.run) {
    if (step.payload === undefined) continue;
    for (const k of selectionTokensIn(
      applyParams(step.payload, index, action.params),
    ))
      uses.add(k);
  }
  if (uses.has("elements") || uses.has("element"))
    lines.push(
      "const selection = JSON.parse(paged.selection()).map((e) => paged.address(e));",
    );
  if (uses.has("text"))
    lines.push(
      "const caret = JSON.parse(paged.contentSelection());",
      "const textSelection = caret ? `storyRange:${caret.storyId}@${caret.start}..${caret.end}` : null;",
    );
  for (const { index, step } of plan.run) {
    const n = index + 1;
    if (isStopStep(step)) {
      lines.push(`// ${n}. stop: ${step.stop?.message ?? ""}`);
      continue;
    }
    const payload =
      step.payload === undefined
        ? undefined
        : applyParams(step.payload, index, action.params);
    if (
      step.command === SET_PROPERTY_COMMAND &&
      payload &&
      typeof payload === "object"
    ) {
      const p = payload as {
        targets?: unknown;
        path?: unknown;
        value?: unknown;
      };
      lines.push(`// ${n}. ${step.title}`);
      lines.push(
        `paged.batch(${scriptValue(p.targets)}.map((address) => ({ op: "set", address, path: ${js(p.path)}, value: ${scriptValue(p.value)} })));`,
      );
      continue;
    }
    lines.push(
      `// ${n}. ${step.title} — ${editorOnly(step.command, step.title)}`,
    );
  }
  for (const s of plan.skip)
    lines.push(`// skipped ${s.index + 1}. ${s.step.title}`);
  return lines.join("\n") + "\n";
}
