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

import { useState, type ReactElement } from "react";

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
  useCanvasClient,
  useCollection,
} from "@paged-media/shell";

import { ModuleFieldControl } from "./module-field";

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

function FieldRow({ row }: { row: TemplateFieldSummary }): ReactElement {
  const client = useCanvasClient();
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
      setMessage(result.problems.map((p) => p.problem).join("; "));
      return;
    }
    const reply = result.reply;
    setMessage(
      reply.kind === "mutationFailed"
        ? refusalText(reply.payload.error)
        : "The change did not apply.",
    );
  };

  const commitText = () => {
    if (draft === null || draft === current) {
      setDraft(null);
      return;
    }
    void set({ kind: "text", text: draft });
  };

  const replacePicture = async () => {
    const [file] = await chooseFiles({ accept: IMAGE_TYPES });
    if (!file) return;
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

  let control: ReactElement;
  switch (field.kind) {
    case "text":
    case "variable": {
      const multiline = (field.constraints?.maxLines ?? 1) > 1;
      const common = {
        value: text,
        maxLength: max ?? undefined,
        "data-field-input": field.name,
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
        <div style={{ display: "flex", gap: space[2], alignItems: "center" }}>
          <span
            data-field-picture={field.name}
            style={{
              flex: 1,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {current ? fileName(current) : "No picture"}
          </span>
          <button
            type="button"
            data-field-replace={field.name}
            onClick={() => void replacePicture()}
          >
            Replace…
          </button>
        </div>
      );
      break;
    case "visibility": {
      const visible = row.value?.kind === "visible" ? row.value.visible : true;
      control = (
        <input
          type="checkbox"
          data-field-input={field.name}
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
          This field cannot be filled in here yet.
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
            {label}
            {field.required ? " *" : ""}
          </span>
          {max !== null &&
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
        {row.overset ? (
          <StatusLine tone="warn" attr="data-field-overset">
            The text does not fit its frame.
          </StatusLine>
        ) : null}
        <StatusLine tone="error" attr="data-field-problem">
          {message}
        </StatusLine>
      </div>
    </NamedAs>
  );
}

/** The template form: one row per field, grouped by the author's groups. */
export function TemplateFormPanel(): ReactElement {
  const rows = useCollection<TemplateFieldSummary>("templateFields");
  if (rows === null) return <div style={{ padding: space[3] }} />;
  if (rows.length === 0) {
    return (
      <div
        data-template-form-empty
        style={{ padding: space[3], color: "var(--pg-muted-fg)" }}
      >
        This document has no fields to fill in.
      </div>
    );
  }
  const groups = new Map<string, TemplateFieldSummary[]>();
  for (const row of rows) {
    const g = row.field.group ?? "";
    groups.set(g, [...(groups.get(g) ?? []), row]);
  }
  return (
    <div
      data-template-form
      style={{ display: "grid", gap: space[3], padding: space[3] }}
    >
      {[...groups].map(([group, members]) => (
        <section key={group} style={{ display: "grid", gap: space[3] }}>
          {group ? (
            <h3 style={{ margin: 0, fontSize: 12, fontWeight: 700 }}>
              {group}
            </h3>
          ) : null}
          {members.map((row) => (
            <FieldRow key={row.field.name} row={row} />
          ))}
        </section>
      ))}
    </div>
  );
}
