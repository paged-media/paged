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

// The Template panel (plan F1, F2): where an author makes a document a
// template. It lists the fields, makes the selected item a field (or edits
// or removes its field), sets what a filler may do everywhere, and switches
// the session to preview the template as a filler and back. Every change is
// one `x-paged:template` label write (engine ADR 1000), which the engine
// accepts only from the author role, so the panel offers to take it up.

import { useEffect, useState, type ReactElement } from "react";

import type {
  ElementId,
  Role,
  TemplateFieldSummary,
} from "@paged-media/client";
import type { TemplateFieldKindInfo } from "@paged-media/plugin-api";
import {
  FieldInput,
  NamedAs,
  StatusLine,
  refusalText,
  space,
} from "@paged-media/panel-kit";
import {
  useCanvasClient,
  useCollection,
  useObjectModel,
  useSelection,
  useSessionRole,
  useSetSessionRole,
} from "@paged-media/shell";

const KEY = "x-paged:template";

type Kind = "text" | "image" | "visibility" | "module";

/** What an author may let a filler do to an item beyond its field. */
const EXTRA: readonly [string, string][] = [
  ["text.style", "Format the text"],
  ["image.crop", "Move and scale the picture in its frame"],
  ["item.move", "Move"],
  ["item.resize", "Resize"],
  ["item.rotate", "Rotate"],
  ["item.delete", "Delete"],
  ["item.visibility", "Show or hide"],
  ["appearance.fill", "Change the fill"],
  ["appearance.stroke", "Change the stroke"],
];

/** What a filler may do everywhere (the document's defaults). */
const DOCUMENT: readonly [string, string][] = [
  ["select", "Select any item"],
  ["document.pages", "Add and remove pages"],
  ["document.add-item", "Add new items"],
];

interface ItemPolicy {
  field?: {
    name: string;
    kind: string;
    label?: string;
    help?: string;
    group?: string;
    required?: boolean;
    constraints?: { maxLength?: number; maxLines?: number; fit?: string };
    module?: { kind: string; grants?: string[]; def?: unknown };
  };
  allow?: string[];
  deny?: string[];
}

const envelope = (data: unknown) => JSON.stringify({ v: 1, data });

function parse<T>(raw: unknown): T | null {
  try {
    const value = typeof raw === "string" ? JSON.parse(raw) : raw;
    return value && typeof value === "object" && "data" in value
      ? ((value as { data: T }).data ?? null)
      : null;
  } catch {
    return null;
  }
}

/** The kind an item suggests: a text frame holds text, a frame a picture. */
function kindFor(id: ElementId): Kind {
  if (id.kind === "textFrame") return "text";
  if (id.kind === "rectangle" || id.kind === "oval" || id.kind === "polygon")
    return "image";
  return "visibility";
}

/** The `x-paged:template` label of an item or the document, re-read when
 *  `version` changes. */
function useLabel(address: string | null, version: unknown): unknown {
  const objects = useObjectModel()?.objects;
  const [raw, setRaw] = useState<unknown>(null);
  useEffect(() => {
    let live = true;
    if (!address || !objects) return;
    void objects.get(address, "labels").then((v) => {
      if (!live) return;
      const map =
        v.kind === "value" && v.value && typeof v.value === "object"
          ? (v.value as Record<string, unknown>)
          : {};
      setRaw(map[KEY] ?? null);
    });
    return () => {
      live = false;
    };
  }, [address, objects, version]);
  return address ? raw : null;
}

function RoleBar({ role }: { role: Role }): ReactElement {
  const setRole = useSetSessionRole();
  const switchTo = (next: Role, label: string, attr: string) => (
    <button
      type="button"
      data-template-role={attr}
      disabled={!setRole}
      onClick={() => setRole?.(next)}
    >
      {label}
    </button>
  );
  const line =
    role === "author"
      ? "You are authoring this template."
      : role === "filler"
        ? "You see the template as the person filling it in."
        : "Take up authoring to make fields and set what a filler may do.";
  return (
    <div style={{ display: "grid", gap: space[2] }}>
      <div style={{ fontSize: 11.5 }} data-template-role-line={role}>
        {line}
      </div>
      <div style={{ display: "flex", gap: space[2], flexWrap: "wrap" }}>
        {role === "author"
          ? switchTo("filler", "Preview as filler", "preview")
          : null}
        {role === "filler"
          ? switchTo("author", "Back to authoring", "author")
          : null}
        {role === "editor"
          ? switchTo("author", "Author template", "author")
          : null}
        {role === "author"
          ? switchTo("editor", "Stop authoring", "editor")
          : null}
      </div>
    </div>
  );
}

function FieldEditor({
  id,
  policy,
  kinds,
  onDone,
}: {
  id: ElementId;
  policy: ItemPolicy | null;
  kinds: readonly TemplateFieldKindInfo[];
  onDone(message: string | null): void;
}): ReactElement {
  const client = useCanvasClient();
  const field = policy?.field;
  const [name, setName] = useState(
    field?.name ?? (typeof id.id === "string" ? id.id : ""),
  );
  const [label, setLabel] = useState(field?.label ?? "");
  const [group, setGroup] = useState(field?.group ?? "");
  const [help, setHelp] = useState(field?.help ?? "");
  const [required, setRequired] = useState(field?.required === true);
  const [kind, setKind] = useState<Kind>(
    (field?.kind as Kind | undefined) ?? kindFor(id),
  );
  const [moduleKind, setModuleKind] = useState(
    field?.module?.kind ?? kinds[0]?.kind ?? "",
  );
  const [def, setDef] = useState(
    field?.module?.def === undefined ? "{}" : JSON.stringify(field.module.def),
  );
  const [maxLength, setMaxLength] = useState(
    field?.constraints?.maxLength?.toString() ?? "",
  );
  const [allow, setAllow] = useState<readonly string[]>(policy?.allow ?? []);

  const write = async (value: string | null): Promise<string | null> => {
    const reply = await client.mutate({
      op: "setPluginMetadata",
      args: { elementId: id, key: KEY, value },
    } as never);
    return reply.kind === "mutationFailed"
      ? refusalText(reply.payload.error)
      : null;
  };

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) return onDone("A field needs a name.");
    let parsedDef: unknown = null;
    if (kind === "module") {
      try {
        parsedDef = JSON.parse(def || "{}");
      } catch {
        return onDone("The module definition is not JSON.");
      }
    }
    const info = kinds.find((k) => k.kind === moduleKind);
    const next: ItemPolicy = {
      field: {
        name: trimmed,
        kind,
        ...(label ? { label } : {}),
        ...(help ? { help } : {}),
        ...(group ? { group } : {}),
        ...(required ? { required } : {}),
        constraints:
          kind === "text" && maxLength
            ? { maxLength: Number(maxLength) }
            : kind === "image"
              ? { fit: "fill-proportionally" }
              : {},
        ...(kind === "module"
          ? {
              module: {
                kind: moduleKind,
                grants: [...(info?.grants ?? [])],
                def: parsedDef,
              },
            }
          : {}),
      },
      ...(allow.length ? { allow: [...allow] } : {}),
      ...(policy?.deny?.length ? { deny: policy.deny } : {}),
    };
    const refused = await write(envelope(next));
    if (refused) return onDone(refused);
    // The field's item carries the field's name, as InDesign's script
    // label would, so the name survives a round trip.
    await client.mutate({
      op: "setElementProperty",
      args: {
        elementId: id,
        path: "itemName",
        value: { type: "text", value: trimmed },
      },
    } as never);
    onDone(null);
  };

  const row = (title: string, control: ReactElement) => (
    <label style={{ display: "grid", gap: space[1], fontSize: 11.5 }}>
      <span style={{ fontWeight: 600 }}>{title}</span>
      {control}
    </label>
  );
  const text = (
    value: string,
    set: (v: string) => void,
    attr: string,
    type = "text",
  ) => (
    <FieldInput
      type={type}
      value={value}
      data-template-edit={attr}
      onChange={(e) => set(e.currentTarget.value)}
    />
  );

  return (
    <div data-template-editor style={{ display: "grid", gap: space[2] }}>
      {row("Name", text(name, setName, "name"))}
      {row("Label", text(label, setLabel, "label"))}
      {row(
        "Kind",
        <select
          data-template-edit="kind"
          value={kind}
          onChange={(e) => setKind(e.currentTarget.value as Kind)}
        >
          <option value="text">Text</option>
          <option value="image">Picture</option>
          <option value="visibility">Shown or hidden</option>
          {kinds.length ? <option value="module">Module content</option> : null}
        </select>,
      )}
      {kind === "text"
        ? row(
            "Longest text",
            text(maxLength, setMaxLength, "maxLength", "number"),
          )
        : null}
      {kind === "module"
        ? row(
            "Module field",
            <select
              data-template-edit="module"
              value={moduleKind}
              onChange={(e) => setModuleKind(e.currentTarget.value)}
            >
              {kinds.map((k) => (
                <option key={k.kind} value={k.kind}>
                  {k.title}
                </option>
              ))}
            </select>,
          )
        : null}
      {kind === "module"
        ? row("Definition (JSON)", text(def, setDef, "def"))
        : null}
      {row("Group", text(group, setGroup, "group"))}
      {row("Help", text(help, setHelp, "help"))}
      <label style={{ fontSize: 11.5 }}>
        <input
          type="checkbox"
          data-template-edit="required"
          checked={required}
          onChange={(e) => setRequired(e.currentTarget.checked)}
        />{" "}
        Required
      </label>
      <fieldset style={{ border: 0, padding: 0, display: "grid", gap: 2 }}>
        <legend style={{ fontSize: 11.5, fontWeight: 600 }}>
          A filler may also
        </legend>
        {EXTRA.map(([perm, title]) => (
          <label key={perm} style={{ fontSize: 11.5 }}>
            <input
              type="checkbox"
              data-template-allow={perm}
              checked={allow.includes(perm)}
              onChange={(e) =>
                setAllow(
                  e.currentTarget.checked
                    ? [...allow, perm]
                    : allow.filter((p) => p !== perm),
                )
              }
            />{" "}
            {title}
          </label>
        ))}
      </fieldset>
      <div style={{ display: "flex", gap: space[2] }}>
        <button type="button" data-template-save onClick={() => void save()}>
          {field ? "Save field" : "Make field"}
        </button>
        {policy ? (
          <button
            type="button"
            data-template-remove
            onClick={async () => onDone(await write(null))}
          >
            Remove field
          </button>
        ) : null}
      </div>
    </div>
  );
}

function DocumentDefaults({ version }: { version: unknown }): ReactElement {
  const client = useCanvasClient();
  const raw = useLabel("doc", version);
  const current = parse<{ defaults?: string[]; order?: string[] }>(raw) ?? {};
  const [message, setMessage] = useState<string | null>(null);
  const toggle = async (perm: string, on: boolean) => {
    const defaults = on
      ? [...(current.defaults ?? []), perm]
      : (current.defaults ?? []).filter((p) => p !== perm);
    const reply = await client.mutate({
      op: "setDocumentMetadata",
      args: { key: KEY, value: envelope({ ...current, defaults }) },
    } as never);
    setMessage(
      reply.kind === "mutationFailed" ? refusalText(reply.payload.error) : null,
    );
  };
  return (
    <section style={{ display: "grid", gap: space[1] }}>
      <h3 style={{ margin: 0, fontSize: 12 }}>Everywhere, a filler may</h3>
      {DOCUMENT.map(([perm, title]) => (
        <label key={perm} style={{ fontSize: 11.5 }}>
          <input
            type="checkbox"
            data-template-default={perm}
            checked={(current.defaults ?? []).includes(perm)}
            onChange={(e) => void toggle(perm, e.currentTarget.checked)}
          />{" "}
          {title}
        </label>
      ))}
      <StatusLine tone="error" attr="data-template-default-problem">
        {message}
      </StatusLine>
    </section>
  );
}

/** The Template panel. */
export function TemplatePanel(): ReactElement {
  const role = useSessionRole();
  const rows = useCollection<TemplateFieldSummary>("templateFields") ?? [];
  const { elementSelection } = useSelection();
  const model = useObjectModel();
  const [kinds, setKinds] = useState<readonly TemplateFieldKindInfo[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const objects = model?.objects as
    | { templateFieldKinds?(): Promise<readonly TemplateFieldKindInfo[]> }
    | undefined;
  useEffect(() => {
    let live = true;
    void objects?.templateFieldKinds?.().then((k) => {
      if (live) setKinds(k);
    });
    return () => {
      live = false;
    };
  }, [objects]);

  const selected = elementSelection.length === 1 ? elementSelection[0]! : null;
  const address = selected && model ? model.addressOf(selected) : null;
  const policy = parse<ItemPolicy>(useLabel(address, rows));

  return (
    <div
      data-template-panel
      style={{ display: "grid", gap: space[3], padding: space[3] }}
    >
      <RoleBar role={role} />
      <section style={{ display: "grid", gap: space[1] }}>
        <h3 style={{ margin: 0, fontSize: 12 }}>Fields</h3>
        {rows.length === 0 ? (
          <div
            data-template-fields-empty
            style={{ color: "var(--pg-muted-fg)", fontSize: 11.5 }}
          >
            No fields yet. Select an item and make it a field.
          </div>
        ) : (
          <ul style={{ margin: 0, paddingLeft: space[3], fontSize: 11.5 }}>
            {rows.map((r) => (
              <li key={r.field.name} data-template-field-row={r.field.name}>
                {r.field.label ?? r.field.name}{" "}
                <span style={{ color: "var(--pg-muted-fg)" }}>
                  {r.field.module?.kind ?? r.field.kind}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      {role === "author" ? (
        <section style={{ display: "grid", gap: space[2] }}>
          <h3 style={{ margin: 0, fontSize: 12 }}>Selected item</h3>
          {selected ? (
            <NamedAs name="Field">
              <FieldEditor
                key={`${selected.kind}:${selected.id}:${policy ? "f" : "n"}`}
                id={selected}
                policy={policy}
                kinds={kinds}
                onDone={setMessage}
              />
            </NamedAs>
          ) : (
            <div style={{ color: "var(--pg-muted-fg)", fontSize: 11.5 }}>
              Select one item to make it a field.
            </div>
          )}
          <StatusLine tone="error" attr="data-template-problem">
            {message}
          </StatusLine>
        </section>
      ) : null}
      {role === "author" ? <DocumentDefaults version={rows} /> : null}
    </div>
  );
}
