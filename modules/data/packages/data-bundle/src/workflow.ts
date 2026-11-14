/*
 * This file is part of paged (https://paged.media).
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

// Data ADR 566 — variable-data publishing as six legible steps (the UX
// strategy's §7.5): Connect source → Choose records → Bind fields →
// Preview variants → Validate → Publish. Each step's state is read from
// the session as it is; nothing here decides data semantics. Pure.

export type WorkflowStepId =
  "connect" | "records" | "bind" | "preview" | "validate" | "publish";

export const WORKFLOW_STEPS: readonly WorkflowStepId[] = [
  "connect",
  "records",
  "bind",
  "preview",
  "validate",
  "publish",
];

/** A step is done, the one to do next, still to come, or done with
 *  something to look at (validation found outliers or issues). */
export type WorkflowStepState = "done" | "current" | "todo" | "attention";

/** What the steps are read from. */
export interface WorkflowFacts {
  sources: number;
  /** Records ingested for the picked query (0: none yet). */
  records: number;
  bindings: number;
  /** A record has been previewed (the scrubber moved or showed one). */
  previewed: boolean;
  /** Validation ran: the problems it found (null: not run yet). */
  problems: number | null;
  /** The document was merged or placed from the data. */
  published: boolean;
}

/** Each step's state: the first step not done is the current one; a
 *  validation that found problems asks for attention. */
export function workflowStates(
  f: WorkflowFacts,
): Record<WorkflowStepId, WorkflowStepState> {
  const done: Record<WorkflowStepId, boolean> = {
    connect: f.sources > 0,
    records: f.records > 0,
    bind: f.bindings > 0,
    preview: f.previewed,
    validate: f.problems === 0,
    publish: f.published,
  };
  const out = {} as Record<WorkflowStepId, WorkflowStepState>;
  let current = false;
  for (const id of WORKFLOW_STEPS) {
    if (id === "validate" && f.problems !== null && f.problems > 0) {
      out[id] = "attention";
      if (!current) current = true;
      continue;
    }
    if (done[id]) out[id] = "done";
    else if (!current) {
      out[id] = "current";
      current = true;
    } else out[id] = "todo";
  }
  return out;
}
