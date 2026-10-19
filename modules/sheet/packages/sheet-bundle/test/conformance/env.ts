/*
 * This file is part of paged (https://paged.media).
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

// The surface-conformance environments for paged.sheet: the REAL bundle
// (`sheetBundle.activate`, every contribution it registers) on two hosts.
//
//   · `unitEnv()` — the SDK's in-process `BundleHost` adapter over the
//     gesture kit's RECORDING fake editor. No canvas engine: mutations are
//     recorded and answered with happy defaults, the fake keeps a small undo
//     stack. The sheet engine (the bundle's own wasm) is real.
//   · `headlessEnv()` — the plugin-sdk harness over the REAL canvas engine
//     (`createHeadlessHost`): real mutations, real document undo, real parts
//     and metadata.
//
// Both give the same `SheetEnv`, so one scenario (./scenarios.ts) runs on
// either; the layer a test counts for is the file that runs it
// (`test/*.spec.ts` unit, `test/headless/*.headless.test.ts` headless).
//
// Two editor UI doors the hosts lack are recorded here instead of faked
// away: `shell.openPanel` (which panel a command opened) and the scene
// channel (`rendering.sceneLayer@1`, what the in-frame grid submitted).

import { readFileSync } from "node:fs";

import {
  createBundleHost,
  createDataProviderRegistry,
  createHeadlessHost,
} from "@paged-media/plugin-sdk";
import type {
  DataProviderBackend,
  HeadlessHost,
} from "@paged-media/plugin-sdk";
import {
  createFakeEditor,
  type FakeEditor,
} from "@paged-media/plugin-sdk/gesture-kit";
import type {
  BundleHost,
  ClipboardPayload,
  CommandContribution,
  EditContextContribution,
  ExporterContribution,
  ImporterContribution,
  KeybindingContribution,
  ObjectValue,
  PanelContribution,
  PickedFile,
  PluginManifest,
  SchemaPanelRenderer,
} from "@paged-media/plugin-api";

import { sheetBundle } from "../../src";
import { blankPageIdml, settle } from "../perf/workload";

const PKG = new URL("../..", import.meta.url).pathname;

/** The cell address prefix of the sheet object model. */
export const P = "plugin:media.paged.sheet";

export interface LogLine {
  level: "debug" | "info" | "warn" | "error";
  text: string;
}

export interface SceneCall {
  op: "submit" | "clear";
  elementId: string;
  /** The text items of a submitted layer (the grid's cell values). */
  texts: string[];
}

export interface SheetEnv {
  kind: "unit" | "headless";
  /** The host the bundle was activated on. */
  host: BundleHost;
  /** The shared object registry (`host.objects` of the bundle's model). */
  objects: BundleHost["objects"];
  /** The shared data-provider registry, the host side (what another
   *  bundle, paged.data, would publish into). */
  providers: DataProviderBackend;
  command(id: string): CommandContribution;
  keybindings(): KeybindingContribution[];
  importer(id: string): ImporterContribution;
  exporter(id: string): ExporterContribution;
  editContext(): EditContextContribution;
  panel(id: string): PanelContribution;
  /** Every `shell.openPanel` call, in order. */
  opened: string[];
  logs: LogLine[];
  clipboard: { payload: ClipboardPayload | null };
  scene: SceneCall[];
  /** The next `shell.pickFile` answer. */
  pick(files: PickedFile[]): void;
  /** Document mutations applied since `mark()` (the fake's log, or the
   *  harness's fan-out of every `mutate`). */
  mark(): number;
  mutationsSince(mark: number): Array<{ op: string; applied: boolean }>;
  undo(): Promise<void>;
  redo(): Promise<void>;
  /** The page every scenario places into. */
  pageId: string;
  /** Wait for the bundle's queued work (persist, refresh, reconcile). */
  settle(): Promise<void>;
  dispose(): void;
}

/** Read an object value (unwrapping `{kind:"value"}`). */
export async function value(
  env: SheetEnv,
  address: string,
  path: string,
): Promise<unknown> {
  const v = (await env.objects.get(address as never, path)) as ObjectValue;
  return v.kind === "value" ? v.value : v;
}

const consoleInto = (logs: LogLine[]) => {
  const line =
    (level: LogLine["level"]) =>
    (...args: unknown[]) =>
      logs.push({
        level,
        text: args
          .map((a) => (typeof a === "string" ? a : String(a)))
          .join(" "),
      });
  return {
    debug: line("debug"),
    info: line("info"),
    warn: line("warn"),
    error: line("error"),
  };
};

const mapBacking = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    keys: () => Array.from(m.keys()),
  };
};

/** The host as the editor hands it, plus the two UI doors recorded. */
function withEditorDoors(
  host: BundleHost,
  opened: string[],
  scene: SceneCall[],
  pickQueue: PickedFile[][],
  mutations: Array<{ op: string; applied: boolean }>,
): BundleHost {
  const surface = {
    submit: async (elementId: string, layer: { items: unknown[] }) => {
      scene.push({
        op: "submit",
        elementId,
        texts: (layer.items as { kind?: string; text?: string }[])
          .filter((i) => i.kind === "text")
          .map((i) => i.text ?? ""),
      });
    },
    clear: async (elementId: string) => {
      scene.push({ op: "clear", elementId, texts: [] });
    },
    dispose: () => {},
  };
  const contribute = new Proxy(host.contribute, {
    get(o, p, r) {
      if (p === "sceneLayer") return () => surface;
      return Reflect.get(o, p, r);
    },
  });
  const shell = new Proxy(host.shell, {
    get(o, p, r) {
      if (p === "openPanel") return (id: string) => void opened.push(id);
      if (p === "closePanel") return () => {};
      if (p === "pickFile") return async () => pickQueue.shift() ?? [];
      return Reflect.get(o, p, r);
    },
  });
  // What the bundle EMITS: every document mutation it sends, with whether
  // the host applied it.
  const document = new Proxy(host.document, {
    get(o, p, r) {
      if (p === "mutate") {
        return async (m: Parameters<BundleHost["document"]["mutate"]>[0]) => {
          const outcome = await o.mutate(m);
          mutations.push({
            op: (m as { op: string }).op,
            applied: !!(outcome as { applied?: boolean }).applied,
          });
          return outcome;
        };
      }
      return Reflect.get(o, p, r);
    },
  });
  return new Proxy(host, {
    get(o, p, r) {
      if (p === "document") return document;
      if (p === "supports") {
        return (f: string) =>
          f === "rendering.sceneLayer@1" ||
          f === "shell.openPanel@1" ||
          f === "shell.pickFile@1" ||
          o.supports(f);
      }
      if (p === "contribute") return contribute;
      if (p === "shell") return shell;
      return Reflect.get(o, p, r);
    },
  });
}

/** Instantiate the sheet engine's wasm from disk. The engine's own loader
 *  takes the BROWSER path (a fetch of the artifact's URL) wherever a
 *  `window` exists, which happy-dom provides; a module that is already
 *  initialised skips that fetch, so the DOM specs call this first. */
export async function initSheetWasm(): Promise<void> {
  const glue = (await import(
    /* @vite-ignore */ new URL("../../bin/sheet_js.js", import.meta.url)
      .pathname
  )) as { initSync(o: { module: Uint8Array }): void };
  glue.initSync({
    module: new Uint8Array(
      readFileSync(new URL("../../bin/sheet_js_bg.wasm", import.meta.url)),
    ),
  });
}

/** The unit environment: the SDK adapter over the recording fake editor.
 *  `schemaPanelRenderer` stands in for the editor's schema-panel renderer
 *  (without one the SDK registers its honest seam). */
export function unitEnv(
  options: { schemaPanelRenderer?: SchemaPanelRenderer } = {},
): SheetEnv & { fake: FakeEditor } {
  const logs: LogLine[] = [];
  const opened: string[] = [];
  const scene: SceneCall[] = [];
  const pickQueue: PickedFile[][] = [];
  const clip: { payload: ClipboardPayload | null } = { payload: null };
  const fake = createFakeEditor();
  const providers = createDataProviderRegistry();
  // The binary parts lane, in memory: what the editor's container holds.
  const parts = new Map<string, Uint8Array>();
  Object.assign(fake.editor, {
    parts: {
      write: async (path: string, bytes: Uint8Array) =>
        void parts.set(path, bytes.slice()),
      read: async (path: string) => parts.get(path)?.slice() ?? null,
      delete: async (path: string) => parts.delete(path),
    },
  });
  const handle = createBundleHost(
    () => fake.editor,
    sheetBundle.manifest as PluginManifest,
    {
      console: consoleInto(logs),
      storage: mapBacking(),
      dataProviders: providers,
      ...(options.schemaPanelRenderer
        ? { schemaPanelRenderer: options.schemaPanelRenderer }
        : {}),
      clipboard: {
        read: async () => clip.payload,
        write: async (p: ClipboardPayload) => {
          clip.payload = p;
        },
      },
    },
  );
  const mutations: Array<{ op: string; applied: boolean }> = [];
  const host = withEditorDoors(
    handle.host,
    opened,
    scene,
    pickQueue,
    mutations,
  );
  const bundle = sheetBundle.activate(host);
  const reg = <T extends { id?: string; type?: string }>(
    name: Parameters<FakeEditor["registered"]>[0],
    id: string,
  ): T => {
    const found = fake
      .registered<T>(name)
      .find((c) => c.id === id || c.type === id);
    if (!found) throw new Error(`${name}: "${id}" is not registered`);
    return found;
  };
  return {
    kind: "unit",
    fake,
    host,
    objects: host.objects,
    providers,
    command: (id) => reg<CommandContribution>("commands", id),
    keybindings: () => fake.registered<KeybindingContribution>("keybindings"),
    importer: (id) => reg<ImporterContribution>("importers", id),
    exporter: (id) => reg<ExporterContribution>("exporters", id),
    editContext: () => reg<EditContextContribution>("editContexts", "sheet"),
    panel: (id) => reg<PanelContribution>("panels", id),
    opened,
    logs,
    clipboard: clip,
    scene,
    pick: (files) => void pickQueue.push(files),
    mark: () => mutations.length,
    mutationsSince: (m) => mutations.slice(m),
    undo: async () => {
      await host.document.undo();
    },
    redo: async () => {
      await host.document.redo();
    },
    pageId: fake.pages[0]!.id,
    settle: async () => {
      await settle();
      await fake.settle();
      await settle();
    },
    dispose() {
      bundle.dispose();
      handle.dispose();
    },
  };
}

/** The headless environment: the harness over the real canvas engine,
 *  one blank Letter page loaded. */
export async function headlessEnv(): Promise<SheetEnv & { h: HeadlessHost }> {
  const logs: LogLine[] = [];
  const opened: string[] = [];
  const scene: SceneCall[] = [];
  const pickQueue: PickedFile[][] = [];
  const clip: { payload: ClipboardPayload | null } = { payload: null };
  const h = await createHeadlessHost({
    console: consoleInto(logs),
    storage: mapBacking(),
    resolveFrom: PKG,
    clipboard: {
      read: async () => clip.payload,
      write: async (p: ClipboardPayload) => {
        clip.payload = p;
      },
    },
  });
  const [pageId] = await h.load(blankPageIdml());
  // The REAL bundle, loaded the way the editor loads it; its own host is
  // captured so the two UI doors can be recorded around it.
  const mutations: Array<{ op: string; applied: boolean }> = [];
  let captured: BundleHost | null = null;
  const loaded = h.loadBundle({
    ...sheetBundle,
    activate: (host: BundleHost) => {
      captured = withEditorDoors(host, opened, scene, pickQueue, mutations);
      return sheetBundle.activate(captured);
    },
  } as typeof sheetBundle);
  if (!captured) throw new Error("the sheet bundle did not activate");
  const host: BundleHost = captured;
  const of = <T>(kind: string, id: string): T => {
    const found = h.contributions.find(
      (c) =>
        c.kind === kind &&
        (c.id === id || (c.value as { type?: string }).type === id),
    );
    if (!found) throw new Error(`${kind}: "${id}" is not registered`);
    return found.value as T;
  };
  return {
    kind: "headless",
    h,
    host,
    objects: h.objects,
    providers: h.dataProviders,
    command: (id) => of<CommandContribution>("command", id),
    keybindings: () =>
      h.contributions
        .filter((c) => c.kind === "keybinding")
        .map((c) => c.value as KeybindingContribution),
    importer: (id) => of<ImporterContribution>("importer", id),
    exporter: (id) => of<ExporterContribution>("exporter", id),
    editContext: () => of<EditContextContribution>("editContext", "sheet"),
    panel: (id) => of<PanelContribution>("panel", id),
    opened,
    logs,
    clipboard: clip,
    scene,
    pick: (files) => void pickQueue.push(files),
    mark: () => mutations.length,
    mutationsSince: (m) => mutations.slice(m),
    undo: async () => {
      await host.document.undo();
      await settle();
    },
    redo: async () => {
      await host.document.redo();
      await settle();
    },
    pageId: pageId!,
    settle: async () => {
      for (let i = 0; i < 4; i++) await settle();
    },
    dispose() {
      loaded.dispose();
      h.dispose();
    },
  };
}
