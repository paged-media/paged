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
  type PropsWithChildren,
} from "react";

import { useCanvasClient } from "../state/canvas-client-context";
import { useRegistries } from "../state/registries-context";
import {
  EMPTY_TALLY,
  isRecordable,
  newActionId,
  stepFromInvocation,
  ACTIONS_SCHEMA_VERSION,
  type ActionLibrary,
  type ActionStep,
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
}

const Context = createContext<ActionsApi | null>(null);

/** The player's door to the editor: the registry runs the steps, and the
 *  client — when it is the real `CanvasClient` — groups their writes into
 *  one undo step. A client without the group (a test stub) leaves every
 *  write its own step, and the report says the count is unknown. */
export function playerDeps(
  commands: { invoke(id: string, payload?: unknown): Promise<unknown> },
  client: unknown,
): PlayerDeps {
  const c = client as Partial<{
    beginUndoGroup(o: { continueSeq?: number | null }): void;
    endUndoGroup(): Promise<{
      steps: number;
      writes: number;
      lastSeq: number | null;
    } | null>;
  }>;
  const grouped =
    typeof c?.beginUndoGroup === "function" &&
    typeof c?.endUndoGroup === "function";
  return {
    invoke: (id, payload) => commands.invoke(id, payload),
    ...(grouped
      ? {
          beginUndoGroup: (o) => c.beginUndoGroup!(o),
          endUndoGroup: () => c.endUndoGroup!(),
        }
      : {}),
  };
}

function reportOf(
  action: PagedAction,
  state: PlayerState,
  mutations: number,
): ReplayReport {
  return {
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
  // eslint-disable-next-line no-restricted-syntax -- keeps an effect dependency stable (ADR 229)
  const patch = useCallback(
    (actionId: string, fn: (action: PagedAction) => PagedAction) => {
      commit({
        ...library,
        schema: ACTIONS_SCHEMA_VERSION,
        actions: library.actions.map((a) => (a.id === actionId ? fn(a) : a)),
      });
    },
    [library, commit],
  );

  // ── the command tap ────────────────────────────────────────────
  useEffect(() => {
    const off = registries.commands.observe((event) => {
      const { phase, invocation } = event;
      if (phase === "started") {
        inFlight.current += 1;
        if (!recordingRef.current) return;
        if (!isRecordable(invocation.id)) return;
        const step = stepFromInvocation(invocation);
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

  // eslint-disable-next-line no-restricted-syntax -- keeps an effect dependency stable (ADR 229)
  const startRecording = useCallback(() => {
    setLastReport(null);
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
      const report = reportOf(player.action, state, replayMutations.current);
      setLastReport(report);
      return report;
    },
    [],
  );

  // eslint-disable-next-line no-restricted-syntax -- keeps an effect dependency stable (ADR 229)
  const play = useCallback(
    async (
      actionId: string,
      options: PlayOptions = {},
    ): Promise<ReplayReport | null> => {
      const action = library.actions.find((a) => a.id === actionId);
      if (!action || playingId || playerRef.current) return null;
      const player = new ActionPlayer(
        action,
        playerDeps(registries.commands, client),
        { stepByStep: options.stepByStep === true },
      );
      playerRef.current = player;
      setPlayingId(actionId);
      setLastReport(null);
      replayMutations.current = 0;
      return drive(player, (p) => p.start());
    },
    [library, playingId, registries, client, drive],
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

  // eslint-disable-next-line no-restricted-syntax -- its type argument types the value (ADR 229)
  const api = useMemo<ActionsApi>(
    () => ({
      actions: library.actions,
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
      remove: (id) =>
        commit({
          ...library,
          schema: ACTIONS_SCHEMA_VERSION,
          actions: library.actions.filter((a) => a.id !== id),
          // A rule naming a deleted action names nothing.
          importRules: (library.importRules ?? []).filter(
            (r) => r.actionId !== id,
          ),
        }),
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
    }),
    [
      library,
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

  return <Context.Provider value={api}>{children}</Context.Provider>;
}

export function useActions(): ActionsApi {
  const ctx = useContext(Context);
  if (!ctx) throw new Error("useActions called outside ActionsProvider");
  return ctx;
}
