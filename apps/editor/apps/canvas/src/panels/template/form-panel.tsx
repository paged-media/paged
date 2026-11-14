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

// The template form (docs/composable-editor.md §7.10; plan task D2): every
// field of the template, in the author's order, with a control for its kind.
// It reads the engine's `templateFields` collection and writes through
// `setTemplateFields` (one undo step, checked against the session's role) or,
// for a picture, through `replaceImageBytes`, which the engine checks as
// `image.replace` on the item. A module field (a sheet's cell, a doc's
// block) reads and writes through its module (module-field.tsx). The canvas
// shows the same values, because both read the document.

import { useRef, useState, type ReactElement } from "react";

import type {
  TemplateFieldSummary,
  TemplateFieldValue,
} from "@paged-media/client";
import {
  FieldInput,
  FieldTextarea,
  NamedAs,
  StatusLine,
  refusalText,
  space,
} from "@paged-media/panel-kit";
import {
  chooseFiles,
  touchTargetStyle,
  useCanvasClient,
  useCollection,
  useCompactLayout,
  useRegistries,
  useSelection,
  useTouchSized,
} from "@paged-media/shell";

import { useStrings } from "@paged-media/strings";

import { FORM, problemText } from "./messages";
import { fieldFilled, formProgress, nextIncomplete } from "./progress";
import { ModuleFieldControl } from "./module-field";
import { StyledTextControl, type Breaks, type StyledRun } from "./styled-text";

const IMAGE_TYPES = [
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".tif",
  ".tiff",
  ".psd",
  ".webp",
];

function fileName(uri: string): string {
  const tail = uri.split(/[\\/]/).pop() ?? uri;
  try {
    return decodeURIComponent(tail);
  } catch {
    return tail;
  }
}

/** Whether an engine id names the same item: the two replies that carry
 *  ids spell their keys in a different order. */
function sameElement(a: unknown, b: unknown): boolean {
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const x = a as { kind?: unknown; id?: unknown };
  const y = b as { kind?: unknown; id?: unknown };
  return x.kind === y.kind && JSON.stringify(x.id) === JSON.stringify(y.id);
}

/** A picture input as a button (editor ADR 294): `capture` makes a phone
 *  offer its camera; without it, the phone's library and files. */
function PictureInput({
  field,
  capture,
  label,
  touch,
  onFile,
}: {
  field: string;
  capture: boolean;
  label: string;
  touch: boolean;
  onFile: (file: File) => void;
}): ReactElement {
  return (
    <label
      data-field-picture-input={capture ? "camera" : "library"}
      style={{
        ...touchTargetStyle(touch),
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        padding: `0 ${space[3]}px`,
        borderRadius: "var(--radius-md)",
        border: "1px solid var(--pg-border)",
        background: capture ? "var(--pg-primary)" : "transparent",
        color: capture ? "var(--pg-primary-fg)" : "var(--pg-fg)",
        cursor: "pointer",
        fontWeight: 600,
      }}
    >
      {label}
      <input
        type="file"
        accept="image/*"
        {...(capture ? { capture: "environment" } : {})}
        data-field-file={field}
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          opacity: 0,
          overflow: "hidden",
        }}
        onChange={(e) => {
          const file = e.currentTarget.files?.[0];
          e.currentTarget.value = "";
          if (file) onFile(file);
        }}
      />
    </label>
  );
}

function FieldRow({
  row,
  showMissing,
}: {
  row: TemplateFieldSummary;
  /** Finish was asked for: an empty required field says so. */
  showMissing: boolean;
}): ReactElement {
  const client = useCanvasClient();
  const strings = useStrings();
  // A fill shape on a phone or tablet: touch-sized controls, and a
  // picture comes from the camera or the library (editor ADR 294).
  const touch = useTouchSized();
  const touchStyle = touchTargetStyle(touch);
  const { field } = row;
  const current =
    row.value?.kind === "text"
      ? row.value.text
      : row.value?.kind === "image"
        ? row.value.uri
        : "";
  const [draft, setDraft] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const label = field.label ?? field.name;
  const max = field.constraints?.maxLength ?? null;
  const text = draft ?? current;
  // Engine ADR 1017: a text field with allowed styles or breaks is written
  // as styled runs, through the control that offers exactly those.
  const allowedStyles = field.constraints?.allowedStyles ?? [];
  const breaks = (field.constraints?.breaks ?? null) as Breaks | null;
  const styled =
    field.kind === "text" && (allowedStyles.length > 0 || breaks !== null);

  const set = async (value: TemplateFieldValue["value"]) => {
    setMessage(null);
    const result = await client.setTemplateFields([
      { name: field.name, value },
    ]);
    if (result.ok) {
      setDraft(null);
      return;
    }
    if ("problems" in result) {
      setMessage(
        result.problems.map((p) => problemText(strings, p.problem)).join("; "),
      );
      return;
    }
    const reply = result.reply;
    setMessage(
      reply.kind === "mutationFailed"
        ? refusalText(reply.payload.error)
        : strings.t(FORM.didNotApply),
    );
  };

  const commitText = () => {
    if (draft === null || draft === current) {
      setDraft(null);
      return;
    }
    void set({ kind: "text", text: draft });
  };

  const placePicture = async (file: File) => {
    setMessage(null);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const reply = await client.mutateWithBytes(
      { op: "replaceImageBytes", args: { elementId: row.targetId, bytes: [] } },
      bytes,
      true,
    );
    if (reply.kind === "mutationFailed")
      setMessage(refusalText(reply.payload.error));
  };

  const replacePicture = async () => {
    const [file] = await chooseFiles({ accept: IMAGE_TYPES });
    if (file) await placePicture(file);
  };

  let control: ReactElement;
  switch (styled ? "styled" : field.kind) {
    case "styled": {
      const runs: StyledRun[] =
        row.value?.kind === "runs"
          ? (row.value.runs as StyledRun[])
          : current
            ? [{ text: current }]
            : [];
      control = (
        <StyledTextControl
          name={field.name}
          runs={runs}
          allowed={allowedStyles}
          breaks={breaks}
          maxLength={max}
          onCommit={(next) => void set({ kind: "runs", runs: next } as never)}
        />
      );
      break;
    }
    case "alternates": {
      const members = row.members ?? [];
      control = (
        <div
          role="radiogroup"
          aria-label={label}
          data-field-alternates={field.name}
          style={{ display: "flex", gap: space[1], flexWrap: "wrap" }}
        >
          {members.map((m) => (
            <button
              key={m.name}
              type="button"
              role="radio"
              aria-checked={m.visible}
              data-field-alternate={m.name}
              data-active={m.visible ? "" : undefined}
              disabled={!m.elementId}
              style={{
                fontWeight: m.visible ? 700 : 400,
                outline: m.visible ? "2px solid var(--pg-primary)" : undefined,
              }}
              onClick={() =>
                void set({ kind: "alternate", member: m.name } as never)
              }
            >
              {m.name}
            </button>
          ))}
        </div>
      );
      break;
    }
    case "text":
    case "variable": {
      const multiline = (field.constraints?.maxLines ?? 1) > 1;
      const common = {
        value: text,
        maxLength: max ?? undefined,
        "data-field-input": field.name,
        // 16 px keeps a phone from zooming the page into the field.
        style: touch ? { ...touchStyle, fontSize: 16 } : undefined,
        onChange: (e: { currentTarget: { value: string } }) =>
          setDraft(e.currentTarget.value),
        onBlur: commitText,
      };
      control = multiline ? (
        <FieldTextarea {...common} rows={field.constraints?.maxLines ?? 3} />
      ) : (
        <FieldInput
          {...common}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitText();
            if (e.key === "Escape") setDraft(null);
          }}
        />
      );
      break;
    }
    case "image":
      control = (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: space[2],
            alignItems: "center",
          }}
        >
          <span
            data-field-picture={field.name}
            style={{
              flex: 1,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {current ? fileName(current) : strings.t(FORM.noPicture)}
          </span>
          {touch ? (
            <>
              <PictureInput
                field={field.name}
                capture
                label={strings.t(FORM.takePhoto)}
                touch={touch}
                onFile={(file) => void placePicture(file)}
              />
              <PictureInput
                field={field.name}
                capture={false}
                label={strings.t(FORM.choosePicture)}
                touch={touch}
                onFile={(file) => void placePicture(file)}
              />
            </>
          ) : (
            <button
              type="button"
              data-field-replace={field.name}
              onClick={() => void replacePicture()}
            >
              {strings.t(FORM.replace)}
            </button>
          )}
        </div>
      );
      break;
    case "visibility": {
      const visible = row.value?.kind === "visible" ? row.value.visible : true;
      control = (
        <input
          type="checkbox"
          data-field-input={field.name}
          style={touch ? { width: 24, height: 24, margin: 10 } : undefined}
          checked={visible}
          onChange={(e) =>
            void set({ kind: "visible", visible: e.currentTarget.checked })
          }
        />
      );
      break;
    }
    case "module":
      control = <ModuleFieldControl row={row} onProblem={setMessage} />;
      break;
    default:
      control = (
        <span style={{ color: "var(--pg-muted-fg)" }}>
          {strings.t(FORM.cannotFill)}
        </span>
      );
  }

  return (
    <NamedAs name={label}>
      <div
        data-template-field={field.name}
        style={{ display: "grid", gap: space[1] }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontSize: 11.5,
            fontWeight: 600,
          }}
        >
          <span>
            {label} {/* Editor ADR 1225 — required or optional, in words. */}
            <span
              data-field-required={field.required ? "required" : "optional"}
              style={{
                fontWeight: 400,
                color: field.required ? "var(--pg-fg)" : "var(--pg-muted-fg)",
              }}
            >
              {strings.t(field.required ? FORM.required : FORM.optional)}
            </span>
          </span>
          {max !== null &&
          !styled &&
          (field.kind === "text" || field.kind === "variable") ? (
            <span
              data-field-count={field.name}
              style={{ color: "var(--pg-muted-fg)" }}
            >
              {text.length}/{max}
            </span>
          ) : null}
        </div>
        {control}
        {field.help ? (
          <div style={{ color: "var(--pg-muted-fg)", fontSize: 11 }}>
            {field.help}
          </div>
        ) : null}
        {showMissing && field.required && !fieldFilled(row) ? (
          <StatusLine tone="warn" attr="data-field-missing">
            {strings.t(FORM.missing)}
          </StatusLine>
        ) : null}
        {row.overset ? (
          <StatusLine tone="warn" attr="data-field-overset">
            {strings.t(FORM.overset)}
          </StatusLine>
        ) : null}
        <StatusLine tone="error" attr="data-field-problem">
          {message}
        </StatusLine>
      </div>
    </NamedAs>
  );
}

/** The rows of a form, under the author's group headings. */
function FieldGroups({
  rows,
  showMissing,
}: {
  rows: readonly TemplateFieldSummary[];
  showMissing: boolean;
}): ReactElement {
  const groups = new Map<string, TemplateFieldSummary[]>();
  for (const row of rows) {
    const g = row.field.group ?? "";
    groups.set(g, [...(groups.get(g) ?? []), row]);
  }
  return (
    <>
      {[...groups].map(([group, members]) => (
        <section key={group} style={{ display: "grid", gap: space[3] }}>
          {group ? (
            <h3 style={{ margin: 0, fontSize: 12, fontWeight: 700 }}>
              {group}
            </h3>
          ) : null}
          {members.map((row) => (
            <FieldRow
              key={row.field.name}
              row={row}
              showMissing={showMissing}
            />
          ))}
        </section>
      ))}
    </>
  );
}

/**
 * Editor ADR 1225 — where the filler is: how many fields hold a value, how
 * many required ones are empty, and the way to the next one; at the end,
 * Finish checks the fields and offers the export and the save. The page is
 * the live preview: every value shows there as it is written.
 */
function FormProgressBar({
  rows,
  onNext,
}: {
  rows: readonly TemplateFieldSummary[];
  onNext(): void;
}): ReactElement {
  const strings = useStrings();
  const touch = touchTargetStyle(useTouchSized());
  const p = formProgress(rows);
  const share = p.total === 0 ? 0 : p.filled / p.total;
  return (
    <div data-form-progress="" style={{ display: "grid", gap: space[1] }}>
      <div style={{ display: "flex", alignItems: "center", gap: space[2] }}>
        <span data-form-progress-text="" style={{ flex: 1, fontSize: 12 }}>
          {strings.t(FORM.progress, { filled: p.filled, total: p.total })}
        </span>
        {p.next ? (
          <button
            type="button"
            data-form-next=""
            title={strings.t(FORM.nextFieldTitle)}
            style={{ ...sheetButton, ...touch }}
            onClick={onNext}
          >
            {strings.t(FORM.nextField)}
          </button>
        ) : null}
      </div>
      <div
        role="progressbar"
        aria-label={strings.t(FORM.progressLabel)}
        aria-valuemin={0}
        aria-valuemax={p.total}
        aria-valuenow={p.filled}
        style={{
          height: 4,
          borderRadius: 2,
          background: "var(--pg-border)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${Math.round(share * 100)}%`,
            height: "100%",
            background: "var(--pg-primary)",
          }}
        />
      </div>
      <span
        data-form-required-left={p.requiredMissing.length}
        style={{
          fontSize: 11,
          color:
            p.requiredMissing.length > 0
              ? "var(--pg-warning, #b54708)"
              : "var(--pg-muted-fg)",
        }}
      >
        {p.requiredMissing.length > 0
          ? strings.t(FORM.requiredLeft, { count: p.requiredMissing.length })
          : p.next === null
            ? strings.t(FORM.allFilled)
            : null}
      </span>
    </div>
  );
}

function FinishSection({
  rows,
  onBlocked,
}: {
  rows: readonly TemplateFieldSummary[];
  /** Finish was asked for while fields are missing: show them. */
  onBlocked(first: string | null): void;
}): ReactElement {
  const strings = useStrings();
  const registries = useRegistries();
  const touch = touchTargetStyle(useTouchSized());
  const [stage, setStage] = useState<"form" | "blocked" | "ready">("form");
  const p = formProgress(rows);
  const run = (id: string) => {
    if (registries.commands.get(id)) void registries.commands.invoke(id);
  };
  return (
    <div data-form-finish-area="" style={{ display: "grid", gap: space[2] }}>
      {stage === "ready" && p.ready ? (
        <div
          data-form-ready=""
          role="status"
          style={{
            display: "grid",
            gap: space[2],
            padding: space[2],
            borderRadius: "var(--radius-md)",
            border: "1px solid var(--pg-border)",
          }}
        >
          <span style={{ fontSize: 12 }}>{strings.t(FORM.ready)}</span>
          <div style={{ display: "flex", gap: space[2], flexWrap: "wrap" }}>
            <button
              type="button"
              data-form-export=""
              style={{
                ...sheetButton,
                ...touch,
                background: "var(--pg-primary)",
                color: "var(--pg-primary-fg)",
              }}
              onClick={() => run("paged.file.exportPdf")}
            >
              {strings.t(FORM.exportPdf)}
            </button>
            <button
              type="button"
              data-form-save=""
              style={{ ...sheetButton, ...touch }}
              onClick={() => run("paged.file.savePaged")}
            >
              {strings.t(FORM.save)}
            </button>
            <button
              type="button"
              data-form-back=""
              style={{ ...sheetButton, ...touch }}
              onClick={() => setStage("form")}
            >
              {strings.t(FORM.backToForm)}
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          data-form-finish=""
          title={strings.t(FORM.finishTitle)}
          style={{ ...sheetButton, ...touch, justifySelf: "start" }}
          onClick={() => {
            if (p.ready) {
              setStage("ready");
              return;
            }
            setStage("blocked");
            onBlocked(p.requiredMissing[0] ?? p.overset[0] ?? null);
          }}
        >
          {strings.t(FORM.finish)}
        </button>
      )}
      {stage === "blocked" && !p.ready ? (
        <div data-form-blocked="" role="alert" style={{ fontSize: 12 }}>
          {p.requiredMissing.length > 0
            ? strings.t(FORM.finishBlocked, {
                count: p.requiredMissing.length,
              })
            : strings.t(FORM.finishOverset, { count: p.overset.length })}
        </div>
      ) : null}
    </div>
  );
}

/** Put the caret into field `name`'s control (and, on a phone, its sheet:
 *  the sheet shows the field whose frame is selected). */
function useFieldFocus(rows: readonly TemplateFieldSummary[]) {
  const root = useRef<HTMLDivElement | null>(null);
  const { setElementSelection } = useSelection();
  const focus = (name: string | null) => {
    if (!name) return;
    const row = rows.find((r) => r.field.name === name);
    if (row?.elementId) setElementSelection([row.elementId]);
    requestAnimationFrame(() => {
      const el = root.current?.querySelector<HTMLElement>(
        `[data-template-field="${CSS.escape(name)}"] input, ` +
          `[data-template-field="${CSS.escape(name)}"] textarea, ` +
          `[data-template-field="${CSS.escape(name)}"] button`,
      );
      el?.focus();
      el?.scrollIntoView({ block: "nearest" });
    });
  };
  return { root, focus };
}

const sheetButton = {
  padding: `0 ${space[3]}px`,
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--pg-border)",
  background: "transparent",
  color: "var(--pg-fg)",
  font: "inherit",
  fontWeight: 600,
  cursor: "pointer",
} as const;

/**
 * The form as a sheet under the canvas (the `template-fill` preset on a
 * phone, editor ADR 294): the field tapped on the page, with Done to put
 * it away, or every field when asked for.
 */
function FieldSheet({
  rows,
}: {
  rows: readonly TemplateFieldSummary[];
}): ReactElement {
  const strings = useStrings();
  const { elementSelection, setElementSelection } = useSelection();
  const [all, setAll] = useState(false);
  const [showMissing, setShowMissing] = useState(false);
  const { root, focus } = useFieldFocus(rows);
  const active = rows.find((row) =>
    elementSelection.some((id) => sameElement(id, row.elementId)),
  );
  const shown = all ? rows : active ? [active] : [];
  const touch = touchTargetStyle(true);
  return (
    <div
      ref={root}
      data-template-form
      data-template-form-sheet={active ? active.field.name : ""}
      style={{ display: "grid", gap: space[3], padding: space[3] }}
    >
      <FormProgressBar
        rows={rows}
        onNext={() =>
          focus(nextIncomplete(rows, active ? active.field.name : null))
        }
      />
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: space[2],
        }}
      >
        <span
          style={{
            flex: 1,
            minWidth: 0,
            color: shown.length ? "var(--pg-fg)" : "var(--pg-muted-fg)",
            fontSize: 14,
          }}
        >
          {shown.length ? null : strings.t(FORM.tapAField)}
        </span>
        <button
          type="button"
          data-sheet-all
          aria-expanded={all}
          style={{ ...sheetButton, ...touch }}
          onClick={() => setAll(!all)}
        >
          {strings.t(all ? FORM.hideFields : FORM.allFields)}
        </button>
        {active || all ? (
          <button
            type="button"
            data-sheet-done
            style={{ ...sheetButton, ...touch }}
            onClick={() => {
              setAll(false);
              setElementSelection([]);
            }}
          >
            {strings.t(FORM.done)}
          </button>
        ) : null}
      </div>
      {shown.length ? (
        <FieldGroups rows={shown} showMissing={showMissing} />
      ) : null}
      <FinishSection
        rows={rows}
        onBlocked={(first) => {
          setShowMissing(true);
          focus(first);
        }}
      />
    </div>
  );
}

/** The template form: one row per field, grouped by the author's groups. */
export function TemplateFormPanel(): ReactElement {
  const strings = useStrings();
  const rows = useCollection<TemplateFieldSummary>("templateFields");
  const sheet = useCompactLayout() === "field-sheet";
  if (rows === null) return <div style={{ padding: space[3] }} />;
  if (rows.length === 0) {
    return (
      <div
        data-template-form-empty
        style={{ padding: space[3], color: "var(--pg-muted-fg)" }}
      >
        {strings.t(FORM.empty)}
      </div>
    );
  }
  if (sheet) return <FieldSheet rows={rows} />;
  return <DockedForm rows={rows} />;
}

/** The form docked beside the page: the progress, every field, Finish. */
function DockedForm({
  rows,
}: {
  rows: readonly TemplateFieldSummary[];
}): ReactElement {
  const [showMissing, setShowMissing] = useState(false);
  const [last, setLast] = useState<string | null>(null);
  const { root, focus } = useFieldFocus(rows);
  return (
    <div
      ref={root}
      data-template-form
      style={{ display: "grid", gap: space[3], padding: space[3] }}
    >
      <FormProgressBar
        rows={rows}
        onNext={() => {
          const next = nextIncomplete(rows, last);
          setLast(next);
          focus(next);
        }}
      />
      <FieldGroups rows={rows} showMissing={showMissing} />
      <FinishSection
        rows={rows}
        onBlocked={(first) => {
          setShowMissing(true);
          focus(first);
        }}
      />
    </div>
  );
}
