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

// A module field in the template form (plan G2): its control and value come
// from the module that owns the field's kind (`host.objects`'
// `readTemplateField`), and a value goes back through the same module, whose
// writes the engine checks against the session's role like any other.

import { useEffect, useState, type ReactElement } from "react";

import type {
  TemplateFieldControl,
  TemplateFieldRef,
} from "@paged-media/plugin-api";
import type { TemplateFieldSummary } from "@paged-media/client";
import { FieldInput, FieldTextarea, space } from "@paged-media/panel-kit";
import {
  chooseFiles,
  useObjectModel,
  type ShellObjectsSurface,
} from "@paged-media/shell";
import { t } from "@paged-media/strings";

import { FORM } from "./messages";

export function moduleFieldRef(
  row: TemplateFieldSummary,
): TemplateFieldRef | null {
  const module = row.field.module;
  if (!module) return null;
  return {
    name: row.field.name,
    targetId: row.targetId,
    kind: module.kind,
    def: module.def,
  };
}

type Loaded =
  | { state: "loading" }
  | { state: "missing"; why: string }
  | { state: "ready"; control: TemplateFieldControl; value: unknown };

/** The control and value of a module field, re-read when its row changes
 *  (any document change re-reads the template's fields). */
function useModuleField(
  row: TemplateFieldSummary,
): [Loaded, (value: unknown) => Promise<string | null>] {
  const objects = useObjectModel()?.objects;
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  useEffect(() => {
    const ref = moduleFieldRef(row);
    let live = true;
    const read = objects?.readTemplateField;
    if (!ref || !read) {
      void Promise.resolve().then(() => {
        if (live) setLoaded({ state: "missing", why: t(FORM.noModuleReads) });
      });
    } else {
      read(ref).then(
        ({ control, value }) => {
          if (live) setLoaded({ state: "ready", control, value });
        },
        (err: unknown) => {
          if (live)
            setLoaded({
              state: "missing",
              why: /unknownFieldKind/.test(String(err))
                ? t(FORM.moduleNotLoaded)
                : String(err),
            });
        },
      );
    }
    return () => {
      live = false;
    };
  }, [objects, row]);
  const write = (value: unknown) => writeField(objects, row, value);
  return [loaded, write];
}

/** Writes a module field; answers the problem, or null when it took. */
function writeField(
  objects: ShellObjectsSurface | undefined,
  row: TemplateFieldSummary,
  value: unknown,
): Promise<string | null> {
  const ref = moduleFieldRef(row);
  const write = objects?.writeTemplateField;
  if (!ref || !write) return Promise.resolve(t(FORM.noModuleWrites));
  return write(ref, value).then(
    (r) => (r.ok ? null : r.problem),
    (err: unknown) => String(err),
  );
}

function TextControl(props: {
  name: string;
  value: string;
  multiline: boolean;
  commit(value: string): void;
}): ReactElement {
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? props.value;
  const done = () => {
    if (draft !== null && draft !== props.value) props.commit(draft);
    setDraft(null);
  };
  const common = {
    value: text,
    "data-field-input": props.name,
    onChange: (e: { currentTarget: { value: string } }) =>
      setDraft(e.currentTarget.value),
    onBlur: done,
  };
  return props.multiline ? (
    <FieldTextarea {...common} rows={3} />
  ) : (
    <FieldInput
      {...common}
      onKeyDown={(e) => {
        if (e.key === "Enter") done();
        if (e.key === "Escape") setDraft(null);
      }}
    />
  );
}

function TableControl(props: {
  name: string;
  columns: readonly { name: string; title?: string }[];
  rows: readonly (readonly string[])[];
  commit(rows: string[][]): void;
}): ReactElement {
  const cell = (r: number, c: number) => props.rows[r]?.[c] ?? "";
  const set = (r: number, c: number, text: string) => {
    if (text === cell(r, c)) return;
    const next = props.rows.map((row) => [...row]);
    while (next.length <= r) next.push([]);
    next[r]![c] = text;
    props.commit(next);
  };
  return (
    <table
      data-field-table={props.name}
      style={{ borderCollapse: "collapse", fontSize: 11.5 }}
    >
      <thead>
        <tr>
          {props.columns.map((col) => (
            <th key={col.name} style={{ textAlign: "left", fontWeight: 600 }}>
              {col.title ?? col.name}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {props.rows.map((_row, r) => (
          <tr key={r}>
            {props.columns.map((col, c) => (
              <td key={col.name}>
                <FieldInput
                  defaultValue={cell(r, c)}
                  data-field-cell={`${props.name}:${r}:${c}`}
                  onBlur={(e) => set(r, c, e.currentTarget.value)}
                />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The control of one module field, and the problem its last write met. */
export function ModuleFieldControl({
  row,
  onProblem,
}: {
  row: TemplateFieldSummary;
  onProblem(problem: string | null): void;
}): ReactElement {
  const [loaded, write] = useModuleField(row);
  const name = row.field.name;
  const commit = (value: unknown) => {
    onProblem(null);
    void write(value).then(onProblem);
  };
  if (loaded.state === "loading") return <span data-field-loading={name} />;
  if (loaded.state === "missing")
    return (
      <span data-field-missing={name} style={{ color: "var(--pg-muted-fg)" }}>
        {loaded.why}
      </span>
    );
  const { control, value } = loaded;
  switch (control.kind) {
    case "text":
      return (
        <TextControl
          name={name}
          value={typeof value === "string" ? value : ""}
          multiline={control.multiline === true}
          commit={commit}
        />
      );
    case "number":
      return (
        <FieldInput
          type="number"
          data-field-input={name}
          defaultValue={typeof value === "number" ? String(value) : ""}
          min={control.min}
          max={control.max}
          step={control.step}
          onBlur={(e) => {
            const n = Number(e.currentTarget.value);
            if (e.currentTarget.value !== "" && n !== value) commit(n);
          }}
        />
      );
    case "choice":
      return (
        <select
          data-field-input={name}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => commit(e.currentTarget.value)}
        >
          {typeof value === "string" ? null : <option value="" />}
          {control.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label ?? o.value}
            </option>
          ))}
        </select>
      );
    case "toggle":
      return (
        <input
          type="checkbox"
          data-field-input={name}
          checked={value === true}
          onChange={(e) => commit(e.currentTarget.checked)}
        />
      );
    case "picture": {
      const current =
        value && typeof value === "object" && "name" in value
          ? String((value as { name: unknown }).name)
          : null;
      return (
        <div style={{ display: "flex", gap: space[2], alignItems: "center" }}>
          <span data-field-picture={name} style={{ flex: 1, minWidth: 0 }}>
            {current ?? t(FORM.noPicture)}
          </span>
          <button
            type="button"
            data-field-replace={name}
            onClick={async () => {
              const [file] = await chooseFiles({ accept: ["image/*"] });
              if (!file) return;
              commit({
                name: file.name,
                bytes: new Uint8Array(await file.arrayBuffer()),
              });
            }}
          >
            {t(FORM.replace)}
          </button>
        </div>
      );
    }
    case "table":
      return (
        <TableControl
          name={name}
          columns={control.columns}
          rows={Array.isArray(value) ? (value as string[][]) : []}
          commit={commit}
        />
      );
  }
}
