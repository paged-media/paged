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
  TemplateFinding,
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
  useDocumentMeta,
  useObjectModel,
  useSelection,
  useSessionRole,
  useSetSessionRole,
} from "@paged-media/shell";
import { useStrings } from "@paged-media/strings";

import { PANEL, PREFLIGHT, findingText } from "./messages";

const KEY = "x-paged:template";

type Kind = "text" | "image" | "visibility" | "module";

/** What an author may let a filler do to an item beyond its field. */
const EXTRA: readonly [string, string][] = [
  ["text.style", PANEL.allowFormat],
  ["image.crop", PANEL.allowCrop],
  ["item.move", PANEL.allowMove],
  ["item.resize", PANEL.allowResize],
  ["item.rotate", PANEL.allowRotate],
  ["item.delete", PANEL.allowDelete],
  ["item.visibility", PANEL.allowShowHide],
  ["appearance.fill", PANEL.allowFill],
  ["appearance.stroke", PANEL.allowStroke],
];

/** What a filler may do everywhere (the document's defaults). */
const DOCUMENT: readonly [string, string][] = [
  ["select", PANEL.everywhereSelect],
  ["document.pages", PANEL.everywherePages],
  ["document.add-item", PANEL.everywhereAdd],
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

/** A field's name as an XML tag name: letters, digits, `_`, `-` and `.`,
 *  not starting with a digit, `-`, `.` or "xml". */
export function tagNameFor(name: string): string {
  const cleaned = name.trim().replace(/[^\p{L}\p{N}_.-]+/gu, "_");
  return /^(?:[\p{N}.-]|xml)/iu.test(cleaned) || !cleaned
    ? `_${cleaned}`
    : cleaned;
}

/** Engine ADR 1002 — the mutations that tag a field's item after the field
 *  and mirror its metadata as the attributes derive reads back. */
export function tagOps(
  item: string,
  field: NonNullable<ItemPolicy["field"]>,
): unknown[] {
  const attribute = (name: string, value: string | undefined) => ({
    op: "setXmlAttribute",
    args: { element: item, name, value: value ?? null },
  });
  return [
    { op: "tagItem", args: { item, tag: tagNameFor(field.name) } },
    attribute("label", field.label),
    attribute("maxLength", field.constraints?.maxLength?.toString()),
    attribute("required", field.required ? "true" : undefined),
  ];
}

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

/** `text` as JSON, or undefined when it is not JSON. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
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
  const strings = useStrings();
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
      ? strings.t(PANEL.lineAuthor)
      : role === "filler"
        ? strings.t(PANEL.lineFiller)
        : strings.t(PANEL.lineEditor);
  return (
    <div style={{ display: "grid", gap: space[2] }}>
      <div style={{ fontSize: 11.5 }} data-template-role-line={role}>
        {line}
      </div>
      <div style={{ display: "flex", gap: space[2], flexWrap: "wrap" }}>
        {role === "author"
          ? switchTo("filler", strings.t(PANEL.previewAsFiller), "preview")
          : null}
        {role === "filler"
          ? switchTo("author", strings.t(PANEL.backToAuthoring), "author")
          : null}
        {role === "editor"
          ? switchTo("author", strings.t(PANEL.authorTemplate), "author")
          : null}
        {role === "author"
          ? switchTo("editor", strings.t(PANEL.stopAuthoring), "editor")
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
  const strings = useStrings();
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
    if (!trimmed) return onDone(strings.t(PANEL.needsName));
    const parsedDef = kind === "module" ? parseJson(def || "{}") : null;
    if (parsedDef === undefined) return onDone(strings.t(PANEL.badDefinition));
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
    // One batch, one undo step: the policy; the item's name, as InDesign's
    // script label would carry it, so the name survives a round trip; and
    // (engine ADR 1002) a text or picture field's XML tag, named after the
    // field, with the metadata a tag-based tool reads.
    const tagged = kind === "text" || kind === "image";
    const reply = await client.mutate({
      op: "batch",
      args: {
        ops: [
          {
            op: "setPluginMetadata",
            args: { elementId: id, key: KEY, value: envelope(next) },
          },
          {
            op: "setElementProperty",
            args: {
              elementId: id,
              path: "itemName",
              value: { type: "text", value: trimmed },
            },
          },
          ...(tagged ? tagOps(String(id.id), next.field!) : []),
        ],
      },
    } as never);
    onDone(
      reply.kind === "mutationFailed" ? refusalText(reply.payload.error) : null,
    );
  };

  const remove = async () => {
    const refused = await write(null);
    // The item's tag goes with its field (the tag's definition stays).
    if (!refused)
      await client.mutate({
        op: "untagItem",
        args: { item: String(id.id) },
      } as never);
    onDone(refused);
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
      {row(strings.t(PANEL.name), text(name, setName, "name"))}
      {row(strings.t(PANEL.label), text(label, setLabel, "label"))}
      {row(
        strings.t(PANEL.kind),
        <select
          data-template-edit="kind"
          value={kind}
          onChange={(e) => setKind(e.currentTarget.value as Kind)}
        >
          <option value="text">{strings.t(PANEL.kindText)}</option>
          <option value="image">{strings.t(PANEL.kindPicture)}</option>
          <option value="visibility">{strings.t(PANEL.kindVisibility)}</option>
          {kinds.length ? (
            <option value="module">{strings.t(PANEL.kindModule)}</option>
          ) : null}
        </select>,
      )}
      {kind === "text"
        ? row(
            strings.t(PANEL.longestText),
            text(maxLength, setMaxLength, "maxLength", "number"),
          )
        : null}
      {kind === "module"
        ? row(
            strings.t(PANEL.moduleField),
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
        ? row(strings.t(PANEL.definition), text(def, setDef, "def"))
        : null}
      {row(strings.t(PANEL.group), text(group, setGroup, "group"))}
      {row(strings.t(PANEL.help), text(help, setHelp, "help"))}
      <label style={{ fontSize: 11.5 }}>
        <input
          type="checkbox"
          data-template-edit="required"
          checked={required}
          onChange={(e) => setRequired(e.currentTarget.checked)}
        />{" "}
        {strings.t(PANEL.required)}
      </label>
      <fieldset style={{ border: 0, padding: 0, display: "grid", gap: 2 }}>
        <legend style={{ fontSize: 11.5, fontWeight: 600 }}>
          {strings.t(PANEL.fillerMayAlso)}
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
            {strings.t(title)}
          </label>
        ))}
      </fieldset>
      <div style={{ display: "flex", gap: space[2] }}>
        <button type="button" data-template-save onClick={() => void save()}>
          {field ? strings.t(PANEL.saveField) : strings.t(PANEL.makeField)}
        </button>
        {policy ? (
          <button
            type="button"
            data-template-remove
            onClick={() => void remove()}
          >
            {strings.t(PANEL.removeField)}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function DocumentDefaults({ version }: { version: unknown }): ReactElement {
  const strings = useStrings();
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
      <h3 style={{ margin: 0, fontSize: 12 }}>{strings.t(PANEL.everywhere)}</h3>
      {DOCUMENT.map(([perm, title]) => (
        <label key={perm} style={{ fontSize: 11.5 }}>
          <input
            type="checkbox"
            data-template-default={perm}
            checked={(current.defaults ?? []).includes(perm)}
            onChange={(e) => void toggle(perm, e.currentTarget.checked)}
          />{" "}
          {strings.t(title)}
        </label>
      ))}
      <StatusLine tone="error" attr="data-template-default-problem">
        {message}
      </StatusLine>
    </section>
  );
}

/** The page's own policy (data ADR 560): whether a filler may copy the
 *  page and remove its copies, as a catalogue's pages need. */
function PageGrant({ version }: { version: unknown }): ReactElement | null {
  const strings = useStrings();
  const client = useCanvasClient();
  const meta = useDocumentMeta();
  const pages = useCollection<{ selfId: string }>("pages");
  // The page in view; the first page where nothing reports one.
  const page = meta?.activePage ?? pages?.[0]?.selfId ?? null;
  const raw = useLabel(page ? `page:${page}` : null, version);
  const [message, setMessage] = useState<string | null>(null);
  if (!page) return null;
  const current = parse<{ allow?: string[]; deny?: string[] }>(raw) ?? {};
  const allow = current.allow ?? [];
  const open = allow.includes("document.pages");
  const toggle = async (on: boolean) => {
    const next = {
      ...current,
      allow: on
        ? [...allow, "document.pages"]
        : allow.filter((p) => p !== "document.pages"),
    };
    const reply = await client.mutate({
      op: "setPageMetadata",
      args: { page, key: KEY, value: envelope(next) },
    } as never);
    setMessage(
      reply.kind === "mutationFailed" ? refusalText(reply.payload.error) : null,
    );
  };
  return (
    <section style={{ display: "grid", gap: space[1] }}>
      <h3 style={{ margin: 0, fontSize: 12 }}>{strings.t(PANEL.thisPage)}</h3>
      <label style={{ fontSize: 11.5 }}>
        <input
          type="checkbox"
          data-template-page-copies
          checked={open}
          onChange={(e) => void toggle(e.currentTarget.checked)}
        />{" "}
        {strings.t(PANEL.pageCopies)}
      </label>
      <StatusLine tone="error" attr="data-template-page-problem">
        {message}
      </StatusLine>
    </section>
  );
}

/** What is wrong with the template before anyone fills it (plan F3). */
function Problems(): ReactElement | null {
  const strings = useStrings();
  const findings = useCollection<TemplateFinding>("templateFindings");
  if (findings === null) return null;
  return (
    <section data-template-problems style={{ display: "grid", gap: space[1] }}>
      <h3 style={{ margin: 0, fontSize: 12 }}>
        {strings.t(PREFLIGHT.heading)}
      </h3>
      {findings.length === 0 ? (
        <div style={{ color: "var(--pg-muted-fg)", fontSize: 11.5 }}>
          {strings.t(PREFLIGHT.none)}
        </div>
      ) : (
        <ul style={{ margin: 0, paddingLeft: space[3], fontSize: 11.5 }}>
          {findings.map((f, i) => (
            <li
              key={`${f.code}:${f.item ?? ""}:${i}`}
              data-template-problem-code={f.code}
              style={{
                color:
                  f.severity === "error"
                    ? "var(--status-error, #d92d20)"
                    : "var(--status-warn, #b54708)",
              }}
            >
              {findingText(strings, f)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The Template panel. */
export function TemplatePanel(): ReactElement {
  const strings = useStrings();
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
        <h3 style={{ margin: 0, fontSize: 12 }}>{strings.t(PANEL.fields)}</h3>
        {rows.length === 0 ? (
          <div
            data-template-fields-empty
            style={{ color: "var(--pg-muted-fg)", fontSize: 11.5 }}
          >
            {strings.t(PANEL.noFields)}
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
          <h3 style={{ margin: 0, fontSize: 12 }}>
            {strings.t(PANEL.selectedItem)}
          </h3>
          {selected ? (
            <NamedAs name={strings.t(PANEL.field)}>
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
              {strings.t(PANEL.selectOne)}
            </div>
          )}
          <StatusLine tone="error" attr="data-template-problem">
            {message}
          </StatusLine>
        </section>
      ) : null}
      {role === "author" ? <Problems /> : null}
      {role === "author" ? <PageGrant version={rows} /> : null}
      {role === "author" ? <DocumentDefaults version={rows} /> : null}
    </div>
  );
}
