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

// File ▸ Open as template… (plan F5, engine ADR 1002): a document tagged for
// XML already says which of its parts are open. The dialog asks the engine
// which fields the tags describe, lists them (name, kind, what each one is)
// with the tags that cannot be fields and why, and, on confirmation, writes
// them as the template's policy in one undo step: each tagged range becomes
// a placeholder run its tag keeps wrapping. Writing a policy is the author's,
// so the dialog offers to take up authoring when the session is not.

import { useEffect, useState, useSyncExternalStore } from "react";
import type { CSSProperties, ReactElement } from "react";

import type {
  Derivation,
  DerivedField,
  TemplateFieldSummary,
} from "@paged-media/client";
import {
  createValueStore,
  FocusScope,
  scoped,
  scopeOf,
  useScoped,
  type EditorScope,
  useOptionalCanvasClient,
  useSessionRole,
  useSetSessionRole,
} from "@paged-media/shell";
import type {
  CommandContribution,
  MenuItemContribution,
} from "@paged-media/shell";
import { StatusLine, color, radius, refusalText } from "@paged-media/panel-kit";
import { defineMessages, t, useStrings } from "@paged-media/strings";

const M = defineMessages("app.openAsTemplate", {
  command: "Open as template…",
  title: "Open as template",
  intro:
    "The document's XML tags describe these fields. The ones you keep become the template's fields.",
  loading: "Reading the tags…",
  empty: "Nothing in this document is tagged as a field.",
  kindText: "Text",
  kindTextRun: "Text in a story",
  kindImage: "Picture",
  targetItem: "frame {id}",
  targetStory: "story of frame {id}",
  targetRange: "“{text}” in story {story}",
  targetPlaceholder: "placeholder {key} in story {story}",
  skipped: "{tag}: {reason}",
  authorOnly: "Writing a template's fields is the author's.",
  author: "Author template",
  answered: "The engine answered {kind}.",
  cancel: "Cancel",
  apply: "{count, plural, one {Make # field} other {Make # fields}}",
  statusNew: "new",
  statusSame: "already a field",
  statusChanged: "now a {kind} field",
  untagged:
    "{count, plural, one {Kept, though no tag names it:} other {Kept, though no tag names them:}}",
});

// The menu's segment and the command's category stay English (they are
// identities); the shell shows them through these messages.
defineMessages("menu", { "Open as template…": "Open as template…" });
defineMessages("commandCategory", { File: "File" });

export const OPEN_AS_TEMPLATE_COMMAND = "paged.template.openAsTemplate";

/** Whether the dialog is open, per editor (plan task E1). */
const OPEN = scoped("openAsTemplateDialog", () => createValueStore(false));

export function openAsTemplate(scope: EditorScope): void {
  scope.get(OPEN).set(true);
}

export const OPEN_AS_TEMPLATE_COMMANDS: CommandContribution[] = [
  {
    id: OPEN_AS_TEMPLATE_COMMAND,
    get title() {
      return t(M.command);
    },
    category: "File",
    handler: (paged) => openAsTemplate(scopeOf(paged)),
  },
];

export const OPEN_AS_TEMPLATE_MENU_ITEMS: MenuItemContribution[] = [
  {
    path: "File/Open as template…",
    command: OPEN_AS_TEMPLATE_COMMAND,
    order: 14,
    group: "open",
  },
];

const KIND_NAMES: Record<string, string> = {
  text: M.kindText,
  textRun: M.kindTextRun,
  image: M.kindImage,
};

/** What a derived field is, in words. */
export function targetText(
  f: DerivedField,
  tr: (key: string, params?: Record<string, string>) => string = t,
): string {
  const tg = f.target;
  switch (tg.kind) {
    case "item":
      return tr(M.targetItem, { id: tg.itemId });
    case "story":
      return tr(M.targetStory, { id: tg.frameId });
    case "range":
      return tr(M.targetRange, { text: tg.text, story: tg.storyId });
    case "placeholder":
      return tr(M.targetPlaceholder, { key: tg.key, story: tg.storyId });
  }
}

export function OpenAsTemplateDialog(): ReactElement | null {
  const store = useScoped(OPEN);
  const open = useSyncExternalStore(store.subscribe, store.get, store.get);
  return open ? <OpenAsTemplateForm /> : null;
}

function OpenAsTemplateForm(): ReactElement {
  const strings = useStrings();
  const client = useOptionalCanvasClient();
  const role = useSessionRole();
  const setRole = useSetSessionRole();
  const [derivation, setDerivation] = useState<Derivation | null>(null);
  // The fields the document has already: re-deriving lists what changes.
  const [existing, setExisting] = useState<readonly TemplateFieldSummary[]>([]);
  const [skipped, setSkipped] = useState<readonly string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const store = useScoped(OPEN);
  const close = () => store.set(false);

  useEffect(() => {
    let live = true;
    void client
      ?.derivedTemplateFields({
        includeNames: false,
        includePlaceholders: false,
      })
      .then((d) => {
        if (live) setDerivation(d);
      });
    void client?.templateFields().then((rows) => {
      if (live) setExisting(rows);
    });
    return () => {
      live = false;
    };
  }, [client]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") store.set(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [store]);

  const fields = derivation?.fields ?? [];
  const before = new Map(existing.map((r) => [r.field.name, r.field.kind]));
  const status = (f: DerivedField) => {
    const was = before.get(f.field.name);
    if (was === undefined) return strings.t(M.statusNew);
    if (was === f.field.kind) return strings.t(M.statusSame);
    return strings.t(M.statusChanged, {
      kind: KIND_NAMES[f.field.kind]
        ? strings.t(KIND_NAMES[f.field.kind]!)
        : f.field.kind,
    });
  };
  const derivedNames = new Set(fields.map((f) => f.field.name));
  const untagged = existing.filter((r) => !derivedNames.has(r.field.name));
  const chosen = fields
    .map((f) => f.field.name)
    .filter((n) => !skipped.includes(n));
  const apply = async () => {
    if (!client) return;
    const result = await client.openAsTemplate(
      { includeNames: false, includePlaceholders: false },
      chosen,
    );
    if (result.ok) return close();
    if ("problems" in result)
      return setMessage(result.problems.map((p) => p.problem).join("; "));
    const reply = result.reply as {
      kind: string;
      payload?: { error?: unknown };
    };
    setMessage(
      reply.kind === "mutationFailed" && reply.payload?.error
        ? refusalText(reply.payload.error as never)
        : strings.t(M.answered, { kind: reply.kind }),
    );
  };

  return (
    <div
      data-open-as-template-backdrop=""
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        display: "grid",
        placeItems: "center",
        background: "rgba(0,0,0,0.5)",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="open-as-template-title"
        data-open-as-template-dialog=""
        data-panel-host=""
        style={{
          width: "min(440px, 92vw)",
          padding: 16,
          borderRadius: radius.lg,
          border: `1px solid ${color.border}`,
          background: color.elevated,
          color: color.fg,
          boxShadow: "0 16px 48px rgba(0,0,0,0.5)",
        }}
      >
        <FocusScope trap autoFocus restoreFocus>
          <h2
            id="open-as-template-title"
            style={{ margin: "0 0 8px", fontSize: 14, fontWeight: 600 }}
          >
            {strings.t(M.title)}
          </h2>
          <p style={{ margin: "0 0 10px", fontSize: 11.5 }}>
            {strings.t(M.intro)}
          </p>
          {derivation === null ? (
            <div data-open-as-template-loading="" style={{ fontSize: 11.5 }}>
              {strings.t(M.loading)}
            </div>
          ) : fields.length === 0 ? (
            <div data-open-as-template-empty="" style={{ fontSize: 11.5 }}>
              {strings.t(M.empty)}
            </div>
          ) : (
            <ul
              style={{
                margin: 0,
                padding: 0,
                listStyle: "none",
                display: "grid",
                gap: 4,
                fontSize: 11.5,
              }}
            >
              {fields.map((f) => (
                <li
                  key={f.field.name}
                  data-open-as-template-field={f.field.name}
                >
                  <label>
                    <input
                      type="checkbox"
                      checked={!skipped.includes(f.field.name)}
                      onChange={(e) =>
                        setSkipped(
                          e.currentTarget.checked
                            ? skipped.filter((n) => n !== f.field.name)
                            : [...skipped, f.field.name],
                        )
                      }
                    />{" "}
                    <strong>{f.field.label ?? f.field.name}</strong>{" "}
                    <span style={{ color: color.mutedFg }}>
                      {KIND_NAMES[f.field.kind]
                        ? strings.t(KIND_NAMES[f.field.kind]!)
                        : f.field.kind}{" "}
                      — {targetText(f, strings.t)}
                    </span>{" "}
                    <span
                      data-open-as-template-status={f.field.name}
                      style={{ color: color.mutedFg, fontStyle: "italic" }}
                    >
                      ({status(f)})
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          {untagged.length ? (
            <div
              data-open-as-template-untagged=""
              style={{ margin: "8px 0 0", fontSize: 11 }}
            >
              {strings.t(M.untagged, { count: untagged.length })}{" "}
              {untagged.map((r) => r.field.label ?? r.field.name).join(", ")}
            </div>
          ) : null}
          {derivation?.skipped.length ? (
            <ul
              data-open-as-template-skipped=""
              style={{
                margin: "8px 0 0",
                paddingLeft: 16,
                fontSize: 11,
                color: color.mutedFg,
              }}
            >
              {derivation.skipped.map((s) => (
                <li key={s.elementId}>
                  {strings.t(M.skipped, { tag: s.tag, reason: s.reason })}
                </li>
              ))}
            </ul>
          ) : null}
          {role !== "author" ? (
            <div
              data-open-as-template-role=""
              style={{ marginTop: 10, fontSize: 11.5 }}
            >
              {strings.t(M.authorOnly)}{" "}
              {setRole ? (
                <button
                  type="button"
                  data-open-as-template-author=""
                  onClick={() => setRole("author")}
                >
                  {strings.t(M.author)}
                </button>
              ) : null}
            </div>
          ) : null}
          <StatusLine tone="error" attr="data-open-as-template-problem">
            {message}
          </StatusLine>
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: 8,
              marginTop: 14,
            }}
          >
            <button
              type="button"
              data-open-as-template-cancel=""
              onClick={close}
              style={secondaryStyle}
            >
              {strings.t(M.cancel)}
            </button>
            <button
              type="button"
              data-open-as-template-apply=""
              disabled={chosen.length === 0 || role !== "author"}
              onClick={() => void apply()}
              style={buttonStyle}
            >
              {strings.t(M.apply, { count: chosen.length })}
            </button>
          </div>
        </FocusScope>
      </div>
    </div>
  );
}

const buttonStyle: CSSProperties = {
  padding: "6px 14px",
  borderRadius: 7,
  fontSize: 12,
  cursor: "pointer",
  border: `1px solid ${color.border}`,
  background: color.primary,
  color: color.primaryFg,
};

const secondaryStyle: CSSProperties = {
  ...buttonStyle,
  background: "transparent",
  color: color.fg,
};
