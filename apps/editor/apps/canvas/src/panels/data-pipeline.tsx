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

// The Data panel's pipeline (editor ADR 291, data ADR 562): how the
// document's data is made, in the order a refresh runs it — the sources,
// the transforms (JavaScript over tables) and the queries the bindings
// read. Each step says what it reads, its rows at the last run, or why it
// gave none; selecting one shows its rows in the grid (a step's id is a
// table of the service). A transform is edited here: what it reads, its
// parameters (JSON) and its source, applied through the service, which
// says why when it refuses.

import { useEffect, useState, type CSSProperties } from "react";

import type { DataPipelineStep, DataService } from "@paged-media/plugin-api";
import { color, font, radius, space, status } from "@paged-media/panel-kit";
import { useDataRevision } from "@paged-media/shell";
import { defineMessages, useStrings } from "@paged-media/strings";
import { CodeEditor } from "@paged-media/ui";

const M = defineMessages("app.dataPipeline", {
  toggle: "Pipeline",
  toggleTitle:
    "How the data is made: the sources, the transforms and the queries, in the order a refresh runs them",
  sources: "Sources",
  transforms: "Transforms",
  queries: "Queries",
  queriesHint: "what the bindings read",
  rows: "{count, plural, one {# row} other {# rows}}",
  notRun: "not run yet",
  reads: "reads {tables}",
  none: "none",
  newTransform: "New transform",
  name: "Table name",
  inputs: "Reads",
  noTables: "No table to read yet",
  params: "Parameters (JSON)",
  source: "Source: (tables, params) => rows",
  apply: "Apply",
  applying: "Applying…",
  remove: "Remove",
  cancel: "Cancel",
  badParams: "The parameters are not a JSON object: {reason}",
  refused: "Not applied: {reason}",
  failed: "The pipeline could not be read: {reason}",
  sql: "SQL",
});

const NEW_SOURCE = "(tables, params) => tables.products";

const small: CSSProperties = { font: `11px ${font.sans}`, color: color.fg };
const muted: CSSProperties = {
  font: `11px ${font.sans}`,
  color: color.mutedFg,
};
const button: CSSProperties = {
  ...small,
  height: 22,
  border: `1px solid ${color.border}`,
  borderRadius: radius.sm,
  background: color.bg,
  padding: "0 8px",
  cursor: "pointer",
};
const control: CSSProperties = {
  ...small,
  height: 22,
  border: `1px solid ${color.border}`,
  borderRadius: radius.sm,
  background: color.bg,
  padding: "0 4px",
};
const code: CSSProperties = {
  margin: 0,
  padding: space[1],
  font: `11px/1.5 ${font.mono}`,
  color: color.fg,
  background: color.muted,
  borderRadius: radius.sm,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

/** Whether the service can show its pipeline. */
export function offersPipeline(service: DataService | null): boolean {
  return typeof service?.pipeline === "function";
}

/** The Data panel's switch for the pipeline view. */
export function PipelineToggle({
  open,
  onToggle,
}: {
  open: boolean;
  onToggle: () => void;
}) {
  const { t } = useStrings();
  return (
    <button
      type="button"
      data-data-pipeline-toggle=""
      aria-pressed={open}
      title={t(M.toggleTitle)}
      onClick={onToggle}
      style={{
        ...button,
        marginLeft: "auto",
        background: open ? color.primarySoft : color.bg,
        flex: "0 0 auto",
      }}
    >
      {t(M.toggle)}
    </button>
  );
}

const message = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/** What the transform editor applies, as the user wrote it. */
interface Draft {
  id: string;
  inputs: readonly string[];
  params: string;
  source: string;
}

type Applied =
  { ok: true } | { ok: false; kind: "params" | "refused"; reason: string };

/** Parse the draft's parameters and hand it to the service. Outside the
 *  component: the React Compiler does not compile a conditional inside a
 *  `try` (ADR 229). */
async function applyDraft(
  service: DataService,
  draft: Draft,
): Promise<Applied> {
  let params: unknown;
  try {
    params = draft.params.trim() === "" ? {} : JSON.parse(draft.params);
  } catch (err) {
    return { ok: false, kind: "params", reason: message(err) };
  }
  if (params === null || typeof params !== "object" || Array.isArray(params))
    return { ok: false, kind: "params", reason: typeof params };
  try {
    await service.defineTransform!({
      id: draft.id.trim(),
      inputs: draft.inputs,
      source: draft.source,
      params: params as Record<string, unknown>,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, kind: "refused", reason: message(err) };
  }
}

function TransformEditor({
  service,
  step,
  tables,
  onDone,
}: {
  service: DataService;
  /** The transform edited; none for a new one. */
  step: DataPipelineStep | null;
  /** The tables a transform may read. */
  tables: readonly string[];
  /** Applied (the transform's id), removed or cancelled (null). */
  onDone: (id: string | null) => void;
}) {
  const { t } = useStrings();
  const [id, setId] = useState(step?.id ?? "");
  const [inputs, setInputs] = useState<readonly string[]>(step?.inputs ?? []);
  const [params, setParams] = useState(
    JSON.stringify(step?.params ?? {}, null, 2),
  );
  const [source, setSource] = useState(step?.source ?? NEW_SOURCE);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const readable = tables.filter((x) => x !== id.trim());

  const apply = async () => {
    setBusy(true);
    const r = await applyDraft(service, { id, inputs, params, source });
    setBusy(false);
    if (r.ok) {
      setError(null);
      onDone(id.trim());
    } else
      setError(
        r.kind === "params"
          ? t(M.badParams, { reason: r.reason })
          : t(M.refused, { reason: r.reason }),
      );
  };
  const remove = () => {
    if (!step) return;
    setBusy(true);
    service.removeTransform!(step.id).then(
      () => {
        setBusy(false);
        onDone(null);
      },
      (err: unknown) => {
        setBusy(false);
        setError(t(M.refused, { reason: message(err) }));
      },
    );
  };

  return (
    <div
      data-pipeline-editor={step?.id ?? ""}
      style={{ display: "grid", gap: space[1], padding: `${space[1]} 0` }}
    >
      <label
        style={{ ...muted, display: "flex", gap: 4, alignItems: "center" }}
      >
        {t(M.name)}
        <input
          data-pipeline-name=""
          style={{ ...control, width: 140, fontFamily: font.mono }}
          value={id}
          readOnly={step !== null}
          onChange={(e) => setId(e.target.value)}
        />
      </label>
      <div
        data-pipeline-inputs=""
        style={{ display: "flex", flexWrap: "wrap", gap: space[2] }}
      >
        <span style={muted}>{t(M.inputs)}</span>
        {readable.length === 0 && <span style={muted}>{t(M.noTables)}</span>}
        {readable.map((name) => (
          <label key={name} style={{ ...small, display: "flex", gap: 4 }}>
            <input
              type="checkbox"
              data-pipeline-input={name}
              checked={inputs.includes(name)}
              onChange={() =>
                setInputs(
                  inputs.includes(name)
                    ? inputs.filter((x) => x !== name)
                    : [...inputs, name],
                )
              }
            />
            {name}
          </label>
        ))}
      </div>
      <span style={muted}>{t(M.params)}</span>
      <div data-pipeline-params="">
        <CodeEditor
          value={params}
          onChange={setParams}
          language="js"
          minHeight={40}
          ariaLabel={t(M.params)}
        />
      </div>
      <span style={muted}>{t(M.source)}</span>
      <div data-pipeline-source="">
        <CodeEditor
          value={source}
          onChange={setSource}
          language="js"
          minHeight={80}
          ariaLabel={t(M.source)}
        />
      </div>
      {error && (
        <p
          data-pipeline-error=""
          role="alert"
          style={{ ...small, color: status.error, margin: 0 }}
        >
          {error}
        </p>
      )}
      <div style={{ display: "flex", gap: space[1] }}>
        <button
          type="button"
          data-pipeline-apply=""
          style={button}
          disabled={busy || id.trim() === ""}
          onClick={() => void apply()}
        >
          {busy ? t(M.applying) : t(M.apply)}
        </button>
        {step && typeof service.removeTransform === "function" && (
          <button
            type="button"
            data-pipeline-remove=""
            style={button}
            disabled={busy}
            onClick={remove}
          >
            {t(M.remove)}
          </button>
        )}
        {!step && (
          <button
            type="button"
            data-pipeline-cancel=""
            style={button}
            onClick={() => onDone(null)}
          >
            {t(M.cancel)}
          </button>
        )}
      </div>
    </div>
  );
}

function StepCard({
  step,
  selected,
  onSelect,
}: {
  step: DataPipelineStep;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useStrings();
  return (
    <button
      type="button"
      data-pipeline-step={step.id}
      data-kind={step.kind}
      data-failed={step.error ? "" : undefined}
      aria-pressed={selected}
      onClick={onSelect}
      style={{
        ...small,
        display: "grid",
        gap: 2,
        textAlign: "left",
        padding: `${space[1]} ${space[2]}`,
        border: `1px solid ${step.error ? status.error : selected ? color.primary : color.border}`,
        borderRadius: radius.sm,
        background: selected ? color.primarySoft : color.bg,
        cursor: "pointer",
        minWidth: 0,
      }}
    >
      <span style={{ fontWeight: 600, fontFamily: font.mono }}>{step.id}</span>
      {step.kind !== "source" && (
        <span style={muted}>
          {t(M.reads, {
            tables: step.inputs.length > 0 ? step.inputs.join(", ") : t(M.none),
          })}
        </span>
      )}
      {step.error ? (
        <span data-pipeline-step-error="" style={{ color: status.error }}>
          {step.error}
        </span>
      ) : (
        <span data-pipeline-rows="" style={muted}>
          {step.rowCount === undefined
            ? t(M.notRun)
            : t(M.rows, { count: step.rowCount })}
        </span>
      )}
    </button>
  );
}

/** The pipeline view: the steps in three lanes and, for a selected step,
 *  its SQL or (a transform) its editor. `onSelect` shows a step's table in
 *  the grid. */
export function DataPipeline({
  service,
  onSelect,
}: {
  service: DataService;
  onSelect: (table: string) => void;
}) {
  const { t } = useStrings();
  const revision = useDataRevision();
  const [steps, setSteps] = useState<readonly DataPipelineStep[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let live = true;
    service.pipeline!().then(
      (s) => {
        if (!live) return;
        setSteps(s);
        setFailure(null);
      },
      (err: unknown) => live && setFailure(message(err)),
    );
    return () => {
      live = false;
    };
  }, [service, revision, reload]);

  const canWrite = typeof service.defineTransform === "function";
  const step = steps.find((s) => s.id === picked) ?? null;
  const readable = steps.filter((s) => s.kind !== "query").map((s) => s.id);
  const select = (id: string) => {
    setPicked(id);
    setCreating(false);
    onSelect(id);
  };
  const done = (id: string | null) => {
    setCreating(false);
    setReload(reload + 1);
    if (id) select(id);
    else setPicked(null);
  };

  const lane = (
    kind: DataPipelineStep["kind"],
    title: string,
    hint?: string,
  ) => (
    <div
      data-pipeline-lane={kind}
      style={{ display: "grid", gap: space[1], alignContent: "start" }}
    >
      <span style={{ ...muted, fontWeight: 600 }} title={hint}>
        {title}
      </span>
      {steps
        .filter((s) => s.kind === kind)
        .map((s) => (
          <StepCard
            key={s.id}
            step={s}
            selected={s.id === picked}
            onSelect={() => select(s.id)}
          />
        ))}
    </div>
  );

  return (
    <div
      data-data-pipeline=""
      style={{
        padding: `${space[1]} ${space[2]}`,
        borderBottom: `1px solid ${color.border}`,
        maxHeight: "60%",
        overflow: "auto",
        flex: "0 0 auto",
      }}
    >
      {failure && (
        <p style={{ ...small, color: status.error, margin: 0 }}>
          {t(M.failed, { reason: failure })}
        </p>
      )}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr auto 1fr auto 1fr",
          gap: space[1],
          alignItems: "start",
        }}
      >
        {lane("source", t(M.sources))}
        <span style={{ ...muted, paddingTop: 18 }} aria-hidden="true">
          →
        </span>
        {lane("transform", t(M.transforms))}
        <span style={{ ...muted, paddingTop: 18 }} aria-hidden="true">
          →
        </span>
        {lane("query", t(M.queries), t(M.queriesHint))}
      </div>
      {canWrite && !creating && (
        <button
          type="button"
          data-pipeline-new=""
          style={{ ...button, marginTop: space[1] }}
          onClick={() => {
            setPicked(null);
            setCreating(true);
          }}
        >
          {t(M.newTransform)}
        </button>
      )}
      {creating && (
        <TransformEditor
          key="new"
          service={service}
          step={null}
          tables={readable}
          onDone={done}
        />
      )}
      {step?.kind === "transform" &&
        (canWrite ? (
          <TransformEditor
            key={step.id}
            service={service}
            step={step}
            tables={readable}
            onDone={done}
          />
        ) : (
          <pre data-pipeline-code="" style={{ ...code, marginTop: space[1] }}>
            {step.source}
          </pre>
        ))}
      {step?.kind === "query" && step.sql && (
        <div style={{ marginTop: space[1] }}>
          <span style={muted}>{t(M.sql)}</span>
          <pre data-pipeline-sql="" style={code}>
            {step.sql}
          </pre>
        </div>
      )}
    </div>
  );
}
