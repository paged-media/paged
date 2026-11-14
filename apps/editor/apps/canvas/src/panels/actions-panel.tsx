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

// Actions — record a sequence of commands, replay it against the
// current selection.
//
// The panel is a VIEW. Everything it drives lives in the shell's
// `ActionsProvider` (`packages/shell/src/actions/`), which is mounted
// above the dock precisely so recording survives this panel being
// unmounted when the user switches right-dock tabs.
//
// The scope note at the bottom of the panel is not decoration. A
// recorder tapped on the command registry cannot see gestures or typing,
// and an action that quietly omitted them would replay to a different
// document than the user recorded. So the panel states the limit
// permanently AND reports, per recording, how many uncapturable edits
// actually happened while it was running.
//
// Editor ADR 1240: a panel field's commit IS recorded now (a property step
// on the selection), and the panel previews a run before it happens — what
// it acts on, outlined on the canvas, what refuses it and how it undoes —
// keeps parameters, an action's place (this editor or the document) and its
// `paged.*` script.

import { Fragment, useRef, useState, type CSSProperties } from "react";

import { ActionParams, ActionPreview, StepValues } from "./actions-preview";

import {
  CockpitPanelHeader,
  CockpitBtn,
  StatusPill,
  isStopStep,
  newActionId,
  parseExtensions,
  planReplay,
  useRegistries,
  serializeForExport,
  skipReasonLabel,
  toDemoScript,
  useActions,
  verdictLabel,
  verdictTitle,
  type ImportRule,
  type PagedAction,
  type PlaybackState,
} from "@paged-media/shell";
import { defineMessages, useStrings } from "@paged-media/strings";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PanelProps = any;

const MUTED = { color: "var(--pg-muted-fg)", fontFamily: "var(--font-sans)" };

const M = defineMessages("app.actionsPanel", {
  notGestures: "canvas gestures — move, resize, rotate, pen and shape drawing",
  notTyping: "typing in a text frame",
  notSelection: "selection clicks, marquee and camera moves",
  notUndoKeys:
    "the Cmd-Z / Cmd-Shift-Z keystrokes (Edit ▸ Undo from the menu IS recorded)",
  nothingRecorded:
    "Nothing recorded — no command ran. Direct manipulation (drag, typing, " +
    "panel fields) is not recordable; see the scope note below.",
  nothingImported:
    "Nothing imported — the file held no actions this build understands.",
  imported: "Imported {count, plural, one {# action} other {# actions}}.",
  title: "Actions",
  recording: "Recording",
  saved: "{count} saved",
  // Beside the count, which the panel shows in its own element.
  capturedOne: "command captured",
  capturedOther: "commands captured",
  namePlaceholder: "Name this action",
  stop: "Stop",
  discard: "Discard",
  record: "Record",
  import: "Import…",
  exportAll: "Export all",
  storageRefused:
    "Browser storage refused the last write — actions exist for this " +
    "session only. Export to keep them.",
  empty:
    "No actions yet. Press Record, run some commands from the menu, " +
    "palette or a panel, then press Stop.",
  replayed: "Replayed “{name}”",
  failed: " — failed: {error}",
  skipped: "skipped",
  noMutations:
    "No document mutations — this replay changed only the view or the UI.",
  mutations:
    "{count, plural, one {# document mutation} other {# document mutations}} " +
    "applied. A replay is not one undoable unit — undo that many times to " +
    "reverse it.",
  oneUndo:
    "{count, plural, one {# document mutation} other {# document mutations}} " +
    "applied as one undo step — one Undo reverses the replay.",
  severalUndo:
    "{count, plural, one {# document mutation} other {# document mutations}} " +
    "applied in {steps} undo steps: something made its own step in between " +
    "(an edit during a pause, a canvas gesture or a script).",
  cancelledReplay: "Cancelled — the steps that ran stay done.",
  step: "Step",
  stepTitle: "Play one step at a time",
  continue: "Continue",
  cancel: "Cancel",
  pausedAt: "Paused before step {n}.",
  stoppedAt: "Stopped: {message}",
  stopEnd: "Stopped: {message} (the last step)",
  pauseBefore: "Pause before step {n}",
  insertStop: "Insert stop",
  stopMessage: "Message for the stop",
  stopDefault: "Check the result, then Continue.",
  stopStep: "Stop",
  runOnImport: "Run on import",
  runOnImportNote:
    "After a file is opened or imported, play this action over it. " +
    "Extensions (idml, xlsx, png …); empty runs it for every file.",
  extensions: "Extensions",
  batch: "Batch…",
  dismiss: "Dismiss",
  contains: "What a recording contains",
  recordsBefore: "Actions record",
  commands: "commands",
  recordsAfter:
    " — anything reachable from a menu, a keybinding, the command palette, " +
    "the tool rail, a panel button or a plugin. Steps with no payload " +
    "replay against whatever is selected at replay time.",
  notRecorded: "Not recorded:",
  notCaptured:
    "Not captured: {gestures, plural, one {# canvas gesture} other {# canvas gestures}} " +
    "and {edits, plural, one {# direct edit} other {# direct edits}} " +
    "(typing / panel fields) changed the document while recording. They " +
    "cannot be replayed.",
  playing: "Playing…",
  play: "Play",
  willSkip: "{count, plural, one {# step} other {# steps}} will be skipped",
  stepEnabled: "Step {n} enabled",
  failedWhileRecording: " — failed while recording",
  deleteStep: "Delete step {n}",
  includeDocBound:
    "Replay steps that carry ids from the recorded document. Off by " +
    "default — those ids do not exist in another document.",
  copied: "Copied",
  copyAsScript: "Copy as script",
  export: "Export…",
  delete: "Delete",
  copyNoteBefore: "“Copy as script” emits the same steps as",
  copyNoteAfter: "calls for the demo/automation runner.",
  // Editor ADR 1240.
  preview: "Preview",
  previewTitle: "Show what this action will do here, before it runs",
  fieldsRecorded:
    " Panel fields (a font size, a style, a colour) are recorded as a step on the selection.",
  scopeUser: "This editor",
  scopeDocument: "This document",
  scopeLabel: "Keep in",
  scopeNoDocument: "Open a document to keep actions in it.",
  values: "Values",
  valuesOf: "Values of step {n}",
  pagedScript: "paged.* script",
  copyPagedScript: "Copy paged.* script",
  hideScript: "Hide script",
  refusedReplay: "“{name}” did not run",
  rolledBack: "Its writes were undone: nothing changed.",
  notRolledBack: "What ran before it stays done.",
});

/** The permanent scope statement. Worded as facts about the tap, not
 *  as an apology — the user needs to be able to predict what an
 *  action will contain before they record it. */
const NOT_RECORDED = [
  M.notGestures,
  M.notTyping,
  M.notSelection,
  M.notUndoKeys,
];

function download(name: string, body: string) {
  const url = URL.createObjectURL(
    new Blob([body], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function ActionsPanel(_: PanelProps) {
  const strings = useStrings();
  const actions = useActions();
  const [name, setName] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const recording = actions.recording;
  const open = actions.actions.find((a) => a.id === openId) ?? null;

  const stop = () => {
    const created = actions.stopRecording(name);
    setName("");
    if (!created) {
      setNotice(strings.t(M.nothingRecorded));
      return;
    }
    setNotice(null);
    setOpenId(created.id);
  };

  const onImport = async (file: File | undefined) => {
    if (!file) return;
    const accepted = actions.importActions(await file.text());
    setNotice(
      accepted === 0
        ? strings.t(M.nothingImported)
        : strings.t(M.imported, { count: accepted }),
    );
  };

  return (
    <div
      data-actions-panel="ready"
      style={{
        height: "100%",
        overflowY: "auto",
        fontFamily: "var(--font-sans)",
      }}
    >
      <CockpitPanelHeader
        title={strings.t(M.title)}
        action={
          recording ? (
            <StatusPill tone="error" testId="actions-recording">
              {strings.t(M.recording)}
            </StatusPill>
          ) : (
            <StatusPill tone="draft">
              {strings.t(M.saved, { count: actions.actions.length })}
            </StatusPill>
          )
        }
      />

      {/* ── record / stop ─────────────────────────────────────── */}
      <div style={{ padding: "0 14px 12px" }}>
        {recording ? (
          <div
            data-actions-recording
            style={{
              border: "1px solid var(--status-error)",
              borderRadius: "var(--radius-lg)",
              padding: 10,
            }}
          >
            <div style={{ fontSize: 12, marginBottom: 8 }}>
              <span data-actions-step-count>{recording.steps.length}</span>{" "}
              {strings.t(
                recording.steps.length === 1 ? M.capturedOne : M.capturedOther,
              )}
            </div>
            <UncapturedLine
              gestures={recording.uncaptured.gestures}
              directEdits={recording.uncaptured.directEdits}
            />
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={strings.t(M.namePlaceholder)}
              data-actions-name
              style={inputStyle}
            />
            <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
              <CockpitBtn primary sm onClick={stop} testId="actions-stop">
                {strings.t(M.stop)}
              </CockpitBtn>
              <CockpitBtn sm onClick={actions.cancelRecording}>
                {strings.t(M.discard)}
              </CockpitBtn>
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <CockpitBtn
              primary
              sm
              onClick={actions.startRecording}
              testId="actions-record"
            >
              {strings.t(M.record)}
            </CockpitBtn>
            <CockpitBtn sm onClick={() => fileRef.current?.click()}>
              {strings.t(M.import)}
            </CockpitBtn>
            <CockpitBtn
              sm
              disabled={actions.actions.length === 0}
              onClick={() =>
                download(
                  "paged-actions.json",
                  serializeForExport(actions.actions),
                )
              }
            >
              {strings.t(M.exportAll)}
            </CockpitBtn>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              hidden
              style={{ display: "none" }}
              onChange={(e) => {
                void onImport(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </div>
        )}
        {!actions.persisted && (
          <div
            style={{
              ...MUTED,
              fontSize: 11,
              marginTop: 8,
              color: "var(--status-error)",
            }}
          >
            {strings.t(M.storageRefused)}
          </div>
        )}
        {notice && (
          <div
            data-actions-notice
            style={{ ...MUTED, fontSize: 11, marginTop: 8 }}
          >
            {notice}
          </div>
        )}
      </div>

      {/* ── the list ──────────────────────────────────────────── */}
      <div style={{ padding: "0 14px 12px" }}>
        {actions.actions.length === 0 && !recording && (
          <div style={{ ...MUTED, fontSize: 12 }}>{strings.t(M.empty)}</div>
        )}
        {actions.actions.map((action) => (
          <ActionRow
            key={action.id}
            action={action}
            expanded={action.id === openId}
            playing={actions.playingId === action.id}
            busy={actions.playingId != null || recording != null}
            onToggle={() =>
              setOpenId((prev) => (prev === action.id ? null : action.id))
            }
            onPlay={() => void actions.play(action.id)}
            onStep={() => void actions.play(action.id, { stepByStep: true })}
            onPreview={() => void actions.preview(action.id)}
          />
        ))}
      </div>

      {/* ── editor ADR 1240: what a run will do here ──────────── */}
      {actions.previewPlan && (
        <ActionPreview
          plan={actions.previewPlan}
          busy={actions.playingId != null || recording != null}
          onRun={() =>
            void actions.play(actions.previewPlan!.actionId, {
              confirmed: true,
            })
          }
          onClose={actions.clearPreview}
        />
      )}

      {/* ── a replay waiting at a breakpoint, a stop or a step ── */}
      {actions.playback && (
        <PlaybackBar
          playback={actions.playback}
          stepCount={
            actions.actions.find((a) => a.id === actions.playback?.actionId)
              ?.steps.length ?? 0
          }
          onContinue={() => void actions.resume()}
          onStep={() => void actions.stepOnce()}
          onCancel={actions.cancelPlayback}
        />
      )}

      {/* ── detail for the expanded action ────────────────────── */}
      {open && (
        <ActionDetail
          key={open.id}
          action={open}
          onRename={(next) => actions.rename(open.id, next)}
          onRemove={() => {
            actions.remove(open.id);
            setOpenId(null);
          }}
          onToggleStep={(i) => actions.toggleStep(open.id, i)}
          onTogglePause={(i) => actions.togglePause(open.id, i)}
          onInsertStop={(i, message) => actions.insertStop(open.id, i, message)}
          rule={actions.importRules.find((r) => r.actionId === open.id) ?? null}
          onRule={(rule) =>
            actions.setImportRules([
              ...actions.importRules.filter((r) => r.actionId !== open.id),
              ...(rule ? [rule] : []),
            ])
          }
          onDeleteStep={(i) => actions.deleteStep(open.id, i)}
          onIncludeDocumentBound={(v) =>
            actions.setIncludeDocumentBound(open.id, v)
          }
          onExport={() =>
            download(
              `${open.name.replace(/[^\w-]+/g, "-").toLowerCase()}.paged-action.json`,
              serializeForExport([open]),
            )
          }
        />
      )}

      {/* ── replay report ─────────────────────────────────────── */}
      {actions.lastReport && (
        <div data-actions-report style={{ padding: "0 14px 12px" }}>
          <Divider />
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
            {actions.lastReport.refusals.length > 0
              ? strings.t(M.refusedReplay, {
                  name: actions.lastReport.actionName,
                })
              : strings.t(M.replayed, { name: actions.lastReport.actionName })}
          </div>
          {actions.lastReport.refusals.map((r, i) => (
            <div
              key={`refusal-${i}`}
              role="alert"
              data-actions-report-refusal
              style={{
                fontSize: 11,
                marginBottom: 3,
                color: "var(--status-error)",
              }}
            >
              {r.reason}
            </div>
          ))}
          {actions.lastReport.refusals.length > 0 &&
            actions.lastReport.ran.length > 0 && (
              <div
                data-actions-rolled-back={
                  actions.lastReport.rolledBack ? "" : undefined
                }
                style={{ ...MUTED, fontSize: 11 }}
              >
                {actions.lastReport.rolledBack
                  ? strings.t(M.rolledBack)
                  : strings.t(M.notRolledBack)}
              </div>
            )}
          {actions.lastReport.ran.map((r) => (
            <div
              key={r.index}
              data-actions-report-step
              style={{
                fontSize: 11,
                marginBottom: 3,
                color: r.error ? "var(--status-error)" : "var(--pg-fg)",
              }}
            >
              {r.index + 1}. {r.title}
              {r.error ? strings.t(M.failed, { error: r.error }) : ""}
            </div>
          ))}
          {actions.lastReport.skipped.map((s) => (
            <div
              key={s.index}
              style={{ ...MUTED, fontSize: 11, marginBottom: 3 }}
            >
              {s.index + 1}. {s.title} — {strings.t(M.skipped)} (
              {skipReasonLabel(s.reason)})
            </div>
          ))}
          {/* The undo statement, from what the replay BECAME (WP4.11):
              the player groups a replay's writes into one undo step
              (the client's undo group over the engine's amend, ADR 1004)
              and says so; when something broke the chain it says how
              many steps it took; without a group (an old client) it
              keeps the honest per-mutation count. */}
          <div
            data-actions-undo
            style={{ ...MUTED, fontSize: 11, marginTop: 6 }}
          >
            {actions.lastReport.cancelled && (
              <div>{strings.t(M.cancelledReplay)}</div>
            )}
            {actions.lastReport.mutations === 0
              ? strings.t(M.noMutations)
              : actions.lastReport.undoSteps === 1
                ? strings.t(M.oneUndo, { count: actions.lastReport.mutations })
                : actions.lastReport.undoSteps > 1
                  ? strings.t(M.severalUndo, {
                      count: actions.lastReport.mutations,
                      steps: actions.lastReport.undoSteps,
                    })
                  : strings.t(M.mutations, {
                      count: actions.lastReport.mutations,
                    })}
          </div>
          <div style={{ marginTop: 8 }}>
            <CockpitBtn sm onClick={actions.dismissReport}>
              {strings.t(M.dismiss)}
            </CockpitBtn>
          </div>
        </div>
      )}

      {/* ── the permanent scope note ──────────────────────────── */}
      <div style={{ padding: "0 14px 16px" }}>
        <Divider />
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
          {strings.t(M.contains)}
        </div>
        <div style={{ ...MUTED, fontSize: 11, lineHeight: 1.55 }}>
          {strings.t(M.recordsBefore)} <strong>{strings.t(M.commands)}</strong>
          {strings.t(M.recordsAfter)}
          {strings.t(M.fieldsRecorded)}
          <div style={{ marginTop: 6 }}>{strings.t(M.notRecorded)}</div>
          <ul style={{ margin: "3px 0 0", paddingLeft: 16, listStyle: "disc" }}>
            {NOT_RECORDED.map((line) => (
              <li key={line} style={{ marginBottom: 2 }}>
                {strings.t(line)}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────── pieces

const inputStyle: CSSProperties = {
  width: "100%",
  marginTop: 8,
  height: 28,
  padding: "0 8px",
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--pg-border)",
  background: "transparent",
  color: "var(--pg-fg)",
  fontFamily: "var(--font-sans)",
  fontSize: 12,
};

function Divider() {
  return (
    <div
      style={{
        height: 1,
        background: "var(--pg-border)",
        margin: "0 0 10px",
      }}
    />
  );
}

function UncapturedLine({
  gestures,
  directEdits,
}: {
  gestures: number;
  directEdits: number;
}) {
  const strings = useStrings();
  if (gestures === 0 && directEdits === 0) return null;
  return (
    <div
      data-actions-uncaptured
      style={{
        fontSize: 11,
        color: "var(--status-review)",
        marginBottom: 6,
        lineHeight: 1.5,
      }}
    >
      {strings.t(M.notCaptured, { gestures, edits: directEdits })}
    </div>
  );
}

function ActionRow({
  action,
  expanded,
  playing,
  busy,
  onToggle,
  onPlay,
  onStep,
  onPreview,
}: {
  action: PagedAction;
  expanded: boolean;
  playing: boolean;
  busy: boolean;
  onToggle: () => void;
  onPlay: () => void;
  onStep: () => void;
  onPreview: () => void;
}) {
  const strings = useStrings();
  const plan = planReplay(action);
  return (
    <div
      data-actions-row={action.id}
      style={{
        border: "1px solid var(--pg-border)",
        borderRadius: "var(--radius-md)",
        padding: "7px 9px",
        marginBottom: 6,
        background: expanded ? "var(--pg-muted)" : "transparent",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button
          type="button"
          onClick={onToggle}
          data-actions-open
          style={{
            flex: 1,
            textAlign: "left",
            background: "none",
            border: "none",
            padding: 0,
            color: "var(--pg-fg)",
            fontFamily: "var(--font-sans)",
            fontSize: 12,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          {action.name}
        </button>
        <span
          data-actions-scope={action.scope ?? "user"}
          style={{ ...MUTED, fontSize: 10 }}
        >
          {action.scope === "document"
            ? strings.t(M.scopeDocument)
            : strings.t(M.scopeUser)}
        </span>
        <span className="pg-value" style={{ fontSize: 11 }}>
          {plan.run.length}/{action.steps.length}
        </span>
        <CockpitBtn
          sm
          disabled={busy || plan.run.length === 0}
          onClick={onPreview}
          testId={`actions-preview-${action.id}`}
        >
          <span title={strings.t(M.previewTitle)}>{strings.t(M.preview)}</span>
        </CockpitBtn>
        <CockpitBtn
          sm
          disabled={busy || plan.run.length === 0}
          onClick={onPlay}
          testId={`actions-play-${action.id}`}
        >
          {playing ? strings.t(M.playing) : strings.t(M.play)}
        </CockpitBtn>
        <CockpitBtn
          sm
          disabled={busy || plan.run.length === 0}
          onClick={onStep}
          testId={`actions-step-${action.id}`}
        >
          <span title={strings.t(M.stepTitle)}>{strings.t(M.step)}</span>
        </CockpitBtn>
      </div>
      {plan.skip.length > 0 && (
        <div style={{ ...MUTED, fontSize: 11, marginTop: 4 }}>
          {strings.t(M.willSkip, { count: plan.skip.length })}
        </div>
      )}
    </div>
  );
}

function ActionDetail({
  action,
  onRename,
  onRemove,
  onToggleStep,
  onTogglePause,
  onInsertStop,
  rule,
  onRule,
  onDeleteStep,
  onIncludeDocumentBound,
  onExport,
}: {
  action: PagedAction;
  onRename: (name: string) => void;
  onRemove: () => void;
  onToggleStep: (index: number) => void;
  onTogglePause: (index: number) => void;
  onInsertStop: (index: number, message: string) => void;
  rule: ImportRule | null;
  onRule: (rule: ImportRule | null) => void;
  onDeleteStep: (index: number) => void;
  onIncludeDocumentBound: (value: boolean) => void;
  onExport: () => void;
}) {
  const strings = useStrings();
  const actions = useActions();
  const [copied, setCopied] = useState(false);
  const [openValues, setOpenValues] = useState<number | null>(null);
  const [script, setScript] = useState(false);
  const [scopeProblem, setScopeProblem] = useState<string | null>(null);
  const [stopText, setStopText] = useState("");
  const [extText, setExtText] = useState(() =>
    (rule?.extensions ?? []).join(", "),
  );
  const registries = useRegistries();
  const hasDocBound = action.steps.some((s) => s.verdict === "documentBound");
  return (
    <div data-actions-detail={action.id} style={{ padding: "0 14px 12px" }}>
      <Divider />
      <input
        value={action.name}
        onChange={(e) => onRename(e.target.value)}
        style={{ ...inputStyle, marginTop: 0, fontWeight: 600 }}
        data-actions-rename
      />

      <UncapturedLine
        gestures={action.uncaptured.gestures}
        directEdits={action.uncaptured.directEdits}
      />

      <div style={{ marginTop: 8 }}>
        {action.steps.map((step, i) => (
          <Fragment key={i}>
            <div
              data-actions-step
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "3px 0",
                opacity: step.disabled ? 0.45 : 1,
              }}
            >
              <input
                type="checkbox"
                checked={!step.disabled}
                onChange={() => onToggleStep(i)}
                aria-label={strings.t(M.stepEnabled, { n: i + 1 })}
              />
              {/* The breakpoint: playback waits before this step. */}
              <button
                type="button"
                data-actions-pause={i}
                aria-pressed={step.pause === true}
                aria-label={strings.t(M.pauseBefore, { n: i + 1 })}
                title={strings.t(M.pauseBefore, { n: i + 1 })}
                onClick={() => onTogglePause(i)}
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: 3,
                  padding: 0,
                  cursor: "pointer",
                  border: "1px solid var(--pg-border)",
                  background: step.pause
                    ? "var(--status-review)"
                    : "transparent",
                  fontSize: 8,
                  lineHeight: 1,
                  color: "var(--pg-fg)",
                }}
              >
                {step.pause ? "❚❚" : ""}
              </button>
              <span
                style={{ fontSize: 11, flex: 1 }}
                title={step.command}
                data-actions-stop-step={isStopStep(step) || undefined}
              >
                {i + 1}.{" "}
                {isStopStep(step) ? (
                  <strong>{strings.t(M.stopStep)}: </strong>
                ) : null}
                {step.title}
                {step.failed && (
                  <span style={{ color: "var(--status-error)" }}>
                    {strings.t(M.failedWhileRecording)}
                  </span>
                )}
              </span>
              {step.payload !== undefined && (
                <button
                  type="button"
                  data-actions-values={i}
                  aria-expanded={openValues === i}
                  aria-label={strings.t(M.valuesOf, { n: i + 1 })}
                  onClick={() => setOpenValues((v) => (v === i ? null : i))}
                  style={{
                    background: "none",
                    border: "1px solid var(--pg-border)",
                    borderRadius: 999,
                    color: "var(--pg-muted-fg)",
                    cursor: "pointer",
                    fontSize: 10,
                    padding: "0 5px",
                  }}
                >
                  {strings.t(M.values)}
                </button>
              )}
              <span
                title={verdictTitle(step.verdict)}
                data-actions-verdict={step.verdict}
                style={{
                  fontSize: 10,
                  padding: "1px 5px",
                  borderRadius: 999,
                  border: "1px solid var(--pg-border)",
                  color:
                    step.verdict === "documentBound" ||
                    step.verdict === "unserializable"
                      ? "var(--status-review)"
                      : "var(--pg-muted-fg)",
                  whiteSpace: "nowrap",
                }}
              >
                {verdictLabel(step.verdict)}
              </span>
              <button
                type="button"
                onClick={() => onDeleteStep(i)}
                aria-label={strings.t(M.deleteStep, { n: i + 1 })}
                style={{
                  background: "none",
                  border: "none",
                  color: "var(--pg-muted-fg)",
                  cursor: "pointer",
                  fontSize: 12,
                  lineHeight: 1,
                  padding: 2,
                }}
              >
                ×
              </button>
            </div>
            {openValues === i && <StepValues action={action} index={i} />}
          </Fragment>
        ))}
      </div>

      <ActionParams action={action} />

      {/* Editor ADR 1240 — where the action is kept. */}
      <label
        style={{
          display: "flex",
          gap: 6,
          alignItems: "center",
          fontSize: 11,
          marginTop: 10,
        }}
      >
        <span style={MUTED}>{strings.t(M.scopeLabel)}</span>
        <select
          data-actions-scope-select
          value={action.scope ?? "user"}
          disabled={!actions.documentScopeAvailable}
          onChange={(e) => {
            void actions
              .setScope(action.id, e.target.value as "user" | "document")
              .then(setScopeProblem);
          }}
          style={{
            background: "var(--pg-muted)",
            color: "var(--pg-fg)",
            border: "1px solid var(--chrome-divider)",
            borderRadius: "var(--radius-sm)",
            fontSize: 11,
          }}
        >
          <option value="user">{strings.t(M.scopeUser)}</option>
          <option value="document">{strings.t(M.scopeDocument)}</option>
        </select>
      </label>
      {(scopeProblem || !actions.documentScopeAvailable) && (
        <div style={{ ...MUTED, fontSize: 11 }}>
          {scopeProblem ?? strings.t(M.scopeNoDocument)}
        </div>
      )}

      {/* Insert a stop (Photoshop's Insert Stop): it ends up after the
          last step; the step list's order is the replay order. */}
      <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
        <input
          value={stopText}
          onChange={(e) => setStopText(e.target.value)}
          placeholder={strings.t(M.stopDefault)}
          aria-label={strings.t(M.stopMessage)}
          data-actions-stop-message
          style={{ ...inputStyle, marginTop: 0, flex: 1 }}
        />
        <CockpitBtn
          sm
          testId="actions-insert-stop"
          onClick={() => {
            onInsertStop(
              action.steps.length,
              stopText.trim() || strings.t(M.stopDefault),
            );
            setStopText("");
          }}
        >
          {strings.t(M.insertStop)}
        </CockpitBtn>
      </div>

      {/* Run on import — the droplet as a standing rule. */}
      <div
        data-actions-import-rule
        style={{ marginTop: 10, fontSize: 11, color: "var(--pg-muted-fg)" }}
      >
        <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input
            type="checkbox"
            data-actions-run-on-import
            checked={rule?.enabled === true}
            onChange={(e) =>
              onRule(
                e.target.checked
                  ? {
                      id: rule?.id ?? newActionId(),
                      actionId: action.id,
                      extensions: parseExtensions(extText),
                      enabled: true,
                    }
                  : null,
              )
            }
          />
          <span style={{ color: "var(--pg-fg)" }}>
            {strings.t(M.runOnImport)}
          </span>
        </label>
        <div style={{ marginTop: 4, lineHeight: 1.5 }}>
          {strings.t(M.runOnImportNote)}
        </div>
        <input
          value={extText}
          onChange={(e) => setExtText(e.target.value)}
          onBlur={() => {
            if (rule) onRule({ ...rule, extensions: parseExtensions(extText) });
          }}
          aria-label={strings.t(M.extensions)}
          placeholder="idml, xlsx, png"
          data-actions-import-extensions
          style={{ ...inputStyle, marginTop: 4 }}
        />
      </div>

      {hasDocBound && (
        <label
          style={{
            display: "flex",
            gap: 6,
            alignItems: "flex-start",
            fontSize: 11,
            marginTop: 8,
            color: "var(--pg-muted-fg)",
          }}
        >
          <input
            type="checkbox"
            checked={action.includeDocumentBound}
            onChange={(e) => onIncludeDocumentBound(e.target.checked)}
            data-actions-include-docbound
          />
          <span>{strings.t(M.includeDocBound)}</span>
        </label>
      )}

      <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
        <CockpitBtn
          sm
          onClick={() => {
            void navigator.clipboard
              ?.writeText(toDemoScript(action))
              .then(() => setCopied(true))
              .catch(() => setCopied(false));
          }}
        >
          {copied ? strings.t(M.copied) : strings.t(M.copyAsScript)}
        </CockpitBtn>
        <CockpitBtn
          sm
          testId="actions-paged-script"
          onClick={() => setScript((v) => !v)}
        >
          {script ? strings.t(M.hideScript) : strings.t(M.pagedScript)}
        </CockpitBtn>
        <CockpitBtn sm onClick={onExport}>
          {strings.t(M.export)}
        </CockpitBtn>
        <CockpitBtn
          sm
          testId="actions-batch"
          onClick={() => void registries.commands.invoke("paged.actions.batch")}
        >
          {strings.t(M.batch)}
        </CockpitBtn>
        <CockpitBtn sm onClick={onRemove} testId="actions-delete">
          {strings.t(M.delete)}
        </CockpitBtn>
      </div>
      {/* Why "Copy as script" exists at all — see `toDemoScript`. The
          automation layer's `editor.runCommand(id, payload)` runs
          against this same registry, so the steps ARE a script; the
          step list stays the primitive only because a script cannot
          carry the per-step verdicts. */}
      <div style={{ ...MUTED, fontSize: 11, marginTop: 6, lineHeight: 1.5 }}>
        {strings.t(M.copyNoteBefore)} <code>editor.runCommand(…)</code>{" "}
        {strings.t(M.copyNoteAfter)}
      </div>
      {script && (
        <div style={{ marginTop: 6 }}>
          <pre
            data-actions-script
            style={{
              margin: 0,
              padding: 8,
              maxHeight: 220,
              overflow: "auto",
              background: "var(--pg-muted)",
              borderRadius: "var(--radius-sm)",
              fontFamily: "var(--font-mono)",
              fontSize: 10.5,
              whiteSpace: "pre-wrap",
            }}
          >
            {actions.pagedScript(action.id)}
          </pre>
          <CockpitBtn
            sm
            onClick={() =>
              void navigator.clipboard?.writeText(
                actions.pagedScript(action.id),
              )
            }
          >
            {strings.t(M.copyPagedScript)}
          </CockpitBtn>
        </div>
      )}
    </div>
  );
}

/** The replay waiting at a breakpoint, a stop or between steps. */
function PlaybackBar({
  playback,
  stepCount,
  onContinue,
  onStep,
  onCancel,
}: {
  playback: PlaybackState;
  stepCount: number;
  onContinue: () => void;
  onStep: () => void;
  onCancel: () => void;
}) {
  const strings = useStrings();
  const waiting = playback.status === "paused" || playback.status === "stopped";
  return (
    <div
      data-actions-playback={playback.status}
      style={{
        margin: "0 14px 12px",
        border: "1px solid var(--status-review)",
        borderRadius: "var(--radius-md)",
        padding: 9,
        fontSize: 12,
      }}
    >
      <div data-actions-playback-message style={{ marginBottom: 6 }}>
        {playback.status === "stopped"
          ? playback.pausedAt === null
            ? strings.t(M.stopEnd, { message: playback.message ?? "" })
            : strings.t(M.stoppedAt, { message: playback.message ?? "" })
          : playback.status === "paused" && playback.pausedAt !== null
            ? strings.t(M.pausedAt, {
                n: Math.min(playback.pausedAt + 1, stepCount),
              })
            : strings.t(M.playing)}
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <CockpitBtn
          primary
          sm
          disabled={!waiting}
          onClick={onContinue}
          testId="actions-continue"
        >
          {strings.t(M.continue)}
        </CockpitBtn>
        <CockpitBtn
          sm
          disabled={!waiting || playback.pausedAt === null}
          onClick={onStep}
          testId="actions-step-once"
        >
          {strings.t(M.step)}
        </CockpitBtn>
        <CockpitBtn sm onClick={onCancel} testId="actions-cancel-playback">
          {strings.t(M.cancel)}
        </CockpitBtn>
      </div>
    </div>
  );
}
