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

// Editor ADR 1233 — the RUN PLAN: what an action will do here, worked out
// before anything runs (the interaction specification's `UXI-MUT-014`).
// THIS FILE IS PURE: the provider gathers the facts (the commands on offer,
// the selection, the edit context, which recorded objects exist) and this
// turns them into
//
//   · the steps that will run, each with its payload as it will be sent
//     (parameters applied, the selection token resolved) and the objects it
//     acts on — the preview's list and its canvas highlight;
//   · the REFUSALS, each naming its step and why: a command that is not
//     here, a recorded object that is not in this document, an edit context
//     the action was not recorded in, a selection the step needs and that is
//     not there, a parameter its command refuses. Any refusal means nothing
//     runs: the action never targets something else instead;
//   · the undo statement, said before the run (`UXI-MUT-004`, the history
//     table's "reusable action automation" row): one step when the client
//     groups the writes, otherwise how many and why.

import { t } from "@paged-media/strings";

import { ACTIONS } from "./messages";
import {
  applyParams,
  objectReferencesIn,
  resolveSelection,
  selectionTokensIn,
  unresolvableToken,
  type SelectionAddresses,
  type SelectionTokenKind,
} from "./intent";
import {
  SET_PROPERTY_COMMAND,
  isStopStep,
  planReplay,
  type ActionStep,
  type PagedAction,
  type SkippedStep,
} from "./model";

/** What the command registry says about one command. */
export interface CommandFacts {
  registered: boolean;
  /** The feature gate offers it (a profile can turn commands off). */
  offered: boolean;
  /** Its writes make undo steps of their own (a script run, a gesture
   *  commit): the client's group cannot hold them. */
  ownsHistory: boolean;
}

/** The facts a plan is made from, gathered by the provider. */
export interface RunEnvironment {
  documentOpen: boolean;
  /** The session role (`editor` may run an action; a template filler only
   *  fills fields, engine ADR 1001). */
  role: string;
  /** The active edit context's type, or null on the page. */
  context: string | null;
  /** A context's name in words (its module's label). */
  contextLabel(type: string | null): string;
  selection: SelectionAddresses;
  command(id: string): CommandFacts;
  /** The command's declared args refuse `payload` (why), or null. */
  checkArgs(id: string, payload: unknown): string | null;
  /** Is this string an object address (ADR 131)? */
  isAddress(s: string): boolean;
  /** The recorded object references this document does not hold. */
  missing: ReadonlySet<string>;
  /** The client joins a run's writes into one undo step. */
  undoGroups: boolean;
  /** A context whose undo is its own (one entry per command). */
  ownsUndo(type: string): boolean;
}

export interface RunStepPlan {
  index: number;
  command: string;
  title: string;
  /** The payload the step is invoked with, or undefined. */
  payload: unknown;
  /** The selection kinds it resolves at run time. */
  usesSelection: SelectionTokenKind[];
  /** The objects it acts on: the resolved selection and its references. */
  targets: string[];
  /** A stop: it halts the run and invokes nothing. */
  stop: boolean;
  ownStep: boolean;
}

export interface RunRefusal {
  /** The step (index in `action.steps`), or null for the whole action. */
  index: number | null;
  reason: string;
}

export type UndoStatement =
  /** One undo step takes the whole run back. */
  | { kind: "one" }
  /** Up to `steps` undo steps; `because` names the steps that make their
   *  own. */
  | { kind: "several"; steps: number; because: string[] }
  /** No undo group here: every write is its own step, up to `steps`. */
  | { kind: "each"; steps: number };

export interface RunPlan {
  actionId: string;
  name: string;
  steps: RunStepPlan[];
  skipped: SkippedStep[];
  refusals: RunRefusal[];
  /** Every object the run acts on, in first-use order. */
  targets: string[];
  undo: UndoStatement;
}

/** "Step 3 “Align centres”" — how a refusal names its step. */
export function stepName(index: number, title: string): string {
  return t(ACTIONS.stepName, { n: index + 1, title });
}

function tokenWhy(kind: SelectionTokenKind): string {
  return kind === "elements"
    ? t(ACTIONS.needsSelection)
    : kind === "element"
      ? t(ACTIONS.needsOneObject)
      : t(ACTIONS.needsText);
}

/** The recorded object references of every step that will run (the
 *  provider asks the document which of them exist). */
export function referencesOf(
  action: PagedAction,
  isAddress: (s: string) => boolean,
): string[] {
  const out = new Set<string>();
  for (const { index, step } of planReplay(action).run) {
    if (step.payload === undefined) continue;
    const payload = applyParams(step.payload, index, action.params);
    for (const ref of objectReferencesIn(payload, isAddress)) out.add(ref);
  }
  return [...out];
}

/** Commands known to leave the selection as they found it, so a later
 *  step's selection can be checked before the run. Anything else may
 *  change it: its successors are checked when they are reached. */
const KEEPS_SELECTION = new Set<string>([SET_PROPERTY_COMMAND]);

/** The plan of `action` in `env`. PURE. */
export function planRun(action: PagedAction, env: RunEnvironment): RunPlan {
  const replay = planReplay(action);
  const refusals: RunRefusal[] = [];
  const steps: RunStepPlan[] = [];
  const targets = new Set<string>();
  // A step that names objects or the selection, or writes a property,
  // needs a document; a view command (zoom, a panel) does not, and its own
  // applicability says so when it does.
  const needsDocument = replay.run.some(
    ({ step }) =>
      step.command === SET_PROPERTY_COMMAND ||
      (step.payload !== undefined &&
        (selectionTokensIn(step.payload).size > 0 ||
          objectReferencesIn(step.payload, env.isAddress).length > 0)),
  );
  if (!env.documentOpen && needsDocument)
    refusals.push({ index: null, reason: t(ACTIONS.refuseNoDocument) });
  if (env.role !== "editor")
    refusals.push({ index: null, reason: t(ACTIONS.refuseRole) });

  // The context the run starts in must be the one the action was recorded
  // in (its first step's); later steps may enter or leave contexts.
  const first = replay.run.find(({ step }) => !isStopStep(step));
  if (
    first &&
    first.step.context !== undefined &&
    (first.step.context ?? null) !== env.context
  ) {
    refusals.push({
      index: first.index,
      reason: t(ACTIONS.refuseContext, {
        step: stepName(first.index, first.step.title),
        recorded: env.contextLabel(first.step.context ?? null),
        current: env.contextLabel(env.context),
      }),
    });
  }

  // Selections are checked up to the first step that may change one.
  let selectionKnown = true;
  for (const { index, step } of replay.run) {
    const stop = isStopStep(step);
    const facts: CommandFacts = stop
      ? { registered: true, offered: true, ownsHistory: false }
      : env.command(step.command);
    const name = stepName(index, step.title);
    if (!stop && !facts.registered)
      refusals.push({
        index,
        reason: t(ACTIONS.refuseMissingCommand, {
          step: name,
          command: step.command,
        }),
      });
    else if (!stop && !facts.offered)
      refusals.push({
        index,
        reason: t(ACTIONS.refuseNotOffered, { step: name }),
      });

    const withParams =
      step.payload === undefined
        ? undefined
        : applyParams(step.payload, index, action.params);
    const kinds = [...selectionTokensIn(withParams)];
    const references =
      withParams === undefined
        ? []
        : objectReferencesIn(withParams, env.isAddress);
    for (const ref of references) {
      if (env.missing.has(ref))
        refusals.push({
          index,
          reason: t(ACTIONS.refuseMissingObject, { step: name, address: ref }),
        });
    }
    let payload = withParams;
    let resolved = true;
    for (const kind of kinds) {
      const why = unresolvableToken(kind, env.selection);
      if (!why) continue;
      resolved = false;
      if (selectionKnown)
        refusals.push({
          index,
          reason: t(ACTIONS.refuseSelection, {
            step: name,
            needs: tokenWhy(kind),
          }),
        });
    }
    if (resolved && withParams !== undefined && kinds.length > 0)
      payload = resolveSelection(withParams, env.selection);
    // The command's declared args, once the payload is what it will be.
    if (
      !stop &&
      facts.registered &&
      resolved &&
      selectionKnown &&
      payload !== undefined
    ) {
      const bad = env.checkArgs(step.command, payload);
      if (bad)
        refusals.push({
          index,
          reason: t(ACTIONS.refuseArgs, { step: name, why: bad }),
        });
    }
    const stepTargets = [
      ...(kinds.includes("elements") || kinds.includes("element")
        ? env.selection.elements
        : []),
      ...(kinds.includes("text") && env.selection.text
        ? [env.selection.text]
        : []),
      ...references,
    ];
    for (const a of stepTargets) targets.add(a);
    const ownStep =
      !stop &&
      (facts.ownsHistory ||
        (typeof step.context === "string" && env.ownsUndo(step.context)));
    steps.push({
      index,
      command: step.command,
      title: step.title,
      payload,
      usesSelection: kinds,
      targets: stepTargets,
      stop,
      ownStep,
    });
    if (!stop && !KEEPS_SELECTION.has(step.command)) selectionKnown = false;
  }

  return {
    actionId: action.id,
    name: action.name,
    steps,
    skipped: replay.skip,
    refusals,
    targets: [...targets],
    undo: undoStatement(steps, env.undoGroups),
  };
}

function undoStatement(
  steps: readonly RunStepPlan[],
  groups: boolean,
): UndoStatement {
  const writing = steps.filter((s) => !s.stop);
  if (!groups) return { kind: "each", steps: Math.max(writing.length, 1) };
  const own = writing.filter((s) => s.ownStep);
  if (own.length === 0) return { kind: "one" };
  // Each own step is a step of its own, and the group's chain resumes as
  // a new step after it.
  const grouped = writing.length - own.length;
  return {
    kind: "several",
    steps: own.length + Math.min(grouped, own.length + 1),
    because: own.map((s) => stepName(s.index, s.title)),
  };
}

/** The undo statement in words, said before a run. */
export function undoStatementText(undo: UndoStatement): string {
  switch (undo.kind) {
    case "one":
      return t(ACTIONS.undoOne);
    case "several":
      return t(ACTIONS.undoSeveral, {
        count: undo.steps,
        steps: undo.because.join(", "),
      });
    case "each":
      return t(ACTIONS.undoEach, { count: undo.steps });
  }
}

/** The step a dynamic check stopped a run at, in words (the player checks
 *  each step's applicability again right before it runs). */
export function refusalAtRun(step: ActionStep, index: number, why: string) {
  return t(ACTIONS.refuseAtRun, { step: stepName(index, step.title), why });
}
