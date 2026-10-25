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

// WP4.11 — the action PLAYER: one replay, run, paused, stepped, stopped
// and resumed. THIS FILE IS PURE like `model.ts` (no React, no DOM): the
// provider drives it, the batch runner drives it, and the tests drive it
// with a fake registry.
//
// ONE UNDO UNIT. A replay used to leave one undo step per mutation its
// commands issued, and the panel said so. The player now opens the
// client's undo GROUP around every uninterrupted run of steps
// (`CanvasClient.beginUndoGroup`): the first document write commits a
// step and every later one AMENDS it (engine ADR 1004), so one Cmd-Z
// takes the whole replay back. A pause or a stop closes the group — the
// user may edit the document while playback waits, and that edit must
// stay their own step — and Continue re-opens it on the step the replay
// ended in, so a replay the user only looked at stays one step. What the
// chain cannot hold is reported, not hidden (`undoSteps`):
//
//   · an edit the user made during a pause sits on top of the replay's
//     step, so the engine refuses the next amend and the rest of the
//     replay becomes a second step;
//   · a command that commits a canvas GESTURE or runs a SCRIPT makes its
//     own step (neither goes through `mutate`), which breaks the chain
//     the same way;
//   · a command acting inside a plugin edit context that owns its own
//     undo (paged.image's raster journal) writes that journal, not the
//     document — Cmd-Z there is the context's, one entry per command.

import {
  isStopStep,
  planReplay,
  type PagedAction,
  type PlannedStep,
  type SkipReason,
} from "./model";

export interface PlayedStep {
  index: number;
  command: string;
  title: string;
  error: string | null;
  /** A stop a batch passed by (nobody to read its message). */
  passedStop?: boolean;
}

export type PlayerStatus =
  /** Not started yet. */
  | "idle"
  | "running"
  /** Waiting before step `pausedAt` (a breakpoint, or step-by-step). */
  | "paused"
  /** Halted at an inserted stop; `message` says why. */
  | "stopped"
  | "done"
  | "cancelled";

export interface PlayerState {
  status: PlayerStatus;
  /** The action step the player waits before (paused / stopped: the
   *  step AFTER the stop), or null. */
  pausedAt: number | null;
  /** The stop's message while `stopped`. */
  message: string | null;
  ran: PlayedStep[];
  skipped: Array<{ index: number; title: string; reason: SkipReason }>;
  /** Document undo steps the replay has ended in so far: 1 for an
   *  uninterrupted replay that wrote the document, 0 when it wrote
   *  nothing, more when something broke the chain (see the header). */
  undoSteps: number;
  /** Document writes that applied. */
  writes: number;
}

/** What the player needs from the editor. `beginUndoGroup` /
 *  `endUndoGroup` are `CanvasClient`'s; without them (a test registry, a
 *  host without the client) every write stays its own step and
 *  `undoSteps` reads as unknown (-1). */
export interface PlayerDeps {
  invoke(command: string, payload?: unknown): Promise<unknown>;
  beginUndoGroup?(options: { continueSeq?: number | null }): void;
  endUndoGroup?(): Promise<{
    steps: number;
    writes: number;
    lastSeq: number | null;
  } | null>;
}

export interface PlayerOptions {
  /** Pause after every step (the panel's Step button). */
  stepByStep?: boolean;
  /** Pass inserted stops by (batch: nobody is there to read them). */
  ignoreStops?: boolean;
  /** Ignore breakpoints (batch). */
  ignorePauses?: boolean;
}

/** Run a command, answering its error as text: outside the class, so the
 *  `try` sits where the compiler need not lower it (ADR 229). */
async function invokeStep(
  deps: PlayerDeps,
  command: string,
  payload: unknown,
): Promise<string | null> {
  try {
    await deps.invoke(command, payload);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export class ActionPlayer {
  private readonly run: PlannedStep[];
  private cursor = 0;
  private lastSeq: number | null = null;
  private groupsKnown: boolean;
  private busy: Promise<PlayerState> | null = null;
  private readonly listeners = new Set<(s: PlayerState) => void>();
  private snapshot: PlayerState;
  /** The step at the cursor was paused on: run it without pausing again. */
  private resumeThrough = false;
  private stepping: boolean;

  constructor(
    readonly action: PagedAction,
    private readonly deps: PlayerDeps,
    private readonly options: PlayerOptions = {},
  ) {
    const plan = planReplay(action);
    this.run = plan.run;
    this.stepping = options.stepByStep === true;
    this.groupsKnown = !!deps.beginUndoGroup && !!deps.endUndoGroup;
    this.snapshot = {
      status: "idle",
      pausedAt: null,
      message: null,
      ran: [],
      skipped: plan.skip.map((s) => ({
        index: s.index,
        title: s.step.title,
        reason: s.reason,
      })),
      undoSteps: this.groupsKnown ? 0 : -1,
      writes: 0,
    };
  }

  get state(): PlayerState {
    return this.snapshot;
  }

  /** Is the player waiting for Continue / Step? */
  get waiting(): boolean {
    return (
      this.snapshot.status === "paused" || this.snapshot.status === "stopped"
    );
  }

  get finished(): boolean {
    return (
      this.snapshot.status === "done" || this.snapshot.status === "cancelled"
    );
  }

  subscribe(fn: (s: PlayerState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Start, or Continue from a pause or a stop: run until the next
   *  breakpoint, stop or the end. */
  start(): Promise<PlayerState> {
    this.stepping = this.options.stepByStep === true;
    return this.advance();
  }

  /** Continue (alias of {@link start} once paused). */
  resume(): Promise<PlayerState> {
    this.stepping = false;
    return this.advance();
  }

  /** Run exactly one step, then pause. */
  step(): Promise<PlayerState> {
    this.stepping = true;
    return this.advance();
  }

  /** End playback where it stands. What ran stays done (and undoable as
   *  the step it ended in). */
  cancel(): PlayerState {
    if (this.finished) return this.snapshot;
    this.set({ status: "cancelled", pausedAt: null, message: null });
    return this.snapshot;
  }

  private set(patch: Partial<PlayerState>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const fn of this.listeners) fn(this.snapshot);
  }

  private advance(): Promise<PlayerState> {
    if (this.busy) return this.busy;
    if (this.finished) return Promise.resolve(this.snapshot);
    const p = this.segment().finally(() => {
      this.busy = null;
    });
    this.busy = p;
    return p;
  }

  /** One uninterrupted run of steps inside one undo group. */
  private async segment(): Promise<PlayerState> {
    this.set({ status: "running", pausedAt: null, message: null });
    this.deps.beginUndoGroup?.({ continueSeq: this.lastSeq });
    let ranOne = false;
    let halt: Partial<PlayerState> | null = null;
    while (this.cursor < this.run.length) {
      if (this.snapshot.status === "cancelled") break;
      const { index, step } = this.run[this.cursor];
      const through = this.resumeThrough;
      this.resumeThrough = false;
      if (!through && step.pause && !this.options.ignorePauses) {
        this.resumeThrough = true;
        halt = { status: "paused", pausedAt: index };
        break;
      }
      if (!through && this.stepping && ranOne) {
        this.resumeThrough = true;
        halt = { status: "paused", pausedAt: index };
        break;
      }
      this.cursor += 1;
      if (isStopStep(step)) {
        const message = step.stop?.message ?? step.title;
        if (this.options.ignoreStops) {
          this.push({
            index,
            command: step.command,
            title: message,
            error: null,
            passedStop: true,
          });
          continue;
        }
        const next = this.run[this.cursor]?.index ?? null;
        halt = { status: "stopped", pausedAt: next, message };
        break;
      }
      const error = await invokeStep(this.deps, step.command, step.payload);
      this.push({ index, command: step.command, title: step.title, error });
      ranOne = true;
    }
    const group = await this.deps.endUndoGroup?.();
    if (group) {
      this.lastSeq = group.lastSeq ?? this.lastSeq;
      this.set({
        undoSteps: this.snapshot.undoSteps + group.steps,
        writes: this.snapshot.writes + group.writes,
      });
    }
    if (this.snapshot.status === "cancelled") return this.snapshot;
    if (halt) {
      this.set(halt);
      return this.snapshot;
    }
    this.set({ status: "done", pausedAt: null, message: null });
    return this.snapshot;
  }

  private push(step: PlayedStep): void {
    this.set({ ran: [...this.snapshot.ran, step] });
  }
}
