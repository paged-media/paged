// createBundleHost — the in-process implementation of the BundleHost
// contract. Lives in the SDK (not the editor) so the contract's
// implementation is versioned with its types (DESIGN.md §3); the
// editor's only job is one `loadBundle()` call per bundle. The
// isolate migration is a SECOND implementation of the same interface
// (an RPC proxy), not an editor refactor.
//
// A pure function over the editor handle: no imports from
// `@paged-media/shell`/`client` at VALUE level — everything arrives
// via `getEditor()`, resolved at call time (the command registry's
// thunk idiom, avoids stale-closure drift).

import type {
  BundleHost,
  ContributionSurface,
  Diagnostic,
  DiagnosticsSurface,
  Disposable,
  DocumentChangeEvent,
  DocumentSurface,
  ElementId,
  HitFilter,
  HitResult,
  Mutation,
  MutationOutcome,
  OverlaySurface,
  PagedEditor,
  PluginLogger,
  PluginManifest,
  PluginMetadataEnvelope,
  SceneTreeNode,
  SelectionMode,
  SelectionSurface,
  ShellSurface,
  StorageSurface,
  ViewportSurface,
} from "@paged-media/plugin-api";

import { DisposableStore, toDisposable } from "./disposables";

/** The implemented feature set — `host.supports()` answers from this,
 *  so docs/tests can't drift from code. Form: `"area.member@major"`. */
export const HOST_FEATURES: readonly string[] = [
  "contribute.tool@1",
  "contribute.panel@1",
  "contribute.command@1",
  "contribute.keybinding@1",
  "contribute.overlay@1",
  "document.mutate@1",
  "document.undo@1",
  "document.collection@1",
  "document.meta@1",
  "document.pathAnchors@1",
  "document.hitTest@1",
  "document.elementGeometry@1",
  "document.tree@1",
  "document.onDidChange@1",
  "document.getMetadata@1",
  "document.setMetadata@1",
  "selection@1",
  "viewport@1",
  "overlay.toolPreview@1",
  "storage@1",
  "diagnostics@1",
];

/** Thrown by reserved surface members — a visible seam, never
 *  fake-interactive. */
export class PluginApiNotImplemented extends Error {
  constructor(member: string, pointer: string) {
    super(
      `plugin-api: ${member} is reserved and not implemented in v0 (${pointer})`,
    );
    this.name = "PluginApiNotImplemented";
  }
}

/** Minimal storage backing so tests / headless hosts can inject one;
 *  defaults to localStorage when present, else an in-memory Map. */
export interface StorageBacking {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  /** All keys currently in the backing (unfiltered). */
  keys(): string[];
}

function defaultStorageBacking(): StorageBacking {
  const ls = (globalThis as { localStorage?: Storage }).localStorage;
  if (ls) {
    return {
      getItem: (k) => ls.getItem(k),
      setItem: (k, v) => ls.setItem(k, v),
      removeItem: (k) => ls.removeItem(k),
      keys: () => {
        const out: string[] = [];
        for (let i = 0; i < ls.length; i++) {
          const k = ls.key(i);
          if (k !== null) out.push(k);
        }
        return out;
      },
    };
  }
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    keys: () => Array.from(map.keys()),
  };
}

export interface CreateBundleHostOptions {
  storage?: StorageBacking;
  /** Console sink override (tests). */
  console?: Pick<Console, "debug" | "info" | "warn" | "error">;
  /** Shell actions the HOST APP owns (the cockpit's panel placement).
   *  When absent, `host.shell` warns and no-ops, and
   *  `supports("shell.openPanel@1")` answers false. */
  shell?: ShellSurface;
}

export interface BundleHostHandle {
  host: BundleHost;
  /** Tears down every registration made through the host's facades. */
  dispose(): void;
}

export function createBundleHost(
  getEditor: () => PagedEditor,
  manifest: PluginManifest,
  options?: CreateBundleHostOptions,
): BundleHostHandle {
  const store = new DisposableStore();
  const sink = options?.console ?? console;
  const ns = `${manifest.id}.`;
  const tag = `[${manifest.id}]`;

  // Plugin-metadata namespace — the FULL manifest id (not a
  // shortname) so third-party ids can never collide:
  // "x-paged:paged.web", "x-paged:acme.charts".
  const metadataKey = (m: PluginManifest) => `x-paged:${m.id}`;

  const assertNamespaced = (id: string, kind: string): void => {
    if (!id.startsWith(ns)) {
      throw new Error(
        `plugin-api: ${kind} id "${id}" must be namespaced under "${ns}" ` +
          `(the manifest id) — the namespace rule is where capability ` +
          `enforcement attaches`,
      );
    }
  };

  const log: PluginLogger = {
    debug: (m, ...a) => sink.debug(`${tag} ${m}`, ...a),
    info: (m, ...a) => sink.info(`${tag} ${m}`, ...a),
    warn: (m, ...a) => sink.warn(`${tag} ${m}`, ...a),
    error: (m, ...a) => sink.error(`${tag} ${m}`, ...a),
  };

  // ---------------------------------------------------- contribute
  const contribute: ContributionSurface = {
    tool(c) {
      assertNamespaced(c.id, "tool");
      return store.add(getEditor().registries.tools.register(c));
    },
    panel(c) {
      assertNamespaced(c.id, "panel");
      return store.add(getEditor().registries.panels.register(c));
    },
    command(c) {
      assertNamespaced(c.id, "command");
      return store.add(getEditor().registries.commands.register(c));
    },
    keybinding(c) {
      return store.add(getEditor().registries.keybindings.register(c));
    },
    overlay(c) {
      assertNamespaced(c.id, "overlay");
      return store.add(getEditor().registries.overlays.register(c));
    },
    editContext() {
      throw new PluginApiNotImplemented(
        "contribute.editContext",
        "P0 shell work — plugin-draw/BREAKAGE_LOG.md B-02",
      );
    },
    objectType() {
      throw new PluginApiNotImplemented(
        "contribute.objectType",
        "paged.web W1 — base-idea §9.1.2",
      );
    },
  };

  // ------------------------------------------------------ document
  /** The namespace rule at the WRITE chokepoint: a raw mutate may
   *  carry setPluginMetadata (incl. nested in batches — e.g. the
   *  v34 batch-created-sentinel insert flow), but only for THIS
   *  plugin's derived key. Returns the offending key, or null. */
  const foreignMetadataKey = (m: Mutation): string | null => {
    if (m.op === "setPluginMetadata") {
      return m.args.key === metadataKey(manifest) ? null : m.args.key;
    }
    if (m.op === "batch") {
      for (const child of m.args.ops) {
        const bad = foreignMetadataKey(child);
        if (bad !== null) return bad;
      }
    }
    return null;
  };
  const document: DocumentSurface = {
    async mutate(mutation: Mutation): Promise<MutationOutcome> {
      const foreign = foreignMetadataKey(mutation);
      if (foreign !== null) {
        const error = `setPluginMetadata key "${foreign}" is outside this plugin's namespace ("${metadataKey(manifest)}")`;
        log.warn(error);
        return { applied: false, error };
      }
      try {
        const reply = await getEditor().client.mutate(mutation);
        if (reply.kind === "mutationApplied") {
          return {
            applied: true,
            createdId: reply.payload.createdId ?? null,
            pageIds: reply.payload.pageIds,
          };
        }
        return {
          applied: false,
          error:
            reply.kind === "mutationFailed"
              ? (reply as { payload?: unknown }).payload
              : reply,
        };
      } catch (error) {
        return { applied: false, error };
      }
    },
    async undo() {
      await getEditor().client.undo();
    },
    async redo() {
      await getEditor().client.redo();
    },
    collection(name) {
      return getEditor().client.collection(name);
    },
    meta() {
      return getEditor().client.documentMeta();
    },
    pathAnchors(id: ElementId) {
      return getEditor()
        .client.pathAnchors(id)
        .catch(() => null);
    },
    async hitTest(
      pageId,
      point,
      filter: HitFilter = "any",
    ): Promise<HitResult | null> {
      try {
        const reply = await getEditor().client.send({
          kind: "hitTest",
          payload: { pageId, docPoint: point, filter },
        });
        return reply.kind === "hitResult" ? reply.payload : null;
      } catch {
        return null;
      }
    },
    elementGeometry(ids) {
      return getEditor().client.elementGeometry(ids);
    },
    async tree(): Promise<SceneTreeNode[]> {
      const reply = await getEditor().client.send({
        kind: "requestSceneTree",
      });
      return reply.kind === "sceneTree" ? reply.payload.roots : [];
    },
    async getMetadata(id) {
      const key = metadataKey(manifest);
      const reply = await getEditor().client.send({
        kind: "requestElementProperties",
        payload: { id },
      });
      if (reply.kind !== "elementProperties" || !reply.payload.result) {
        return null;
      }
      for (const entry of reply.payload.result.entries) {
        const v = entry.value;
        if (
          v &&
          typeof v === "object" &&
          v.type === "pluginMetadata" &&
          v.value.key === key &&
          typeof v.value.value === "string"
        ) {
          try {
            return JSON.parse(v.value.value) as PluginMetadataEnvelope;
          } catch {
            return null; // engine-gated on write; treat corrupt as absent
          }
        }
      }
      return null;
    },
    async setMetadata(id, envelope) {
      // The plugin's OWN namespace only — the key is derived, never
      // caller-supplied (the engine additionally gates the prefix,
      // the 64 KiB cap and the envelope shape).
      return this.mutate({
        op: "setPluginMetadata",
        args: {
          elementId: id,
          key: metadataKey(manifest),
          value: envelope === null ? null : JSON.stringify(envelope),
        },
      });
    },
    onDidChange(listener: (e: DocumentChangeEvent) => void): Disposable {
      const off = getEditor().client.subscribe((msg) => {
        if (
          msg.kind === "mutationApplied" ||
          msg.kind === "undoApplied" ||
          msg.kind === "redoApplied"
        ) {
          listener({ kind: msg.kind, pageIds: msg.payload.pageIds });
        }
      });
      return store.add(toDisposable(off));
    },
  };

  // ----------------------------------------------------- selection
  const selection: SelectionSurface = {
    get() {
      return getEditor().selection.elementSelection;
    },
    async set(ids: ElementId[], mode: SelectionMode = "replace") {
      const editor = getEditor();
      const applied = await editor.client.setElementSelection(ids, mode);
      editor.selection.setElementSelection(applied);
      return applied;
    },
    onDidChange(listener) {
      const off = getEditor().client.subscribe((msg) => {
        if (msg.kind === "elementSelectionApplied") {
          listener(msg.payload.ids);
        }
      });
      return store.add(toDisposable(off));
    },
  };

  // ------------------------------------------------------ viewport
  const viewport: ViewportSurface = {
    camera() {
      const cam = getEditor().camera.camera;
      return { scale: cam.scale, tx: cam.tx, ty: cam.ty };
    },
    pxToPt(px: number) {
      const scale = getEditor().camera.camera.scale;
      return px / (scale > 0 ? scale : 1);
    },
  };

  // ------------------------------------------------------- overlay
  const overlay: OverlaySurface = {
    setToolPreview(shape) {
      getEditor().overlaySignals.setToolPreview(shape);
    },
  };

  // ------------------------------------------------------- storage
  const backing = options?.storage ?? defaultStorageBacking();
  const prefix = `paged.plugin.${manifest.id}.`;
  const storage: StorageSurface = {
    get<T>(key: string): T | undefined {
      const raw = backing.getItem(prefix + key);
      if (raw === null) return undefined;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return undefined;
      }
    },
    set(key, value) {
      backing.setItem(prefix + key, JSON.stringify(value));
    },
    delete(key) {
      backing.removeItem(prefix + key);
    },
    keys() {
      return backing
        .keys()
        .filter((k) => k.startsWith(prefix))
        .map((k) => k.slice(prefix.length));
    },
  };

  // --------------------------------------------------- diagnostics
  const diagnosticStore = new Map<string, Diagnostic[]>();
  const diagnosticListeners = new Set<(key: string) => void>();
  const emitDiagnostics = (key: string) => {
    for (const l of diagnosticListeners) l(key);
  };
  const diagnostics: DiagnosticsSurface = {
    set(key, items) {
      diagnosticStore.set(key, items);
      // Console mirror — the v0 problems panel.
      for (const d of items) {
        const line = `${tag} ${key}: ${d.message}` +
          (d.line !== undefined ? ` (${d.source ?? ""}:${d.line})` : "");
        if (d.severity === "error") sink.error(line);
        else if (d.severity === "warning") sink.warn(line);
        else sink.info(line);
      }
      emitDiagnostics(key);
    },
    clear(key) {
      if (key !== undefined) diagnosticStore.delete(key);
      else diagnosticStore.clear();
      emitDiagnostics(key ?? "");
    },
    get(key) {
      return diagnosticStore.get(key) ?? [];
    },
    onDidChange(listener) {
      diagnosticListeners.add(listener);
      return store.add(toDisposable(() => diagnosticListeners.delete(listener)));
    },
  };

  // --------------------------------------------------------- shell
  const shell: ShellSurface = options?.shell ?? {
    openPanel(panelId) {
      log.warn(
        `shell.openPanel("${panelId}") ignored — the host app provided no ` +
          `shell actions (probe with supports("shell.openPanel@1"))`,
      );
    },
    closePanel() {
      /* same contract as openPanel — warn once is enough */
    },
  };

  const featureSet = new Set(HOST_FEATURES);
  if (options?.shell) {
    featureSet.add("shell.openPanel@1");
  }

  const host: BundleHost = {
    manifest,
    log,
    contribute,
    document,
    selection,
    viewport,
    overlay,
    shell,
    storage,
    diagnostics,
    supports: (feature) => featureSet.has(feature),
    get editor() {
      return getEditor();
    },
  };

  return {
    host,
    dispose() {
      store.dispose();
    },
  };
}
