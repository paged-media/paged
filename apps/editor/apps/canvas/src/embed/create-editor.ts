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

// The embedding API (docs/composable-editor.md §8; plan task E3):
// `createEditor(element, config)` mounts an editor into a host's element and
// resolves, once the shell, its bundles and the first document are up, to a
// handle the host drives it by. Every write goes through the same doors the
// editor's own UI uses, so a filler's handle can change only what the
// template permits.

import type {
  CanvasClient,
  ExportPdfWireOptions,
  Role,
  TemplateFieldProblem,
  TemplateFieldSummary,
  TemplateFieldValue,
} from "@paged-media/client";
import {
  memoryStorage,
  mintBlankDocument,
  noStorage,
  pageStorage,
  type StorageAdapter,
  openDocumentFile,
  type EditorProfile,
  type FeatureId,
  type FeatureStore,
  type IdAliases,
  type IdDeprecation,
  type ShellObjectsSurface,
} from "@paged-media/shell";
import { loadLocale } from "@paged-media/strings";

import type { HostActions, ShellAccess } from "../app/instance";
import { assertEmbeddable } from "./errors";

/** A field's value, as the handle takes and gives it. */
export type FieldValue = TemplateFieldValue["value"];

export interface EditorConfig {
  /** A preset id (`template-fill`, `viewer`, `solo:draw`, …) or a profile. */
  profile?: string | EditorProfile;
  /** The session's role; overrides the profile's. */
  role?: Role;
  /** The document to open: a `.paged`, `.idml` or template. */
  document?: { bytes: Uint8Array; name?: string };
  /** What the host decides: save, submit, close, back. */
  actions?: HostActions;
  /** Field values to set once the document is open. */
  values?: Readonly<Record<string, FieldValue | string | boolean>>;
  /** The language of the editor's words (`de`); English by default. */
  locale?: string;
  /** The locale's catalogue, when the host supplies it; else the editor's
   *  own, else `<assetBase>/locales/<locale>.json`. */
  messages?: Readonly<Record<string, string>>;
  /** Where the editor's files are served from (locales). */
  assetBase?: string;
  /**
   * Where the engine's wasm is served (`paged_canvas_wasm_bg.wasm` of
   * `@paged-media/paged`). The editor's own build when absent; the
   * `@paged-media/editor` package fills it from its dependency (PM-0013).
   */
  engineWasm?: string;
  /**
   * Where the editor keeps its settings (theme, workflow mode, dock tabs,
   * palette recents, export options, remembered grants): `"memory"` (the
   * default) for this editor's lifetime only, so an embedded editor never
   * reads or writes the host's origin storage unasked; `"local"` the
   * page's `localStorage`, under the editor's own keys; `"none"` nothing
   * kept; or the host's own store (Web Storage's getItem / setItem /
   * removeItem).
   */
  storage?: "local" | "memory" | "none" | EditorStorage;
}

/** A host's settings store for the editor (`EditorConfig.storage`). */
export type EditorStorage = StorageAdapter;

function storageOf(choice: EditorConfig["storage"]): StorageAdapter {
  if (choice === "local") return pageStorage();
  if (choice === "none") return noStorage();
  if (choice === undefined || choice === "memory") return memoryStorage();
  return choice;
}

export type EditorEvent =
  | { type: "ready" }
  | { type: "change" }
  | { type: "fieldChange"; fields: readonly TemplateFieldSummary[] }
  | ({ type: "idDeprecated" } & IdDeprecation);

export interface EditorHandle {
  /** Open a document (replaces the open one). */
  load(document: { bytes: Uint8Array; name?: string }): Promise<void>;
  /** Start a blank one-page document of this size, in points. */
  newDocument(widthPt: number, heightPt: number): Promise<void>;
  /** The open document as `.paged` bytes. */
  save(): Promise<Uint8Array>;
  /** The open document as a PDF. */
  exportPdf(options?: ExportPdfWireOptions): Promise<Uint8Array>;
  /** The template's fields, in form order, with their values. */
  fields(): Promise<readonly TemplateFieldSummary[]>;
  /**
   * The editor's look: its dark or light theme, and design tokens
   * (`--paged-*`, `--chrome-*`, … from apps/editor/docs/theme-tokens.json)
   * the host overrides with its brand. A token set to null returns to the
   * editor's own. Both are set on the editor's root element
   * (`[data-paged-editor]`), never on the host's page.
   */
  setTheme(theme: {
    mode?: "dark" | "light";
    tokens?: Readonly<Record<string, string | null>>;
  }): void;
  /** The template's values by field name. */
  getFieldValues(): Promise<Record<string, FieldValue>>;
  /** Fill fields: one undo step, checked against the session's role. */
  setFieldValues(
    values: Readonly<Record<string, FieldValue | string | boolean>>,
  ): Promise<
    { ok: true } | { ok: false; problems: readonly TemplateFieldProblem[] }
  >;
  /** Change the session's role (the engine's and the UI's). */
  setRole(role: Role): Promise<void>;
  /** Switch features on and off (ids from `feature-ids.json`; a deprecated
   *  id is read as its replacement, PM-0013, amendment 2). */
  readonly features: FeatureStore;
  /** Listen; returns the unsubscribe. `idDeprecated` reaches every
   *  listener, for the old ids met before it subscribed too (the config's
   *  profile). */
  on(listener: (event: EditorEvent) => void): () => void;
  /**
   * The element a profile's `{ kind: "host", id }` region item leaves for
   * the host (concept §8.4): the host renders its own component into it.
   * Null until the region is rendered, or when the profile has no such item.
   */
  hostSlot(id: string): HTMLElement | null;
  /** The engine client, for what the handle does not cover. */
  readonly client: CanvasClient;
  /** The object model the loaded modules contribute to: their typed
   *  commands (`invoke`, `commands`) and objects, for what the handle does
   *  not cover (paged.publish's PDF preflight and exporter, say). */
  readonly objects: ShellObjectsSurface;
  /** Unmount the editor and release its worker. */
  dispose(): void;
}

function toValues(
  values: Readonly<Record<string, FieldValue | string | boolean>>,
): TemplateFieldValue[] {
  return Object.entries(values).map(([name, v]) => ({
    name,
    value:
      typeof v === "string"
        ? { kind: "text", text: v }
        : typeof v === "boolean"
          ? { kind: "visible", visible: v }
          : v,
  }));
}

const DOCUMENT_KINDS = new Set([
  "mutationApplied",
  "undoApplied",
  "redoApplied",
  "documentLoaded",
]);

/** The feature store with a host's deprecated ids read as their
 *  replacements (PM-0013, amendment 2); an id with none switches nothing. */
export function aliasedFeatures(
  store: FeatureStore,
  aliases: IdAliases,
): FeatureStore {
  const map = (p: FeatureId | readonly FeatureId[]): FeatureId[] =>
    (typeof p === "string" ? [p] : [...p]).flatMap((id) => {
      const next = aliases.feature(id);
      return next === null ? [] : [next];
    });
  return {
    ...store,
    enable: (p) => store.set(map(p), true),
    disable: (p) => store.set(map(p), false),
    set: (p, rule) => store.set(map(p), rule),
    reset(p) {
      const [next] = map(p);
      if (next) store.reset(next);
    },
    isEnabled(id) {
      const next = aliases.feature(id);
      return next === null ? true : store.isEnabled(next);
    },
    allows: (kind, id) => {
      const next = aliases.feature(`${kind}:${id}`);
      return next === null ? true : store.isEnabled(next);
    },
  };
}

/**
 * Mount an editor into `element` and resolve to its handle. On a page that
 * is not cross-origin isolated it mounts nothing and rejects with an
 * `EditorError` of code `notCrossOriginIsolated` (decision 1 of 2026-10-24:
 * no degraded mode; the iframe is the path for such a host).
 */
export async function createEditor(
  element: HTMLElement,
  config: EditorConfig = {},
): Promise<EditorHandle> {
  assertEmbeddable();
  const preset = config.profile ?? "full";
  const profile: EditorProfile =
    typeof preset === "string"
      ? { extends: preset, ...(config.role ? { role: config.role } : {}) }
      : { ...preset, ...(config.role ? { role: config.role } : {}) };
  const { strings, problem } = await loadLocale(config.locale ?? "en", {
    ...(config.messages ? { messages: config.messages } : {}),
    ...(config.assetBase ? { assetBase: config.assetBase } : {}),
  });
  if (problem) console.warn(`createEditor: ${problem}`);
  // Loaded once the page is known to run it: a refused page loads nothing.
  const { mountEditor } = await import("../main");
  let resolveShell!: (shell: ShellAccess) => void;
  const shellReady = new Promise<ShellAccess>((r) => (resolveShell = r));
  const mounted = mountEditor(element, {
    profile,
    actions: config.actions ?? {},
    library: false,
    strings,
    onShell: (shell) => resolveShell(shell),
    ...(config.engineWasm ? { engineWasm: config.engineWasm } : {}),
    storage: storageOf(config.storage),
  });
  const shell = await shellReady;
  await mounted.instance.services.boot.settled();
  const { client, paged, registries } = shell;
  const aliases = mounted.instance.idAliases;

  const listeners = new Set<(event: EditorEvent) => void>();
  const themed = new Set<string>();
  const emit = (event: EditorEvent) => {
    for (const l of [...listeners]) l(event);
  };
  const offAliases = aliases.subscribe((d) =>
    emit({ type: "idDeprecated", ...d }),
  );
  let lastFields = "";
  const offClient = client.subscribe((msg) => {
    if (!DOCUMENT_KINDS.has(msg.kind)) return;
    emit({ type: "change" });
    void client.templateFields().then((rows) => {
      const key = JSON.stringify(rows.map((r) => [r.field.name, r.value]));
      if (key === lastFields) return;
      lastFields = key;
      emit({ type: "fieldChange", fields: rows });
    });
  });

  const sinks = {
    setStatus: () => {},
    pushWarning: (w: string) => console.warn(`[paged editor] ${w}`),
  };

  const handle: EditorHandle = {
    async load(document) {
      const name = document.name ?? "document.paged";
      await openDocumentFile(
        paged,
        new File([document.bytes.slice()], name),
        sinks,
      );
    },
    async newDocument(widthPt, heightPt) {
      await mintBlankDocument(paged, [widthPt, heightPt], sinks);
    },
    save: () => client.exportPaged(),
    async exportPdf(options = {}) {
      const r = await client.exportPdf(options);
      return r.bytes;
    },
    fields: () => client.templateFields(),
    async getFieldValues() {
      const out: Record<string, FieldValue> = {};
      for (const row of await client.templateFields()) {
        if (row.value) out[row.field.name] = row.value;
      }
      return out;
    },
    async setFieldValues(values) {
      const result = await client.setTemplateFields(toValues(values));
      if (result.ok) return { ok: true };
      if ("problems" in result) return { ok: false, problems: result.problems };
      const reply = result.reply;
      const problem =
        reply.kind === "mutationFailed"
          ? JSON.stringify(reply.payload.error)
          : reply.kind;
      return { ok: false, problems: [{ name: "*", problem }] };
    },
    async setRole(role) {
      mounted.instance.role.set(role);
      await client.setSessionPolicy({ role, overrides: [] });
    },
    features: aliasedFeatures(registries.features, aliases),
    on(listener) {
      listeners.add(listener);
      // Sticky: the old ids met before this listener (the config's profile).
      const past = [...aliases.used()];
      if (past.length)
        queueMicrotask(() => {
          if (!listeners.has(listener)) return;
          for (const d of past) listener({ type: "idDeprecated", ...d });
        });
      return () => listeners.delete(listener);
    },
    setTheme({ mode, tokens }) {
      if (mode) shell.setThemeMode(mode);
      // On the editor's root element: its popovers and floating panels
      // portal inside it and read the same tokens; the host's page keeps
      // its own.
      const root = shell.root.style;
      for (const [name, value] of Object.entries(tokens ?? {})) {
        if (!name.startsWith("--"))
          throw new Error(`setTheme: "${name}" is not a token (--name)`);
        if (value === null) {
          root.removeProperty(name);
          themed.delete(name);
        } else {
          root.setProperty(name, value);
          themed.add(name);
        }
      }
    },
    hostSlot: (id) =>
      element.querySelector<HTMLElement>(
        `[data-host-component="${CSS.escape(id)}"]`,
      ),
    client,
    objects: mounted.instance.services.objects.model.objects,
    dispose() {
      offClient();
      offAliases();
      listeners.clear();
      for (const name of themed) shell.root.style.removeProperty(name);
      mounted.dispose();
    },
  };

  if (config.document) await handle.load(config.document);
  if (config.values) await handle.setFieldValues(config.values);
  emit({ type: "ready" });
  return handle;
}
