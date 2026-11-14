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

// The recorder + player. Mounted ABOVE the panel on purpose: the right
// dock renders only its active tab, so a recorder living in the panel
// component would stop recording the moment the user switched tabs to
// do the thing they were recording.
//
// Two taps, for two different jobs:
//
//   · `registries.commands.observe(...)` — the STEPS. The one place a
//     command handler is ever called, so it sees menu, keybinding,
//     palette, tool, panel and plugin commands alike, including ones
//     registered after recording began.
//
//   · `client.subscribe(...)` — the HONESTY. `gestureCommitted` and
//     `mutationApplied` tell us the document changed; when that
//     happens with no command in flight, something the recorder
//     structurally cannot capture just edited the document. Counting
//     it is what turns "silently drops gestures" into a number on
//     screen. See `UncapturedTally` in `model.ts` for why the direct-
//     edit count is a floor rather than an exact ledger.
//
// Editor ADR 1240 adds what a step MEANT and what a run will do:
//
//   · a third tap, on `host.objects` writes from the panels' fields (the
//     provider re-provides the object model to its subtree, wrapped): a
//     field's commit records as one `paged.object.setProperty` step, its
//     targets the selection token when they were the selection — so a font
//     size or a style applied from a panel replays on whatever is selected
//     then, instead of being an uncaptured "direct edit";
//   · every step keeps the edit context it ran in;
//   · parameters, a document scope (`document-store.ts`), a preview that
//     outlines what a run touches and says how it undoes, precise refusals
//     before anything runs, a palette entry per action, the `actions@1`
//     door and a `paged.*` script.
//
// Its amendment 1 adds a fourth tap, on the interaction coordinator's
// committed sessions: a move, copy, resize, scale or rotate of the
// selection on the canvas ends its session with what it did, measured
// from the document (`interaction/transform-intent.ts`), and records as one
// `paged.object.transformSelection` step on the selection — no longer an
// uncaptured gesture.

import { t } from "@paged-media/strings";
import { ACTIONS } from "./messages";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type PropsWithChildren,
} from "react";

import { useCanvasClient } from "../state/canvas-client-context";
import { useRegistries } from "../state/registries-context";
import {
  EMPTY_TALLY,
  RUN_ACTION_PREFIX,
  SET_PROPERTY_COMMAND,
  isRecordable,
  newActionId,
  stepFromIntent,
  stepFromInvocation,
  stepsFromObjectWrite,
  ACTIONS_SCHEMA_VERSION,
  type ActionLibrary,
  type ActionScope,
  type ActionStep,
  type ObservedSet,
  type PagedAction,
  type SkipReason,
  type UncapturedTally,
  type ImportRule,
  importRuleMatches,
  stopStep,
} from "./model";
import { loadLibrary, parseImport, saveLibrary } from "./store";
import {
  ActionPlayer,
  type PlayerDeps,
  type PlayerState,
  type PlayerStatus,
} from "./player";
import { onImported } from "../state/import-hooks";
import { useEditorScope } from "../state/editor-scope";
import { useEditorStorage } from "../state/storage";
import {
  NO_SELECTION,
  isObjectAddress,
  leafAt,
  paramLabelOf,
  type PayloadKey,
  type SelectionAddresses,
} from "./intent";
import {
  planRun,
  referencesOf,
  refusalAtRun,
  type RunPlan,
  type RunRefusal,
  type UndoStatement,
} from "./run-plan";
import { useDocumentActions } from "./document-store";
import {
  ACTIONS_DOOR_OWNER,
  actionsDoorStore,
  definitionOf,
  toPagedScript,
} from "./actions-door";
import { ObjectModelProvider, useObjectModel } from "../catalog/object-model";
import type {
  ShellObjectModelHost,
  ShellObjectOp,
} from "../catalog/object-model-types";
import { checkArgs } from "../catalog/property-field-model";
import { useOptionalSelection } from "../state/selection-context";
import { useOptionalContentSelection } from "../state/content-selection-context";
import { useOptionalEditContextStack } from "../state/edit-context-stack";
import { useSessionRole } from "../state/session-role";
import { useOptionalDocument } from "../state/document-context";
import {
  clearPreviewTargets,
  showPreviewTargets,
} from "../state/preview-targets";
import { reportOperation } from "../state/operation-feedback";
import { useInteractionCoordinator } from "../interaction/coordinator";

export interface RecordingState {
  startedAt: number;
  steps: ActionStep[];
  uncaptured: UncapturedTally;
}

export interface ReplayStepResult {
  index: number;
  command: string;
  title: string;
  error: string | null;
}

export interface ReplayReport {
  actionId: string;
  actionName: string;
  ran: ReplayStepResult[];
  skipped: Array<{ index: number; title: string; reason: SkipReason }>;
  /** `mutationApplied` count observed while the replay was in flight. */
  mutations: number;
  /** WP4.11 — the document undo steps the replay ended in (the player
   *  groups it, see `player.ts`): 1 for an uninterrupted replay that
   *  wrote the document; -1 when the client offers no undo group. */
  undoSteps: number;
  /** Ended by Cancel rather than by running out of steps. */
  cancelled: boolean;
  finishedAt: number;
  /** Editor ADR 1240 — refused before anything ran (the plan's refusals:
   *  nothing ran), or the step a run stopped at. */
  refusals: RunRefusal[];
  /** A run refused at a step had its writes undone. */
  rolledBack: boolean;
  /** What the plan said about undo before the run. */
  undo: UndoStatement | null;
}

/** WP4.11 — a replay that is waiting (paused, stopped) or running. */
export interface PlaybackState {
  actionId: string;
  status: PlayerStatus;
  /** The step it waits before, or null. */
  pausedAt: number | null;
  /** An inserted stop's message while stopped. */
  message: string | null;
  /** Steps run so far. */
  ran: number;
}

export interface PlayOptions {
  /** Pause after every step. */
  stepByStep?: boolean;
  /** Editor ADR 1240 — the user saw the preview's undo statement: a run
   *  that is not one undo step runs only with it (the palette's entry
   *  opens the preview instead). */
  confirmed?: boolean;
}

export interface ActionsApi {
  actions: PagedAction[];
  recording: RecordingState | null;
  /** Non-null while a replay is in flight. */
  playingId: string | null;
  lastReport: ReplayReport | null;
  /** False when localStorage refused the last write. */
  persisted: boolean;

  startRecording(): void;
  cancelRecording(): void;
  /** Ends the recording and files it under `name`. Returns the new
   *  action, or null when nothing was captured. */
  stopRecording(name: string): PagedAction | null;

  /** Play an action. Resolves with the report once it FINISHES, or with
   *  null while it waits at a breakpoint or a stop (Continue / Step /
   *  Cancel drive it from there, and the report arrives then). */
  play(actionId: string, options?: PlayOptions): Promise<ReplayReport | null>;
  /** The replay in flight or waiting, or null. */
  playback: PlaybackState | null;
  /** Continue a waiting replay to its next breakpoint, stop or the end. */
  resume(): Promise<ReplayReport | null>;
  /** Run the next step of a waiting replay, then wait again. */
  stepOnce(): Promise<ReplayReport | null>;
  /** End a waiting replay where it stands. */
  cancelPlayback(): void;
  /** Toggle the breakpoint before step `index`. */
  togglePause(actionId: string, index: number): void;
  /** Insert a stop showing `message` before step `index` (`steps.length`
   *  appends it). */
  insertStop(actionId: string, index: number, message: string): void;
  /** The run-on-import rules. */
  importRules: readonly ImportRule[];
  setImportRules(rules: readonly ImportRule[]): void;

  rename(actionId: string, name: string): void;
  remove(actionId: string): void;
  setIncludeDocumentBound(actionId: string, include: boolean): void;
  toggleStep(actionId: string, index: number): void;
  deleteStep(actionId: string, index: number): void;
  /** Returns how many actions were accepted (invalid ones are dropped). */
  importActions(text: string): number;
  dismissReport(): void;

  // ── editor ADR 1240 ──
  /** Work out what a run of `actionId` would do here, outline its targets
   *  on the canvas and keep the plan as `previewPlan`. Changes nothing. */
  preview(actionId: string): Promise<RunPlan | null>;
  /** The plan the preview shows, or null. */
  previewPlan: RunPlan | null;
  /** Point at one target of the preview (the list's hover). */
  focusTarget(address: string | null): void;
  /** End the preview and its outlines. */
  clearPreview(): void;
  /** Make the payload leaf at `path` of step `index` a parameter. */
  addParam(actionId: string, index: number, path: readonly PayloadKey[]): void;
  setParamValue(
    actionId: string,
    paramId: string,
    value: string | number | boolean,
  ): void;
  renameParam(actionId: string, paramId: string, label: string): void;
  removeParam(actionId: string, paramId: string): void;
  /** Keep the action for this user or in the open document. Resolves the
   *  refusal in words, or null. */
  setScope(actionId: string, scope: ActionScope): Promise<string | null>;
  /** Whether the open document can keep actions. */
  documentScopeAvailable: boolean;
  /** The action as a `paged.*` script. */
  pagedScript(actionId: string): string;
}

const Context = createContext<ActionsApi | null>(null);

/** The player's door to the editor: the registry runs the steps, and the
 *  client — when it is the real `CanvasClient` — groups their writes into
 *  one undo step. A client without the group (a test stub) leaves every
 *  write its own step, and the report says the count is unknown. */
export function playerDeps(
  commands: {
    invoke(id: string, payload?: unknown): Promise<unknown>;
    applicability?(id: string): { state: string; reason?: string };
  },
  client: unknown,
  live?: {
    selection(): SelectionAddresses;
    context(): string | null;
    contextLabel(type: string | null): string;
    objects: ShellObjectModelHost["objects"] | null;
  },
): PlayerDeps {
  const c = client as Partial<{
    beginUndoGroup(o: { continueSeq?: number | null }): void;
    endUndoGroup(): Promise<{
      steps: number;
      writes: number;
      lastSeq: number | null;
    } | null>;
    undoLog(limit?: number): Promise<{ undo: Array<{ appliedSeq: number }> }>;
    undoTo(seq: number): Promise<{ kind: string }>;
  }>;
  const grouped =
    typeof c?.beginUndoGroup === "function" &&
    typeof c?.endUndoGroup === "function";
  const objects = live?.objects ?? null;
  return {
    // Editor ADR 1240 — a recorded property write is not a registered
    // command: the player writes it through `host.objects`, one batch.
    invoke: async (id, payload) => {
      if (id !== SET_PROPERTY_COMMAND) return commands.invoke(id, payload);
      if (!objects) throw new Error(t(ACTIONS.refuseNoObjects));
      const p = payload as { targets: string[]; path: string; value: unknown };
      const ops: ShellObjectOp[] = p.targets.map((address) => ({
        op: "set",
        address,
        path: p.path,
        value: p.value,
      }));
      const result = await objects.batch(ops);
      if (!result.applied) throw new Error(result.reason ?? "refused");
      return result;
    },
    ...(grouped
      ? {
          beginUndoGroup: (o) => c.beginUndoGroup!(o),
          endUndoGroup: () => c.endUndoGroup!(),
        }
      : {}),
    ...(commands.applicability
      ? {
          applicability: (id: string) =>
            id === SET_PROPERTY_COMMAND
              ? objects
                ? { state: "here" }
                : { state: "absent", reason: t(ACTIONS.refuseNoObjects) }
              : commands.applicability!(id),
        }
      : {}),
    ...(live
      ? {
          selection: live.selection,
          context: live.context,
          refusalText: (
            _command: string,
            title: string,
            index: number,
            why: string,
          ) =>
            refusalAtRun(
              { command: "", title, verdict: "contextual" },
              index,
              why,
            ),
          selectionText: (kind: "elements" | "element" | "text") =>
            kind === "elements"
              ? t(ACTIONS.needsSelection)
              : kind === "element"
                ? t(ACTIONS.needsOneObject)
                : t(ACTIONS.needsText),
          contextText: (recorded: string | null, current: string | null) =>
            t(ACTIONS.contextDiffers, {
              recorded: live.contextLabel(recorded),
              current: live.contextLabel(current),
            }),
        }
      : {}),
    ...(typeof c?.undoLog === "function" && typeof c?.undoTo === "function"
      ? {
          // Undo the run's one step, only while it is still the newest:
          // an edit made since is the user's, and stays.
          rollback: async (seq: number) => {
            const log = await c.undoLog!(1).catch(() => null);
            const top = log?.undo[log.undo.length - 1];
            if ((top?.appliedSeq ?? null) !== seq) return false;
            const reply = await c.undoTo!(seq);
            return reply.kind === "undoApplied";
          },
        }
      : {}),
  };
}

function reportOf(
  action: PagedAction,
  state: PlayerState,
  mutations: number,
  undo: UndoStatement | null = null,
): ReplayReport {
  return {
    refusals: state.refusal
      ? [{ index: state.pausedAt, reason: state.refusal }]
      : [],
    rolledBack: state.rolledBack,
    undo,
    actionId: action.id,
    actionName: action.name,
    ran: state.ran.map((r) => ({
      index: r.index,
      command: r.command,
      title: r.title,
      error: r.error,
    })),
    skipped: state.skipped,
    mutations,
    undoSteps: state.undoSteps,
    cancelled: state.status === "cancelled",
    finishedAt: Date.now(),
  };
}

function playbackOf(action: PagedAction, state: PlayerState): PlaybackState {
  return {
    actionId: action.id,
    status: state.status,
    pausedAt: state.pausedAt,
    message: state.message,
    ran: state.ran.length,
  };
}

/** What the api and the commands reach the plan through. */
interface PlanHelpers {
  planFor(action: PagedAction): Promise<RunPlan>;
  showPlan(plan: RunPlan | null): void;
  refusedReport(action: PagedAction, plan: RunPlan): ReplayReport;
  liveDeps(): Parameters<typeof playerDeps>[2];
  setScope(actionId: string, scope: ActionScope): Promise<string | null>;
}

const NO_HELPERS: PlanHelpers = {
  planFor: () =>
    Promise.reject(new Error("the actions provider has not mounted")),
  showPlan: () => {},
  refusedReport: () => {
    throw new Error("the actions provider has not mounted");
  },
  liveDeps: () => undefined,
  setScope: async () => null,
};

export function ActionsProvider({ children }: PropsWithChildren) {
  const registries = useRegistries();
  const client = useCanvasClient();

  // The editor's settings store (state/storage.ts).
  const storage = useEditorStorage();
  const [library, setLibrary] = useState<ActionLibrary>(() =>
    loadLibrary(storage),
  );
  const [recording, setRecording] = useState<RecordingState | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [playback, setPlayback] = useState<PlaybackState | null>(null);
  const playerRef = useRef<ActionPlayer | null>(null);
  const scope = useEditorScope();
  const [lastReport, setLastReport] = useState<ReplayReport | null>(null);
  const [persisted, setPersisted] = useState(true);

  // Refs the two taps write through. The observers are installed ONCE
  // (see the effect below) and must not be re-subscribed on every
  // state change, so they read intent from refs rather than closing
  // over state.
  const recordingRef = useRef(false);
  const inFlight = useRef(0);
  const replayingRef = useRef(false);
  const replayMutations = useRef(0);

  // ── editor ADR 1240: what the editor holds right now ─────────────
  const model = useObjectModel();
  const selectionCtx = useOptionalSelection();
  const contentCtx = useOptionalContentSelection();
  const contexts = useOptionalEditContextStack();
  const role = useSessionRole();
  const documentCtx = useOptionalDocument();
  const documentActions = useDocumentActions(
    client,
    model,
    t(ACTIONS.documentFull),
  );
  const [previewPlan, setPreviewPlan] = useState<RunPlan | null>(null);
  const elementSelection = selectionCtx?.elementSelection;
  const contentSelection = contentCtx?.contentSelection ?? null;
  const activeContext = contexts?.active?.type ?? null;
  const liveRef = useRef<{
    selection: SelectionAddresses;
    context: string | null;
  }>({ selection: NO_SELECTION, context: null });
  // The latest selection and context, for the taps and the player (a ref
  // written in a layout effect, ADR 229).
  useLayoutEffect(() => {
    const elements =
      model && elementSelection
        ? elementSelection.map((id) => model.addressOf(id))
        : [];
    const text =
      model &&
      contentSelection &&
      contentSelection.end !== contentSelection.start
        ? model.addressOf({
            kind: "storyRange",
            id: {
              story_id: contentSelection.storyId,
              start: contentSelection.start,
              end: contentSelection.end,
            },
          } as never)
        : null;
    liveRef.current = { selection: { elements, text }, context: activeContext };
  });

  // Every action: the user's, then the open document's.
  // eslint-disable-next-line no-restricted-syntax -- a dependency of the api value its consumers compare (ADR 229)
  const allActions = useMemo(
    (): PagedAction[] => [...library.actions, ...documentActions.actions],
    [library.actions, documentActions.actions],
  );

  // eslint-disable-next-line no-restricted-syntax -- keeps an effect dependency stable (ADR 229)
  const commit = useCallback(
    (next: ActionLibrary) => {
      setLibrary(next);
      setPersisted(saveLibrary(next, storage));
    },
    [storage],
  );

  // Deliberately NOT a functional `setLibrary` updater: React runs
  // updaters during the render phase, so writing localStorage and
  // another component's state from inside one is a side effect in
  // render. Every caller already has the current library in scope.
  // A document action is written back into the document (one undo step).
  // eslint-disable-next-line no-restricted-syntax -- keeps an effect dependency stable (ADR 229)
  const patch = useCallback(
    (actionId: string, fn: (action: PagedAction) => PagedAction) => {
      if (documentActions.actions.some((a) => a.id === actionId)) {
        void documentActions.save(
          documentActions.actions.map((a) => (a.id === actionId ? fn(a) : a)),
          t(ACTIONS.saveToDocument),
        );
        return;
      }
      commit({
        ...library,
        schema: ACTIONS_SCHEMA_VERSION,
        actions: library.actions.map((a) => (a.id === actionId ? fn(a) : a)),
      });
    },
    [library, commit, documentActions],
  );

  // ── the command tap ────────────────────────────────────────────
  useEffect(() => {
    const off = registries.commands.observe((event) => {
      const { phase, invocation } = event;
      if (phase === "started") {
        inFlight.current += 1;
        if (!recordingRef.current) return;
        if (!isRecordable(invocation.id)) return;
        // Editor ADR 1240: the selection it names becomes an intent, and
        // the step keeps the context it ran in.
        const step = stepFromInvocation(invocation, liveRef.current);
        setRecording((prev) =>
          prev ? { ...prev, steps: [...prev.steps, step] } : prev,
        );
        return;
      }
      inFlight.current = Math.max(0, inFlight.current - 1);
      if (!event.error) return;
      if (!recordingRef.current || !isRecordable(invocation.id)) return;
      // Mark rather than drop: a step that failed while recording is a
      // fact about the recording, and hiding it would leave the user
      // wondering why the action is one step short of what they did.
      setRecording((prev) => {
        if (!prev) return prev;
        const steps = [...prev.steps];
        for (let i = steps.length - 1; i >= 0; i -= 1) {
          if (steps[i].command === invocation.id && !steps[i].failed) {
            steps[i] = { ...steps[i], failed: true };
            break;
          }
        }
        return { ...prev, steps };
      });
    });
    return () => off.dispose();
  }, [registries]);

  // ── the coverage tap ───────────────────────────────────────────
  useEffect(() => {
    const off = client.subscribe((msg) => {
      if (msg.kind === "gestureCommitted") {
        if (replayingRef.current) return;
        if (!recordingRef.current) return;
        setRecording((prev) =>
          prev
            ? {
                ...prev,
                uncaptured: {
                  ...prev.uncaptured,
                  gestures: prev.uncaptured.gestures + 1,
                },
              }
            : prev,
        );
        return;
      }
      if (msg.kind !== "mutationApplied") return;
      if (replayingRef.current) {
        replayMutations.current += 1;
        return;
      }
      if (!recordingRef.current) return;
      // A mutation with a command in flight is (very probably) that
      // command's own work and IS captured. One with none in flight is
      // typing, a panel field, or a gesture commit — none of which the
      // registry can see.
      if (inFlight.current > 0) return;
      setRecording((prev) =>
        prev
          ? {
              ...prev,
              uncaptured: {
                ...prev.uncaptured,
                directEdits: prev.uncaptured.directEdits + 1,
              },
            }
          : prev,
      );
    });
    return () => off();
  }, [client]);

  // ── the gesture tap (editor ADR 1240, amendment 1) ─────────────
  // Observed only while recording: the canvas measures a commit (a
  // geometry read before and after) only when someone observes. The
  // gesture's `gestureCommitted` was counted as uncaptured a moment
  // earlier; a recorded one is taken off that count.
  const interactions = useInteractionCoordinator();
  const isRecording = recording !== null;
  useEffect(() => {
    if (!isRecording) return;
    return interactions.onCommitted(({ intent }) => {
      if (!recordingRef.current || replayingRef.current) return;
      const step = stepFromIntent(intent, liveRef.current);
      setRecording((prev) =>
        prev
          ? {
              ...prev,
              steps: [...prev.steps, step],
              uncaptured: {
                ...prev.uncaptured,
                gestures: Math.max(0, prev.uncaptured.gestures - 1),
              },
            }
          : prev,
      );
    });
  }, [isRecording, interactions]);

  // ── the object-write tap (editor ADR 1240) ─────────────────────
  // The panels below write through this wrapped model: a field's commit
  // records as a property step. A scrub (one coalesce key) records once,
  // its last value. The write counts as in flight, so its mutation is not
  // also counted as an uncaptured direct edit.
  const coalesceRef = useRef<{ key: string; steps: number } | null>(null);
  const noteWrite = (
    sets: readonly ObservedSet[],
    coalesce: string | undefined,
  ): void => {
    if (!recordingRef.current || replayingRef.current || sets.length === 0)
      return;
    const steps = stepsFromObjectWrite(
      sets,
      (path, value) =>
        t(ACTIONS.setProperty, {
          path: paramLabelOf([path]),
          value:
            typeof value === "object" ? JSON.stringify(value) : String(value),
        }),
      liveRef.current,
    );
    const joining =
      coalesce !== undefined && coalesceRef.current?.key === coalesce
        ? coalesceRef.current.steps
        : 0;
    coalesceRef.current = coalesce
      ? { key: coalesce, steps: steps.length }
      : null;
    setRecording((prev) =>
      prev
        ? {
            ...prev,
            steps: [
              ...prev.steps.slice(0, prev.steps.length - joining),
              ...steps,
            ],
          }
        : prev,
    );
  };
  const noteWriteRef = useRef(noteWrite);
  useLayoutEffect(() => {
    noteWriteRef.current = noteWrite;
  });
  // eslint-disable-next-line no-restricted-syntax -- the wrapped model is a context value its consumers compare (ADR 229)
  const tappedModel = useMemo((): ShellObjectModelHost | null => {
    if (!model) return null;
    const setsOf = (ops: readonly ShellObjectOp[]): ObservedSet[] =>
      ops.flatMap((o) =>
        o.op === "set"
          ? [{ address: o.address, path: o.path, value: o.value }]
          : [],
      );
    const tracked = <R extends { applied?: boolean }>(
      sets: ObservedSet[],
      coalesce: string | undefined,
      write: () => Promise<R>,
    ): Promise<R> => {
      inFlight.current += 1;
      return write()
        .then((result) => {
          if (result.applied !== false) noteWriteRef.current(sets, coalesce);
          return result;
        })
        .finally(() => {
          inFlight.current = Math.max(0, inFlight.current - 1);
        });
    };
    return {
      ...model,
      objects: {
        ...model.objects,
        query: (s, o) => model.objects.query(s, o),
        get: (a, p) => model.objects.get(a, p),
        schema: (a) => model.objects.schema(a),
        commands: () => model.objects.commands(),
        invoke: (c, a) => model.objects.invoke(c, a),
        onDidChange: (l) => model.objects.onDidChange(l),
        set: (address, path, value, opts) =>
          tracked([{ address, path, value }], opts?.coalesce, () =>
            model.objects.set(address, path, value, opts),
          ),
        batch: (ops, opts) =>
          tracked(setsOf(ops), opts?.coalesce, () =>
            model.objects.batch(ops, opts),
          ),
      },
    };
  }, [model]);

  // eslint-disable-next-line no-restricted-syntax -- keeps an effect dependency stable (ADR 229)
  const startRecording = useCallback(() => {
    setLastReport(null);
    coalesceRef.current = null;
    recordingRef.current = true;
    setRecording({
      startedAt: Date.now(),
      steps: [],
      uncaptured: { ...EMPTY_TALLY },
    });
  }, []);

  // eslint-disable-next-line no-restricted-syntax -- keeps an effect dependency stable (ADR 229)
  const cancelRecording = useCallback(() => {
    recordingRef.current = false;
    setRecording(null);
  }, []);

  // eslint-disable-next-line no-restricted-syntax -- keeps an effect dependency stable (ADR 229)
  const stopRecording = useCallback(
    (name: string): PagedAction | null => {
      recordingRef.current = false;
      const current = recording;
      setRecording(null);
      if (!current || current.steps.length === 0) return null;
      const action: PagedAction = {
        id: newActionId(),
        name:
          name.trim() ||
          t(ACTIONS.defaultName, { n: library.actions.length + 1 }),
        createdAt: Date.now(),
        steps: current.steps,
        uncaptured: current.uncaptured,
        includeDocumentBound: false,
      };
      commit({
        ...library,
        schema: ACTIONS_SCHEMA_VERSION,
        actions: [...library.actions, action],
      });
      return action;
    },
    [recording, library, commit],
  );

  /** What the plan said about undo, for the report of the run in flight. */
  const undoRef = useRef<UndoStatement | null>(null);
  /** The plan's helpers of the latest render (set in a layout effect). */
  const helpersRef = useRef<PlanHelpers>(NO_HELPERS);

  /** Drive the player one leg (start, Continue, Step) and settle the
   *  panel's state from where it ended: still waiting, or finished with
   *  a report. */
  // eslint-disable-next-line no-restricted-syntax -- keeps an effect dependency stable (ADR 229)
  const drive = useCallback(
    async (
      player: ActionPlayer,
      leg: (p: ActionPlayer) => Promise<PlayerState>,
    ): Promise<ReplayReport | null> => {
      replayingRef.current = true;
      setPlayback(
        playbackOf(player.action, { ...player.state, status: "running" }),
      );
      const state = await leg(player).finally(() => {
        replayingRef.current = false;
      });
      if (!player.finished) {
        setPlayback(playbackOf(player.action, state));
        return null;
      }
      playerRef.current = null;
      setPlayingId(null);
      setPlayback(null);
      const report = reportOf(
        player.action,
        state,
        replayMutations.current,
        undoRef.current,
      );
      setLastReport(report);
      return report;
    },
    [],
  );

  // ── editor ADR 1240: the plan, the preview, the refusals ─────────
  const contextLabel = (type: string | null): string =>
    type === null
      ? t(ACTIONS.thePage)
      : (registries.editContexts.get(type)?.label ?? type);
  const liveDeps = () => ({
    selection: () => liveRef.current.selection,
    context: () => liveRef.current.context,
    contextLabel,
    objects: model?.objects ?? null,
  });

  /** What a run of `action` would do here (changes nothing). */
  const planFor = async (action: PagedAction): Promise<RunPlan> => {
    const missing = new Set<string>();
    if (model) {
      for (const ref of referencesOf(action, isObjectAddress)) {
        const found = await model.objects.query(ref).catch(() => []);
        if (found.length === 0) missing.add(ref);
      }
    }
    const groups =
      typeof (client as { beginUndoGroup?: unknown }).beginUndoGroup ===
      "function";
    return planRun(action, {
      documentOpen: !documentCtx || documentCtx.handle !== null,
      role,
      context: liveRef.current.context,
      contextLabel,
      selection: liveRef.current.selection,
      command: (id) => {
        if (id === SET_PROPERTY_COMMAND)
          return {
            registered: model !== null,
            offered: true,
            ownsHistory: false,
          };
        const cmd = registries.commands.get(id);
        return {
          registered: cmd !== undefined,
          offered: registries.commands.offered?.(id) ?? true,
          ownsHistory: cmd?.history === "own-step",
        };
      },
      checkArgs: (id, payload) => {
        if (id === SET_PROPERTY_COMMAND) return null;
        const args = registries.commands.argsOf(id);
        return args ? checkArgs(args, payload) : null;
      },
      isAddress: isObjectAddress,
      missing,
      undoGroups: groups,
      ownsUndo: (type) => !!registries.editContexts.get(type)?.onUndo,
    });
  };

  const showPlan = (plan: RunPlan | null) => {
    setPreviewPlan(plan);
    if (plan) showPreviewTargets(scope, "actions", plan.targets);
    else clearPreviewTargets(scope, "actions");
  };

  /** A run refused before it started: the report says why, nothing ran. */
  const refusedReport = (action: PagedAction, plan: RunPlan): ReplayReport => ({
    actionId: action.id,
    actionName: action.name,
    ran: [],
    skipped: plan.skipped.map((s) => ({
      index: s.index,
      title: s.step.title,
      reason: s.reason,
    })),
    mutations: 0,
    undoSteps: 0,
    cancelled: false,
    finishedAt: Date.now(),
    refusals: plan.refusals,
    rolledBack: false,
    undo: plan.undo,
  });

  // eslint-disable-next-line no-restricted-syntax -- keeps an effect dependency stable (ADR 229)
  const play = useCallback(
    async (
      actionId: string,
      options: PlayOptions = {},
    ): Promise<ReplayReport | null> => {
      const action = allActions.find((a) => a.id === actionId);
      if (!action || playingId || playerRef.current) return null;
      const { planFor, showPlan, refusedReport, liveDeps } = helpersRef.current;
      const plan = await planFor(action);
      if (plan.refusals.length > 0) {
        // Nothing runs: the action never targets something else instead.
        const report = refusedReport(action, plan);
        showPlan(plan);
        setLastReport(report);
        reportOperation(scope, {
          action: t(ACTIONS.runActionDone, { name: action.name }),
          outcome: "blocked",
          reason: plan.refusals[0]!.reason,
          document: "unchanged",
          source: "paged.actions",
        });
        return report;
      }
      if (plan.undo.kind !== "one" && !options.confirmed) {
        // Said before it runs: a run that is not one undo step waits in its
        // preview for the user to run it there.
        showPlan(plan);
        reportOperation(scope, {
          action: t(ACTIONS.runActionDone, { name: action.name }),
          outcome: "blocked",
          reason: t(ACTIONS.needsReview),
          document: "unchanged",
          source: "paged.actions",
        });
        return null;
      }
      showPlan(null);
      undoRef.current = plan.undo;
      const player = new ActionPlayer(
        action,
        playerDeps(registries.commands, client, liveDeps()),
        { stepByStep: options.stepByStep === true },
      );
      playerRef.current = player;
      setPlayingId(actionId);
      setLastReport(null);
      replayMutations.current = 0;
      return drive(player, (p) => p.start());
    },
    [allActions, playingId, registries, client, drive, scope],
  );

  // eslint-disable-next-line no-restricted-syntax -- keeps an effect dependency stable (ADR 229)
  const resume = useCallback(async () => {
    const player = playerRef.current;
    if (!player || !player.waiting) return null;
    return drive(player, (p) => p.resume());
  }, [drive]);

  // eslint-disable-next-line no-restricted-syntax -- keeps an effect dependency stable (ADR 229)
  const stepOnce = useCallback(async () => {
    const player = playerRef.current;
    if (!player || !player.waiting) return null;
    return drive(player, (p) => p.step());
  }, [drive]);

  // eslint-disable-next-line no-restricted-syntax -- keeps an effect dependency stable (ADR 229)
  const cancelPlayback = useCallback(() => {
    const player = playerRef.current;
    if (!player) return;
    const state = player.cancel();
    if (player.waiting || !replayingRef.current) {
      playerRef.current = null;
      setPlayingId(null);
      setPlayback(null);
      setLastReport(reportOf(player.action, state, replayMutations.current));
    }
  }, []);

  // ── run on import ──────────────────────────────────────────────
  // A rule's action plays once the import finished; one import at a time
  // (an action that itself opens a file does not set the rules off again).
  const rulesRef = useRef<{
    library: ActionLibrary;
    play: (id: string) => Promise<ReplayReport | null>;
  } | null>(null);
  useLayoutEffect(() => {
    rulesRef.current = { library, play };
  });
  useEffect(() => {
    let running = false;
    return onImported(scope, async (file) => {
      const current = rulesRef.current;
      if (!current || running) return;
      const rule = (current.library.importRules ?? []).find(
        (r) =>
          importRuleMatches(r, file.name) &&
          current.library.actions.some((a) => a.id === r.actionId),
      );
      if (!rule) return;
      running = true;
      await current.play(rule.actionId).finally(() => {
        running = false;
      });
    });
  }, [scope]);

  /** Move `action` between the user's list and the document's. */
  const setScope = async (
    actionId: string,
    to: ActionScope,
  ): Promise<string | null> => {
    const action = allActions.find((a) => a.id === actionId);
    if (!action || (action.scope ?? "user") === to) return null;
    if (to === "document") {
      if (!documentActions.available) return t(ACTIONS.refuseNoObjects);
      const refused = await documentActions.save(
        [...documentActions.actions, { ...action, scope: "document" }],
        t(ACTIONS.saveToDocument),
      );
      if (refused) return refused;
      commit({
        ...library,
        schema: ACTIONS_SCHEMA_VERSION,
        actions: library.actions.filter((a) => a.id !== actionId),
      });
      return null;
    }
    const refused = await documentActions.save(
      documentActions.actions.filter((a) => a.id !== actionId),
      t(ACTIONS.saveToDocument),
    );
    if (refused) return refused;
    const { scope: _was, ...rest } = action;
    commit({
      ...library,
      schema: ACTIONS_SCHEMA_VERSION,
      actions: [...library.actions, rest],
    });
    return null;
  };

  // The plan's helpers read the editor of this render; the api and the
  // commands reach them through a ref (written after each commit, ADR 229).
  const helpers: PlanHelpers = {
    planFor,
    showPlan,
    refusedReport,
    liveDeps,
    setScope,
  };
  useLayoutEffect(() => {
    helpersRef.current = helpers;
  });

  const paramId = () => `p_${Math.random().toString(36).slice(2, 8)}`;

  // eslint-disable-next-line no-restricted-syntax -- its type argument types the value (ADR 229)
  const api = useMemo<ActionsApi>(
    () => ({
      actions: allActions,
      recording,
      playingId,
      lastReport,
      persisted,
      startRecording,
      cancelRecording,
      stopRecording,
      play,
      playback,
      resume,
      stepOnce,
      cancelPlayback,
      togglePause: (id, index) =>
        patch(id, (a) => ({
          ...a,
          steps: a.steps.map((s, i) =>
            i === index ? { ...s, pause: !s.pause } : s,
          ),
        })),
      insertStop: (id, index, message) =>
        patch(id, (a) => {
          const steps = [...a.steps];
          steps.splice(
            Math.max(0, Math.min(index, steps.length)),
            0,
            stopStep(message),
          );
          return { ...a, steps };
        }),
      importRules: library.importRules ?? [],
      setImportRules: (rules) =>
        commit({ ...library, importRules: [...rules] }),
      rename: (id, name) => patch(id, (a) => ({ ...a, name })),
      remove: (id) => {
        if (documentActions.actions.some((a) => a.id === id)) {
          void documentActions.save(
            documentActions.actions.filter((a) => a.id !== id),
            t(ACTIONS.saveToDocument),
          );
          return;
        }
        commit({
          ...library,
          schema: ACTIONS_SCHEMA_VERSION,
          actions: library.actions.filter((a) => a.id !== id),
          // A rule naming a deleted action names nothing.
          importRules: (library.importRules ?? []).filter(
            (r) => r.actionId !== id,
          ),
        });
      },
      setIncludeDocumentBound: (id, include) =>
        patch(id, (a) => ({ ...a, includeDocumentBound: include })),
      toggleStep: (id, index) =>
        patch(id, (a) => ({
          ...a,
          steps: a.steps.map((s, i) =>
            i === index ? { ...s, disabled: !s.disabled } : s,
          ),
        })),
      deleteStep: (id, index) =>
        patch(id, (a) => ({
          ...a,
          steps: a.steps.filter((_, i) => i !== index),
        })),
      importActions: (text) => {
        const incoming = parseImport(text);
        if (incoming.length === 0) return 0;
        // Re-key on import so a re-import of the same file adds copies
        // rather than silently overwriting the user's edits.
        const fresh = incoming.map((a) => ({ ...a, id: newActionId() }));
        commit({
          ...library,
          schema: ACTIONS_SCHEMA_VERSION,
          actions: [...library.actions, ...fresh],
        });
        return fresh.length;
      },
      dismissReport: () => setLastReport(null),
      preview: async (id) => {
        const action = allActions.find((a) => a.id === id);
        if (!action) return null;
        const plan = await helpersRef.current.planFor(action);
        helpersRef.current.showPlan(plan);
        return plan;
      },
      previewPlan,
      focusTarget: (address) => {
        if (previewPlan)
          showPreviewTargets(scope, "actions", previewPlan.targets, address);
      },
      clearPreview: () => helpersRef.current.showPlan(null),
      addParam: (id, index, path) =>
        patch(id, (a) => {
          const step = a.steps[index];
          const value = leafAt(step?.payload, path);
          if (
            typeof value !== "string" &&
            typeof value !== "number" &&
            typeof value !== "boolean"
          )
            return a;
          const params = a.params ?? [];
          if (
            params.some(
              (p) =>
                p.step === index &&
                JSON.stringify(p.path) === JSON.stringify(path),
            )
          )
            return a;
          return {
            ...a,
            params: [
              ...params,
              {
                id: paramId(),
                label: paramLabelOf(path),
                step: index,
                path: [...path],
                value,
              },
            ],
          };
        }),
      setParamValue: (id, pid, value) =>
        patch(id, (a) => ({
          ...a,
          params: (a.params ?? []).map((p) =>
            p.id === pid ? { ...p, value } : p,
          ),
        })),
      renameParam: (id, pid, label) =>
        patch(id, (a) => ({
          ...a,
          params: (a.params ?? []).map((p) =>
            p.id === pid ? { ...p, label } : p,
          ),
        })),
      removeParam: (id, pid) =>
        patch(id, (a) => ({
          ...a,
          params: (a.params ?? []).filter((p) => p.id !== pid),
        })),
      setScope: (id, to) => helpersRef.current.setScope(id, to),
      documentScopeAvailable: documentActions.available,
      pagedScript: (id) => {
        const action = allActions.find((a) => a.id === id);
        return action
          ? toPagedScript(action, (command) =>
              t(ACTIONS.scriptEditorOnly, { command }),
            )
          : "";
      },
    }),
    [
      library,
      allActions,
      documentActions,
      scope,
      recording,
      playingId,
      lastReport,
      persisted,
      startRecording,
      cancelRecording,
      stopRecording,
      play,
      playback,
      resume,
      stepOnce,
      cancelPlayback,
      patch,
      commit,
      previewPlan,
    ],
  );

  // Record / stop / play as COMMANDS, so they are palette- and
  // keybinding-reachable like everything else. Registered once (ids
  // are unique per registry and `register` throws on a duplicate);
  // the handlers read the live api through a ref rather than closing
  // over the memo, which changes on every state update.
  //
  // This is also what makes `NON_RECORDABLE_COMMANDS` load-bearing:
  // without it, invoking `paged.actions.play` while recording would
  // record the act of replaying.
  const apiRef = useRef<ActionsApi | null>(null);
  // Kept current after each commit (a ref written during render keeps the
  // provider uncompiled, ADR 229).
  useLayoutEffect(() => {
    apiRef.current = api;
  });
  useEffect(() => {
    const disposers = [
      registries.commands.register({
        id: "paged.actions.record",
        title: t(ACTIONS.startRecording),
        category: "Actions",
        handler: () => apiRef.current?.startRecording(),
      }),
      registries.commands.register({
        id: "paged.actions.stop",
        title: t(ACTIONS.stopRecording),
        category: "Actions",
        handler: () => apiRef.current?.stopRecording(""),
      }),
      registries.commands.register({
        id: "paged.actions.play",
        // The command palette invokes with NO payload (see
        // `CommandPalette.run`), so an id-only handler would register a
        // palette entry that can never do anything — the same lie as a
        // dead rail tool. Falling back to the most recent action makes
        // the palette entry actually usable and matches the "play what
        // I just recorded" reflex; the panel's Play button always
        // passes an explicit id.
        title: t(ACTIONS.playRecent),
        category: "Actions",
        handler: (_editor, payload) => {
          const current = apiRef.current;
          if (!current) return;
          const id =
            typeof payload === "string" && payload.length > 0
              ? payload
              : current.actions[current.actions.length - 1]?.id;
          return id ? current.play(id) : undefined;
        },
      }),
    ];
    return () => {
      for (const d of disposers) d.dispose();
    };
  }, [registries]);

  // Editor ADR 1240 — one palette entry per saved action, "Run action:
  // <name>", and each action on the `actions@1` door. Re-registered when
  // the list (ids, names, contents) changes.
  const door = useSyncExternalStore(
    actionsDoorStore(scope).subscribe,
    actionsDoorStore(scope).get,
    actionsDoorStore(scope).get,
  );
  const listKey = JSON.stringify(allActions.map((a) => [a.id, a.name]));
  useEffect(() => {
    const ids = JSON.parse(listKey) as Array<[string, string]>;
    const disposers = ids.map(([id, name]) =>
      registries.commands.register({
        id: `${RUN_ACTION_PREFIX}${id}`,
        title: t(ACTIONS.runAction, { name }),
        category: "Actions",
        handler: () => apiRef.current?.play(id),
      }),
    );
    return () => {
      for (const d of disposers) d.dispose();
    };
  }, [registries, listKey]);
  const doorKey = JSON.stringify(allActions);
  useEffect(() => {
    if (!door) return;
    const actions = JSON.parse(doorKey) as PagedAction[];
    const disposers = actions.flatMap((a) => {
      try {
        return [door.register(ACTIONS_DOOR_OWNER, definitionOf(a))];
      } catch {
        // An id another owner took first: that action is not on the door.
        return [];
      }
    });
    return () => {
      for (const d of disposers) d.dispose();
    };
  }, [door, doorKey]);

  // The preview's outlines go with the provider.
  useEffect(() => () => clearPreviewTargets(scope, "actions"), [scope]);

  return (
    <Context.Provider value={api}>
      {/* Always the same element, so a model arriving later re-provides
          rather than remounting the editor under it. */}
      <ObjectModelProvider host={tappedModel}>{children}</ObjectModelProvider>
    </Context.Provider>
  );
}

export function useActions(): ActionsApi {
  const ctx = useContext(Context);
  if (!ctx) throw new Error("useActions called outside ActionsProvider");
  return ctx;
}
