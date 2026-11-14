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

// Editor ADR 1241 — the assistant's Inspect → Propose → Preview → Approve
// → Apply, one store per editor (plan task E1).
//
//   consent      a request for Claude waits here: the panel says what will
//                leave the device (the request, which objects, which kinds
//                of values, to whom) and nothing is sent until the user
//                sends it — every request asks again;
//   inspecting   the deterministic checks, or Claude reading through the
//                object model (read-only: the proposal tools write nothing);
//   proposed     the change set, previewed: each item with its object, the
//                value before and after and why, outlined on the canvas;
//                the document and its history are as they were;
//   applied      Approve wrote the accepted items as ONE undo step through
//                the object model; Undo takes exactly that step back.

import { runProposalAgent, type ProposedChangeInput } from "@paged-media/ai";

import { scoped, type EditorScope } from "../state/editor-scope";
import {
  clearPreviewTargets,
  showPreviewTargets,
} from "../state/preview-targets";
import {
  applicableItems,
  applyChangeSet,
  type ApplyDoors,
  type ChangeItem,
  type ChangeSet,
} from "./change-set";
import {
  plain,
  runChecks,
  type CheckId,
  type CheckParams,
  type CheckScope,
  type CheckWords,
  type InspectDoors,
} from "./checks";
import { describeAiError, editorAiTransport, loadAiCatalog } from "./editor-ai";

/** What a request to Claude sends, as the consent card states it. */
export interface ClaudeRequest {
  kind: "ask" | "brief";
  text: string;
  /** `selection`: Claude reads and changes only the selected objects. */
  scope: "selection" | "document";
  /** Claude may read the text the objects hold (off: sizes, colours and
   *  styles only). */
  allowText: boolean;
  /** The selected objects' addresses when the request was made. */
  selection: readonly string[];
}

export type ProposalState =
  | { phase: "idle" }
  | { phase: "consent"; request: ClaudeRequest }
  | {
      phase: "inspecting";
      source: "checks" | "claude";
      reads: number;
      controller: AbortController;
    }
  | {
      phase: "proposed";
      set: ChangeSet;
      accepted: readonly string[];
      /** Changes Claude proposed outside what the user allowed, left out. */
      dropped: number;
    }
  | {
      phase: "applied";
      set: ChangeSet;
      applied: number;
      undoSteps: number;
      lastSeq: number | null;
    }
  | { phase: "error"; message: string };

const OWNER = "assistant";

/** The doors a Claude proposal reads through and answers in. */
export interface ClaudeDoors extends InspectDoors {
  /** Every address `selector` names (rejects on a bad selector). */
  query(selector: string, limit: number): Promise<string[]>;
}

/** The words the store needs in the caller's locale. */
export interface ProposalWords extends CheckWords {
  checksTitle: string;
  claudeTitle: string;
  claudeEmpty: string;
  outsideScope: string;
  textWithheld: string;
  declined: string;
  noProposal: string;
}

function createProposalSession(scope: EditorScope) {
  let state: ProposalState = { phase: "idle" };
  const listeners = new Set<() => void>();
  const set = (next: ProposalState) => {
    state = next;
    for (const l of [...listeners]) l();
    // The canvas outlines what the proposal touches, the item pointed at
    // stronger; nothing else draws for it.
    if (next.phase === "proposed")
      showPreviewTargets(scope, OWNER, [
        ...new Set(next.set.items.map((i) => i.address)),
      ]);
    else clearPreviewTargets(scope, OWNER);
  };

  const propose = (set: ChangeSet, dropped = 0): ProposalState => ({
    phase: "proposed",
    set,
    accepted: set.items.filter((i) => !i.needsValue).map((i) => i.id),
    dropped,
  });

  return {
    getProposalState: () => state,
    subscribeProposal(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** A request for Claude waits for the user's consent. */
    requestConsent(request: ClaudeRequest) {
      set({ phase: "consent", request });
    },
    /** Change what the waiting request may send. */
    setConsent(patch: Partial<Pick<ClaudeRequest, "scope" | "allowText">>) {
      if (state.phase !== "consent") return;
      set({ phase: "consent", request: { ...state.request, ...patch } });
    },
    declineConsent() {
      if (state.phase === "consent") set({ phase: "idle" });
    },

    /** Run the deterministic checks: a proposal, made on this device. */
    async startChecks(
      ids: readonly CheckId[],
      params: CheckParams,
      checkScope: CheckScope,
      doors: InspectDoors,
      words: ProposalWords,
    ) {
      const controller = new AbortController();
      set({ phase: "inspecting", source: "checks", reads: 0, controller });
      try {
        const items = await runChecks(ids, doors, checkScope, params, words);
        if (state.phase !== "inspecting" || state.controller !== controller)
          return;
        set(
          propose({
            id: `set_${Date.now().toString(36)}`,
            source: "checks",
            title: words.checksTitle,
            summary: "",
            items,
          }),
        );
      } catch (err) {
        set({ phase: "error", message: String(err) });
      }
    },

    /** The user consented: Claude reads (read-only) and proposes. */
    async grantConsent(
      doors: ClaudeDoors,
      words: ProposalWords,
      context: string,
    ) {
      if (state.phase !== "consent") return;
      const request = state.request;
      const controller = new AbortController();
      set({ phase: "inspecting", source: "claude", reads: 0, controller });
      // What Claude may read: the selection's objects (and their text
      // ranges) in selection scope, anything otherwise; text only when
      // allowed.
      const TEXT_PATHS = new Set(["text", "content"]);
      try {
        // In selection scope, the selected objects and the stories that
        // flow through the selected text frames.
        const stories = new Set<string>();
        if (request.scope === "selection") {
          const frames = new Set(request.selection);
          for (const a of await doors.query("story", 500).catch(() => [])) {
            const id = /^story:(.+)$/.exec(a)?.[1] ?? a;
            const through = await doors.framesOf(id).catch(() => []);
            if (through.some((f) => frames.has(f))) stories.add(id);
          }
        }
        const allowed = (address: string) => {
          if (request.scope === "document") return true;
          if (request.selection.includes(address)) return true;
          const story = /^(?:storyRange|story):([^@]+)/.exec(address)?.[1];
          return story !== undefined && stories.has(story);
        };
        const result = await runProposalAgent({
          transport: editorAiTransport(),
          catalog: await loadAiCatalog(),
          signal: controller.signal,
          prompt: `${context}\n\nRequest: ${request.text}`,
          onEvent: (e) => {
            if (e.type === "read" && state.phase === "inspecting")
              set({ ...state, reads: state.reads + 1 });
          },
          reader: {
            async read(selector, paths, limit) {
              let addresses: string[];
              try {
                addresses = await doors.query(selector, limit);
              } catch (err) {
                return { refused: String(err) };
              }
              const inScope = addresses.filter(allowed).slice(0, limit);
              if (addresses.length > 0 && inScope.length === 0)
                return { refused: words.outsideScope };
              const objects: Array<{
                address: string;
                values: Record<string, unknown>;
              }> = [];
              for (const address of inScope) {
                const values: Record<string, unknown> = {};
                for (const path of paths) {
                  values[path] =
                    TEXT_PATHS.has(path) && !request.allowText
                      ? words.textWithheld
                      : plain(await doors.objects.get(address, path));
                }
                objects.push({ address, values });
              }
              return { objects };
            },
          },
        });
        // The user may have stopped it meanwhile.
        const now = state as ProposalState;
        if (now.phase !== "inspecting" || now.controller !== controller) return;
        if (result.outcome === "refused") {
          set({ phase: "error", message: words.declined });
          return;
        }
        if (result.outcome !== "proposed") {
          set({ phase: "error", message: words.noProposal });
          return;
        }
        const kept = result.changes.filter((c) => allowed(c.address));
        const items = await itemsOfClaude(kept, doors);
        set(
          propose(
            {
              id: `set_${Date.now().toString(36)}`,
              source: "claude",
              title: words.claudeTitle,
              summary: result.summary || words.claudeEmpty,
              items,
            },
            result.changes.length - kept.length,
          ),
        );
      } catch (err) {
        set({ phase: "error", message: describeAiError(err) });
      }
    },

    stop() {
      if (state.phase === "inspecting") {
        state.controller.abort();
        set({ phase: "idle" });
      }
    },

    toggleItem(id: string) {
      if (state.phase !== "proposed") return;
      const on = state.accepted.includes(id);
      set({
        ...state,
        accepted: on
          ? state.accepted.filter((a) => a !== id)
          : [...state.accepted, id],
      });
    },
    /** The value of an item the user supplies (alternative text). */
    setItemValue(id: string, value: string) {
      if (state.phase !== "proposed") return;
      const items = state.set.items.map((i) =>
        i.id === id ? { ...i, after: value } : i,
      );
      const accepted =
        value.trim() && !state.accepted.includes(id)
          ? [...state.accepted, id]
          : state.accepted;
      set({ ...state, set: { ...state.set, items }, accepted });
    },
    /** Point at one item: its object is outlined stronger. */
    focusItem(address: string | null) {
      if (state.phase !== "proposed") return;
      showPreviewTargets(
        scope,
        OWNER,
        [...new Set(state.set.items.map((i) => i.address))],
        address,
      );
    },

    /** Approve: write the accepted items as ONE undo step. */
    async approve(doors: ApplyDoors, label: string) {
      if (state.phase !== "proposed") return;
      const proposal = state.set;
      const items = applicableItems(proposal, new Set(state.accepted));
      const result = await applyChangeSet(items, doors, label);
      if (result.refused) {
        set({ phase: "error", message: result.refused });
        return;
      }
      set({
        phase: "applied",
        set: proposal,
        applied: result.applied,
        undoSteps: result.undoSteps,
        lastSeq: result.lastSeq,
      });
    },

    /** Undo the approval's step, only while it is still the newest. */
    async undoApplied(
      client: {
        undoLog(
          limit?: number,
        ): Promise<{ undo: Array<{ appliedSeq: number }> }>;
        undoTo(seq: number): Promise<{ kind: string }>;
      },
      notUndone: string,
    ) {
      if (state.phase !== "applied" || state.lastSeq === null) return;
      const log = await client.undoLog(1);
      const top = log.undo[log.undo.length - 1];
      if (top?.appliedSeq !== state.lastSeq) {
        set({ phase: "error", message: notUndone });
        return;
      }
      await client.undoTo(state.lastSeq);
      set({ phase: "idle" });
    },

    dismiss() {
      if (state.phase === "inspecting") state.controller.abort();
      set({ phase: "idle" });
    },
  };
}

/** Claude's changes as preview items: the value before, read here. */
async function itemsOfClaude(
  changes: readonly ProposedChangeInput[],
  doors: InspectDoors,
): Promise<ChangeItem[]> {
  const items: ChangeItem[] = [];
  for (const [i, c] of changes.entries()) {
    items.push({
      id: `claude_${i}`,
      address: c.address,
      path: c.path,
      subject: c.address,
      before: plain(await doors.objects.get(c.address, c.path)),
      after: c.value,
      reason: c.reason,
      rule: "claude",
    });
  }
  return items;
}

export type ProposalSession = ReturnType<typeof createProposalSession>;

const SESSION = scoped("assistantProposals", (scope) =>
  createProposalSession(scope),
);

/** `scope`'s proposal session. */
export function proposalSession(scope: EditorScope): ProposalSession {
  return scope.get(SESSION);
}
