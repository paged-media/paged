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

// Operation feedback, per editor (editor ADR "Operation feedback"; the
// interaction specification's UXI-FBK-001/002/003 and UXI-ASY-009/010/011;
// task DF8 of interaction-plan.md). One service says how an operation
// ended, so a failure reads the same wherever it happened:
//
//   · the OUTCOME is one of the specification's taxonomy (§18.4): success,
//     canceled, blocked, unsupported, invalid-input, conflict (stale),
//     recoverable-failure, fatal-failure. A UI taxonomy, not the wire's.
//   · an error says the attempted action, the reason, whether the document
//     changed and the remedy (UXI-FBK-002): "Could not paste: the clipboard
//     holds nothing to paste. Nothing changed." with the remedy as a button.
//   · it goes to ONE place by its kind (UXI-FBK-001, UXI-ASY-010): inline
//     beside a local control (the caller shows the worded text), a brief
//     result to the one toast channel, an unresolved document issue to a
//     persistent Problems entry. A repeated failure with the same key
//     updates its toast (a count) instead of stacking another: a drag that
//     fails on every move makes one toast, not a storm.
//   · technical detail (an engine message, a correlation id) stays behind
//     "Details" (UXI-ASY-011); the toast's words never carry a stack.
//
// Pure store + one React hook; the toasts render in `chrome/FeedbackToasts`
// and the Problems panel lists `problems`. Extensions reach it through the
// contract's `host.notify` (extensions ADR "host.notify").

import { useSyncExternalStore } from "react";
import type { Notification } from "@paged-media/plugin-api";
import { defineMessages, t as translate } from "@paged-media/strings";

import { scoped, useEditorScope, type EditorScope } from "./editor-scope";

/** How an operation ended (UXI-ASY-009). */
export type OperationOutcome =
  | "success"
  | "canceled"
  | "blocked"
  | "unsupported"
  | "invalid-input"
  | "conflict"
  | "recoverable-failure"
  | "fatal-failure";

/** Every outcome, in the order of the taxonomy. */
export const OPERATION_OUTCOMES: readonly OperationOutcome[] = [
  "success",
  "canceled",
  "blocked",
  "unsupported",
  "invalid-input",
  "conflict",
  "recoverable-failure",
  "fatal-failure",
];

/** Whether the document changed (UXI-FBK-002): `unchanged` is a promise
 *  the caller makes ("Nothing changed."), `changed` says a part landed;
 *  `unknown` says nothing. */
export type DocumentChange = "unchanged" | "changed" | "unknown";

/** What the user can do next: a command the editor runs, or a callback. */
export interface FeedbackAction {
  label: string;
  /** A registered command id (a plugin's remedy is always a command). */
  command?: string;
  args?: unknown;
  run?: () => void;
}

/** Where a report goes (UXI-FBK-001). `auto` routes by the outcome. */
export type FeedbackChannel = "auto" | "inline" | "toast" | "problem";

/** One operation's end, as the operation reports it. */
export interface OperationReport {
  /** The attempted action, a short lowercase verb phrase in the editor's
   *  language ("paste", "move 2 objects", "open Annual.idml"). */
  action: string;
  outcome: OperationOutcome;
  /** Why, worded for the user ("their layer is locked"); no stack. */
  reason?: string;
  /** Whether the document changed; default `unknown`. */
  document?: DocumentChange;
  /** The next step (UXI-FBK-002), shown as the toast's button. */
  remedy?: FeedbackAction;
  /** Further actions ("View report"). */
  actions?: readonly FeedbackAction[];
  /** A headline that replaces the worded one (a success that names its
   *  result: "Exported Annual.pdf · 12 pages"). */
  title?: string;
  /** Technical detail behind "Details" (UXI-ASY-011). */
  detail?: string;
  /** For developers: a correlation id (a request seq, a handle). */
  correlationId?: string;
  /** Who reported it: an editor area ("paged.clipboard") or a plugin id. */
  source?: string;
  /** The repeat key: a report with the key of a live toast updates it
   *  (count + 1); a problem with the key replaces it; a success with the
   *  key resolves the problem. Default: source + action + outcome. */
  key?: string;
  channel?: FeedbackChannel;
  /** A success or cancel worth confirming (Save, Export, Import;
   *  UXI-FBK-003): it gets a toast. Continuous edits stay quiet. */
  prominent?: boolean;
  /** Keep a failure in Problems until it is resolved or dismissed (an
   *  unresolved document issue), besides its toast. */
  persistent?: boolean;
}

/** A report on the toast channel. */
export interface FeedbackToast {
  id: number;
  key: string;
  report: OperationReport;
  /** The worded headline and the change sentence. */
  text: WordedFeedback;
  /** How many times it was reported while shown. */
  count: number;
  /** When it goes (ms since the epoch); null: until closed. */
  expiresAt: number | null;
}

/** A persistent entry (the Problems panel's). */
export interface FeedbackProblem {
  key: string;
  report: OperationReport;
  text: WordedFeedback;
  at: number;
}

export interface WordedFeedback {
  /** "Could not paste: the clipboard holds nothing to paste." */
  headline: string;
  /** "Nothing changed." / "The document changed." / "" */
  change: string;
  /** Headline, change sentence and remedy in one line, for an inline
   *  message, a status line or a screen reader. */
  sentence: string;
}

/** Errors, warnings, notes: how a report ranks in Problems and how loudly
 *  the toast is announced. */
export type FeedbackSeverity = "error" | "warning" | "info";

export function severityOf(outcome: OperationOutcome): FeedbackSeverity {
  switch (outcome) {
    case "success":
    case "canceled":
      return "info";
    case "blocked":
    case "unsupported":
    case "invalid-input":
    case "conflict":
      return "warning";
    case "recoverable-failure":
    case "fatal-failure":
      return "error";
  }
}

/** Whether an outcome is a failure of any kind. */
export function isFailure(outcome: OperationOutcome): boolean {
  return outcome !== "success" && outcome !== "canceled";
}

const M = defineMessages("shell.feedback", {
  canceled: "{action} canceled.",
  blocked: "Could not {action}: {reason}.",
  blockedNoReason: "Could not {action}.",
  unsupported: "Cannot {action}: {reason}.",
  unsupportedNoReason: "Cannot {action} here.",
  invalid: "Could not {action}: {reason}.",
  conflict: "Could not {action}: the document changed meanwhile.",
  conflictReason: "Could not {action}: {reason}.",
  failed: "Could not {action}: {reason}.",
  failedNoReason: "Could not {action}.",
  fatal: "{action} failed: {reason}.",
  fatalNoReason: "{action} failed.",
  success: "{action}: done.",
  unchanged: "Nothing changed.",
  changed: "The document changed.",
  details: "Details",
  dismiss: "Dismiss",
  close: "Close",
  repeated: "{count}×",
  region: "Notifications",
});

/** The words of the toast's controls (the component reads them here, so
 *  the namespace stays this file's). */
export const FEEDBACK_STRINGS = M;

const capital = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
/** A reason worded as a sentence fragment: no trailing full stop (the
 *  template adds one). */
const fragment = (s: string) => s.trim().replace(/[.\s]+$/, "");

/** Word a report (UXI-FBK-002). `t` is the editor's translator. */
export function wordFeedback(
  report: OperationReport,
  t: (
    key: string,
    params?: Readonly<Record<string, string | number>>,
  ) => string = translate,
): WordedFeedback {
  const action = report.action;
  const reason = report.reason ? fragment(report.reason) : "";
  const p = { action, reason };
  let headline: string;
  if (report.title) headline = report.title;
  else
    switch (report.outcome) {
      case "success":
        headline = t(M.success, { action: capital(action) });
        break;
      case "canceled":
        headline = t(M.canceled, { action: capital(action) });
        break;
      case "blocked":
      case "invalid-input":
        headline = reason ? t(M.blocked, p) : t(M.blockedNoReason, p);
        break;
      case "unsupported":
        headline = reason ? t(M.unsupported, p) : t(M.unsupportedNoReason, p);
        break;
      case "conflict":
        headline = reason ? t(M.conflictReason, p) : t(M.conflict, p);
        break;
      case "recoverable-failure":
        headline = reason ? t(M.failed, p) : t(M.failedNoReason, p);
        break;
      case "fatal-failure":
        headline = reason
          ? t(M.fatal, { ...p, action: capital(action) })
          : t(M.fatalNoReason, { action: capital(action) });
        break;
    }
  const change =
    report.document === "unchanged"
      ? t(M.unchanged)
      : report.document === "changed"
        ? t(M.changed)
        : "";
  const remedy = report.remedy ? `${report.remedy.label}.` : "";
  const sentence = [headline, change, remedy].filter(Boolean).join(" ");
  return { headline, change, sentence };
}

/** Where `report` goes: the channels it reaches. */
export function routeOf(report: OperationReport): {
  toast: boolean;
  problem: boolean;
} {
  const channel = report.channel ?? "auto";
  if (channel === "inline") return { toast: false, problem: false };
  if (channel === "toast") return { toast: true, problem: !!report.persistent };
  if (channel === "problem")
    return { toast: !!report.prominent, problem: true };
  const failure = isFailure(report.outcome);
  return {
    toast: failure || !!report.prominent,
    problem:
      failure && (!!report.persistent || report.outcome === "fatal-failure"),
  };
}

/** How long a toast stays, by outcome (ms); null: until it is closed. */
export function toastLifetime(report: OperationReport): number | null {
  if (report.outcome === "fatal-failure") return null;
  if (report.actions?.length) return 12_000;
  return isFailure(report.outcome) ? 8_000 : 4_000;
}

/** Toasts shown at once; an older one leaves for a newer. */
export const MAX_TOASTS = 3;

export function keyOf(report: OperationReport): string {
  return (
    report.key ?? `${report.source ?? ""}|${report.action}|${report.outcome}`
  );
}

export interface FeedbackSnapshot {
  toasts: readonly FeedbackToast[];
  problems: readonly FeedbackProblem[];
  /** Every report, newest last, bounded (a test and a debug hook read it). */
  log: readonly OperationReport[];
}

/** One editor's feedback. */
export interface OperationFeedback {
  /** Report an operation's end; answers the worded text (an inline
   *  caller shows `sentence`). */
  report(report: OperationReport): WordedFeedback;
  /** Close a toast (its ✕, its action ran, its time ran out). */
  dismissToast(id: number): void;
  /** Take an entry out of Problems (resolved or dismissed). */
  resolve(key: string): void;
  snapshot(): FeedbackSnapshot;
  subscribe(listener: () => void): () => void;
  /** Runs a remedy or an action: the editor wires its command registry. */
  runAction(action: FeedbackAction): void;
  /** The editor's command runner (set once by the shell). */
  setCommandRunner(run: (command: string, args?: unknown) => void): void;
  /** The translator words are made with (the editor's locale). */
  setTranslator(
    t: (
      key: string,
      params?: Readonly<Record<string, string | number>>,
    ) => string,
  ): void;
}

const LOG_MAX = 50;

export function createOperationFeedback(
  now: () => number = Date.now,
): OperationFeedback {
  let toasts: FeedbackToast[] = [];
  let problems: FeedbackProblem[] = [];
  let log: OperationReport[] = [];
  let snap: FeedbackSnapshot = { toasts, problems, log };
  let nextId = 1;
  const listeners = new Set<() => void>();
  let runCommand: ((command: string, args?: unknown) => void) | null = null;
  let t: (
    key: string,
    params?: Readonly<Record<string, string | number>>,
  ) => string = translate;

  const emit = () => {
    snap = { toasts, problems, log };
    for (const l of [...listeners]) l();
  };

  return {
    report(report) {
      const text = wordFeedback(report, t);
      const key = keyOf(report);
      const at = now();
      log = [...log, report].slice(-LOG_MAX);
      const route = routeOf(report);
      if (route.toast) {
        const life = toastLifetime(report);
        const live = toasts.find((x) => x.key === key);
        if (live) {
          // UXI-ASY-010: the same failure again updates its toast.
          toasts = toasts.map((x) =>
            x === live
              ? {
                  ...x,
                  report,
                  text,
                  count: x.count + 1,
                  expiresAt: life === null ? null : at + life,
                }
              : x,
          );
        } else {
          toasts = [
            ...toasts,
            {
              id: nextId++,
              key,
              report,
              text,
              count: 1,
              expiresAt: life === null ? null : at + life,
            },
          ].slice(-MAX_TOASTS);
        }
      }
      if (route.problem) {
        problems = [
          ...problems.filter((p) => p.key !== key),
          { key, report, text, at },
        ];
      } else if (report.outcome === "success" && report.key) {
        // A success with the key of an open problem resolves it.
        problems = problems.filter((p) => p.key !== report.key);
      }
      emit();
      return text;
    },
    dismissToast(id) {
      const next = toasts.filter((x) => x.id !== id);
      if (next.length === toasts.length) return;
      toasts = next;
      emit();
    },
    resolve(key) {
      const next = problems.filter((p) => p.key !== key);
      if (next.length === problems.length) return;
      problems = next;
      emit();
    },
    snapshot: () => snap,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    runAction(action) {
      if (action.run) action.run();
      else if (action.command) runCommand?.(action.command, action.args);
    },
    setCommandRunner(run) {
      runCommand = run;
    },
    setTranslator(next) {
      t = next;
    },
  };
}

const FEEDBACK = scoped("operationFeedback", () => createOperationFeedback());

/** `scope`'s operation feedback (a command handler, a sink). */
export function operationFeedbackOf(scope: EditorScope): OperationFeedback {
  return scope.get(FEEDBACK);
}

/** Report through the feedback of the editor a command ran in (`paged`
 *  is the handler's first argument). */
export function reportOperation(
  paged: unknown,
  report: OperationReport,
): WordedFeedback {
  const scope = (paged as { scope?: EditorScope } | null | undefined)?.scope;
  return scope
    ? operationFeedbackOf(scope).report(report)
    : wordFeedback(report);
}

/** This editor's feedback service. */
export function useOperationFeedback(): OperationFeedback {
  return operationFeedbackOf(useEditorScope());
}

/** This editor's toasts and problems, re-read when they change. */
export function useFeedbackSnapshot(): FeedbackSnapshot {
  const feedback = useOperationFeedback();
  return useSyncExternalStore(
    feedback.subscribe,
    feedback.snapshot,
    feedback.snapshot,
  );
}

/** A bundle's `host.notify` as a report of this editor's feedback
 *  (extensions ADR 1107): the bundle's id is the source, its key is
 *  namespaced under it, and a remedy is the bundle's own command. */
export function reportFromNotification(
  bundleId: string,
  n: Notification,
): OperationReport {
  return {
    action: n.action,
    outcome: n.outcome,
    ...(n.reason !== undefined ? { reason: n.reason } : {}),
    document:
      n.documentChanged === undefined
        ? "unknown"
        : n.documentChanged
          ? "changed"
          : "unchanged",
    ...(n.remedy
      ? {
          remedy: {
            label: n.remedy.label,
            command: n.remedy.command,
            args: n.remedy.args,
          },
        }
      : {}),
    ...(n.title !== undefined ? { title: n.title } : {}),
    ...(n.detail !== undefined ? { detail: n.detail } : {}),
    ...(n.key !== undefined ? { key: `${bundleId}|${n.key}` } : {}),
    ...(n.prominent ? { prominent: true } : {}),
    ...(n.persistent ? { persistent: true } : {}),
    source: bundleId,
  };
}

/** The `NotifySink` the editor hands its bundle hosts. */
export function notifySinkOf(scope: EditorScope): {
  notify(bundleId: string, notification: Notification): void;
} {
  return {
    notify(bundleId, notification) {
      operationFeedbackOf(scope).report(
        reportFromNotification(bundleId, notification),
      );
    },
  };
}
