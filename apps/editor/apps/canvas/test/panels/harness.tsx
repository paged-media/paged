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

// The panel test harness: mount one built-in panel exactly where the
// cockpit mounts it, over the real engine, and drive the state it reads.
//
// WHAT IS REAL. The shell's own provider stack (PagedShell's, provider for
// provider; `harness-parity.dom.test.tsx` fails when the two drift), the
// shell's `PanelHost` (so the panel gets `{ paged, api }` and its binding
// scope as in the app), the editor's object model (`src/object-model.ts`,
// the registry `PropertyField` writes through), the real `CanvasClient`
// and the real engine wasm behind it (`engine-worker.ts`). Documents are
// built in code (`fixtures.ts`) or minted blank by the engine; the
// private corpus is never read.
//
// WHAT IS NOT. Nothing renders pixels (no canvas, no GPU, no tiles), and
// the chrome (menus, rail, dock) is not mounted: a panel is tested on its
// own. Commands a panel invokes are not the app's; a test registers the
// ids it expects (`h.spyCommand`) and asserts what reached them.
//
// THE STATES a test puts the panel in go through the same doors the
// canvas uses: `select` writes the engine's element selection and the
// shell's mirror of it (with the engine's geometry), `caret` / `selectText`
// set the content selection, `enterTable` the table cell selection.
// `settle()` waits until no request is in flight and React has
// rendered what the replies set.

import { act, cleanup, render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type ComponentType,
  type PropsWithChildren,
  type ReactNode,
} from "react";

import {
  CanvasClient,
  type ContentSelection,
  type DocumentHandle,
  type ElementId,
  type Mutation,
  type WorkerToMain,
} from "@paged-media/client";
import {
  ActionsProvider,
  BindingProviderProvider,
  CameraProvider,
  CanvasClientProvider,
  CockpitStateProvider,
  ContentSelectionProvider,
  DocumentProvider,
  EditContextStackProvider,
  FormattingAffectsProvider,
  GuideDragProvider,
  InstrumentationProvider,
  ObjectModelProvider,
  OverlaySignalsProvider,
  PagedEditorProvider,
  PanelHost,
  ScreenModeProvider,
  SelectionProvider,
  TableSelectionProvider,
  ThemeProvider,
  ThreadingProvider,
  ToolProvider,
  ToolSettingsProvider,
  WorkflowModeProvider,
  useCanvasClient,
  useCockpitState,
  useContentSelection,
  useDocument,
  usePaged,
  useRegistries,
  useSelection,
  useTableSelection,
  useTool,
  SELECT_TOOL_ID,
  TEXT_TOOL_ID,
  type PagedEditor,
  type PanelContribution,
  type ShellRegistries,
  type TableCellSelection,
} from "@paged-media/shell";
import { createBindingProviderRegistry } from "@paged-media/plugin-sdk";

import {
  editorObjectModel,
  objectRegistry,
  setObjectModelEditor,
} from "../../src/object-model";
import {
  EngineWorker,
  headlessEngine,
  type WireMessage,
} from "./engine-worker";
import type { SceneBuilder } from "./fixtures";

export { within };

/** What document the panel opens on. */
export type DocumentState =
  /** Nothing loaded: the state before File ▸ Open. */
  | "none"
  /** One empty US Letter page, minted by the engine (File ▸ New). */
  | "blank"
  /** IDML bytes (`fixtures.ts`). */
  | Uint8Array;

export interface MountOptions<S> {
  /** Default `"blank"`. */
  document?: DocumentState;
  /** Builds content into the open document BEFORE the panel mounts
   *  (`fixtures.ts`); what it returns is `h.scene`. */
  scene?: SceneBuilder<S>;
  /** The panel id it is registered under. Defaults to the contribution's
   *  id when a contribution is passed. */
  id?: string;
}

interface Bridge {
  paged: PagedEditor;
  registries: ShellRegistries;
  selection: ReturnType<typeof useSelection>;
  content: ReturnType<typeof useContentSelection>;
  document: ReturnType<typeof useDocument>;
  table: ReturnType<typeof useTableSelection>;
  tool: ReturnType<typeof useTool>;
  cockpit: ReturnType<typeof useCockpitState>;
}

/** A mounted panel and the doors to drive it. */
export interface PanelHarness<S = undefined> {
  /** What the scene builder returned (the ids it minted). */
  readonly scene: S;
  /** The panel's DOM (inside its `data-panel-host` wrapper). */
  readonly root: HTMLElement;
  /** Testing Library queries scoped to the panel. */
  readonly view: ReturnType<typeof within>;
  /** A user-event session (pointer + keyboard as a user produces them). */
  readonly user: ReturnType<typeof userEvent.setup>;
  readonly client: CanvasClient;
  readonly engine: EngineWorker;
  /** The open document (null for `document: "none"`). */
  readonly handle: DocumentHandle | null;
  readonly registries: ShellRegistries;
  readonly paged: PagedEditor;

  /** Wait until no request is in flight and React has rendered. */
  settle(): Promise<void>;
  /** Run `fn` inside act, then settle. */
  act(fn: () => unknown): Promise<void>;

  /** A position in the wire log; `sent` / `mutations` read from it. */
  mark(): number;
  /** Channel messages of `kind` posted since `from` (default: mount). */
  sent(kind?: string, from?: number): WireMessage[];
  /** The `mutate` payloads posted since `from`. */
  mutations(from?: number): Mutation[];

  /** The engine's value of `path` on an object-model address (ADR 131:
   *  `rectangle:u2`, `doc`, `swatch:Color/u1`), read back to prove a
   *  control's write landed in the MODEL, not only on the wire. */
  get(address: string, path: string): Promise<unknown>;
  /** An element's property entries, by path (`requestElementProperties`). */
  props(id: ElementId): Promise<Record<string, unknown>>;
  /** The field a schema-driven control renders for `path`
   *  (`[data-property-field]`); throws when the panel shows none. */
  field(path: string): HTMLElement;
  /** Whether the panel renders a field for `path`. */
  hasField(path: string): boolean;

  /** Type into a field's text input the way a user does (clear, type,
   *  Enter) and settle. `path` names a `[data-property-field]`,
   *  or pass the input itself. */
  typeInto(target: string | HTMLElement, text: string): Promise<void>;
  /** Choose an option (by value) in a field's `<select>` and settle. */
  choose(target: string | HTMLElement, value: string): Promise<void>;
  /** Click a segment of a field's toggle group (`data-option-value`). */
  press(path: string, optionValue: string): Promise<void>;
  /** Click an element and settle. */
  click(el: Element): Promise<void>;

  /** Apply a mutation through the engine (setup, not under test). */
  mutate(mutation: Mutation): Promise<WorkerToMain>;
  /** Select page items, the way a canvas click does. */
  select(ids: ElementId[]): Promise<void>;
  /** Drop the content selection (Esc out of text), back to Selection. */
  leaveText(): Promise<void>;
  /** A collapsed caret in a story. */
  caret(storyId: string, offset: number): Promise<void>;
  /** A text range in a story. */
  selectText(storyId: string, start: number, end: number): Promise<void>;
  /** A table cell selection. */
  enterTable(cell: TableCellSelection | null): Promise<void>;

  /** Register another panel (one the panel under test opens, links to or
   *  embeds; the cockpit ignores ids the registry does not have). */
  registerPanel(contribution: PanelContribution): void;
  /** The panel-rail steer (Properties' empty-selection inspector:
   *  "text" / "image" / "page"), as the rail's buttons set it. */
  steer(context: "text" | "image" | "page" | null): Promise<void>;
  /** The cockpit's right dock: its tabs and the one on screen (what a
   *  panel's "open X" link changes). */
  dock(): { tabs: string[]; active: string | null };

  /** Register a command id the panel invokes; returns the payloads it
   *  was invoked with, in order. */
  spyCommand(id: string): unknown[];
  /** Every command invocation since mount (`commands.observe`). */
  invoked(id?: string): Array<{ id: string; payload: unknown }>;

  unmount(): void;
}

/** Panels mounted in this file, unmounted by `unmountAll`. */
const mounted = new Set<PanelHarness<unknown>>();

function BridgeCapture({ onBridge }: { onBridge: (b: Bridge) => void }) {
  const paged = usePaged();
  const registries = useRegistries();
  const selection = useSelection();
  const content = useContentSelection();
  const document = useDocument();
  const table = useTableSelection();
  const tool = useTool();
  const cockpit = useCockpitState();
  useLayoutEffect(() => {
    onBridge({
      paged,
      registries,
      selection,
      content,
      document,
      table,
      tool,
      cockpit,
    });
    // The app sets the object model's editor from PluginBundles on every
    // render (main.tsx); the harness does the same after every render,
    // before any field's read, so PropertyField reads and writes through
    // this mount's client.
    setObjectModelEditor(paged as never);
  });
  return null;
}

/** Registers the panel, and renders PanelHost once it is in the registry
 *  (PanelHost reads the registry at render and does not subscribe). */
function Registered({
  contribution,
  children,
}: PropsWithChildren<{ contribution: PanelContribution }>) {
  const registries = useRegistries();
  useLayoutEffect(() => {
    if (registries.panels.get(contribution.id)) return;
    const registration = registries.panels.register(contribution);
    return () => registration.dispose();
  }, [registries, contribution]);
  const present = useSyncExternalStore(
    (onChange) => {
      const sub = registries.panels.onChange(onChange);
      return () => sub.dispose();
    },
    () => registries.panels.get(contribution.id) !== undefined,
  );
  return present ? <>{children}</> : null;
}

/** Puts the loaded document, and the resolver pass its load ran, into
 *  the document context once mounted (the chrome routes both). */
function SeedDocument({
  handle,
  resolution,
}: {
  handle: DocumentHandle | null;
  resolution: unknown;
}) {
  const { setHandle, setResolution } = useDocument();
  useLayoutEffect(() => {
    if (handle) setHandle(handle);
    if (resolution) setResolution(resolution as never);
  }, [handle, resolution, setHandle, setResolution]);
  return null;
}

/**
 * What PagedShell's chrome does for the document handle (its worker-
 * message subscriber, PagedShell.tsx): after a change that may add, remove,
 * move or resize pages, re-read the page list and rebuild the handle when
 * it differs; and route the resolver's passes into the document context.
 * Panels that read `handle.pageCount` / `pageSizesPt` or the resolution
 * (Outline, TOC readers) see what a test changes, as they do in the app.
 */
function FollowPages() {
  const client = useCanvasClient();
  const { handle, setHandle, setResolution } = useDocument();
  const handleRef = useRef(handle);
  useLayoutEffect(() => {
    handleRef.current = handle;
  });
  useEffect(() => {
    const reread = () => {
      void client
        .collection<{ selfId: string; sizePt: [number, number] }>("pages")
        .then((pages) => {
          const now = handleRef.current;
          if (!now) return;
          const same =
            pages.length === now.pageIds.length &&
            pages.every(
              (p, i) =>
                p.selfId === now.pageIds[i] &&
                p.sizePt[0] === now.pageSizesPt?.[i]?.[0] &&
                p.sizePt[1] === now.pageSizesPt?.[i]?.[1],
            );
          if (same) return;
          setHandle({
            ...now,
            pageCount: pages.length,
            pageIds: pages.map((p) => p.selfId) as typeof now.pageIds,
            pageSizesPt: pages.map((p) => p.sizePt) as typeof now.pageSizesPt,
          });
        })
        .catch(() => undefined);
    };
    return client.subscribe((msg) => {
      // The resolver's passes (TOC, cross-references, outline) reach the
      // document context as they do through the chrome.
      if (msg.kind === "resolutionDone") setResolution(msg.payload);
      if (
        msg.kind === "mutationApplied" ||
        msg.kind === "undoApplied" ||
        msg.kind === "redoApplied" ||
        msg.kind === "scriptResult"
      ) {
        reread();
      }
    });
  }, [client, setHandle, setResolution]);
  return null;
}

/**
 * PagedShell's provider stack, in PagedShell's order, without the chrome.
 * `harness-parity.dom.test.tsx` compares the two lists.
 */
export function ShellProviders({
  client,
  children,
}: PropsWithChildren<{ client: CanvasClient }>): ReactNode {
  return (
    <CanvasClientProvider client={client}>
      <ThemeProvider>
        <CameraProvider>
          <DocumentProvider>
            <ToolProvider>
              <WorkflowModeProvider>
                <ScreenModeProvider>
                  <ToolSettingsProvider>
                    <FormattingAffectsProvider>
                      <SelectionProvider>
                        <ContentSelectionProvider>
                          <OverlaySignalsProvider>
                            <GuideDragProvider>
                              <ThreadingProvider>
                                <TableSelectionProvider>
                                  <InstrumentationProvider>
                                    <EditContextStackProvider>
                                      <BindingProviderProvider
                                        host={
                                          createBindingProviderRegistry() as never
                                        }
                                      >
                                        <ObjectModelProvider
                                          host={editorObjectModel}
                                        >
                                          <PagedEditorProvider>
                                            <ActionsProvider>
                                              <CockpitStateProvider>
                                                {children}
                                              </CockpitStateProvider>
                                            </ActionsProvider>
                                          </PagedEditorProvider>
                                        </ObjectModelProvider>
                                      </BindingProviderProvider>
                                    </EditContextStackProvider>
                                  </InstrumentationProvider>
                                </TableSelectionProvider>
                              </ThreadingProvider>
                            </GuideDragProvider>
                          </OverlaySignalsProvider>
                        </ContentSelectionProvider>
                      </SelectionProvider>
                    </FormattingAffectsProvider>
                  </ToolSettingsProvider>
                </ScreenModeProvider>
              </WorkflowModeProvider>
            </ToolProvider>
          </DocumentProvider>
        </CameraProvider>
      </ThemeProvider>
    </CanvasClientProvider>
  );
}

/** Wait for the engine and React to go quiet. */
async function quiesce(engine: EngineWorker): Promise<void> {
  let idle = 0;
  for (let i = 0; i < 400; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    if (engine.busy) idle = 0;
    else if (++idle >= 3) return;
  }
  throw new Error("panel harness: the engine never went quiet");
}

/**
 * Mount a panel. `panel` is a registry contribution (BUILT_IN_PANELS'
 * entry) or a bare component, registered under `options.id`.
 */
export async function mountPanel<S = undefined>(
  panel: PanelContribution | ComponentType<never>,
  options: MountOptions<S> = {},
): Promise<PanelHarness<S>> {
  const contribution: PanelContribution =
    typeof panel === "function"
      ? {
          id: options.id ?? "test.panel",
          title: options.id ?? "Panel",
          component: panel as PanelContribution["component"],
        }
      : panel;
  const id = contribution.id;

  const { worker } = await headlessEngine();
  const engine = new EngineWorker(worker);
  const client = new CanvasClient({
    workerFactory: () => engine as unknown as Worker,
  });

  const doc = options.document ?? "blank";
  let handle: DocumentHandle | null = null;
  if (doc === "blank") handle = await client.newBlankDocument(612, 792);
  else if (doc instanceof Uint8Array) handle = await client.loadDocument(doc);
  let scene = undefined as S;
  if (options.scene) {
    if (!handle) throw new Error("panel harness: a scene needs a document");
    scene = await options.scene({ client, handle });
    // The scene may have added pages: hand the panel the handle the
    // chrome would have rebuilt by now.
    const pages = (await client.collection("pages")) as Array<{
      selfId: string;
      sizePt: [number, number];
    }>;
    handle = {
      ...handle,
      pageCount: pages.length,
      pageIds: pages.map((p) => p.selfId) as typeof handle.pageIds,
      pageSizesPt: pages.map((p) => p.sizePt) as typeof handle.pageSizesPt,
    };
  }
  // The load's own traffic is setup; the log a test reads starts here.
  engine.sent.length = 0;

  // The object registry is the app's module singleton, and its core seam
  // subscribes to the FIRST client it reads (the app has one for its
  // lifetime). Each mount has its own client, so drop the seam's
  // subscription and caches; the fields this mount renders subscribe
  // again, to this client.
  objectRegistry.core?.dispose();

  const bridge: { current: Bridge | null } = { current: null };
  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(
      <ShellProviders client={client}>
        <BridgeCapture onBridge={(next) => (bridge.current = next)} />
        <SeedDocument handle={handle} resolution={engine.lastResolution} />
        <FollowPages />
        <Registered contribution={contribution}>
          <PanelHost id={id} />
        </Registered>
      </ShellProviders>,
    );
  });
  await quiesce(engine);
  const b = (): Bridge => {
    if (!bridge.current) throw new Error("panel harness: not mounted");
    return bridge.current;
  };
  const root =
    (result.container.querySelector(
      `[data-panel-host="${CSS.escape(id)}"]`,
    ) as HTMLElement | null) ?? result.container;

  const settle = () => quiesce(engine);
  const invocations: Array<{ id: string; payload: unknown }> = [];
  b().registries.commands.observe((e) => {
    if (e.phase === "started") {
      invocations.push({ id: e.invocation.id, payload: e.invocation.payload });
    }
  });
  const h: PanelHarness<S> = {
    scene,
    root,
    view: within(root),
    user: userEvent.setup(),
    client,
    engine,
    handle,
    get registries() {
      return b().registries;
    },
    get paged() {
      return b().paged;
    },
    settle,
    async act(fn) {
      await act(async () => {
        await fn();
      });
      await settle();
    },
    mark: () => engine.sent.length,
    sent: (kind, from = 0) =>
      engine.sent.slice(from).filter((m) => !kind || m.kind === kind),
    mutations: (from = 0) =>
      engine.sent
        .slice(from)
        .filter((m) => m.kind === "mutate")
        .map((m) => m.payload as Mutation),
    async get(address, path) {
      const reply = (await client.send({
        kind: "requestGet",
        payload: { address, path },
      } as never)) as {
        kind: string;
        payload: { value: unknown; error?: string | null };
      };
      if (reply.kind !== "propertyValue" || reply.payload.error) {
        throw new Error(
          `get ${address} ${path}: ${reply.payload?.error ?? reply.kind}`,
        );
      }
      return reply.payload.value;
    },
    async props(elementId) {
      const props = await client.elementProperties(elementId);
      const out: Record<string, unknown> = {};
      for (const e of props?.entries ?? []) out[e.path] = e.value;
      return out;
    },
    field(path) {
      const el = root.querySelector<HTMLElement>(
        `[data-property-field="${CSS.escape(path)}"]`,
      );
      if (!el) throw new Error(`panel shows no field for ${path}`);
      return el;
    },
    hasField: (path) =>
      root.querySelector(`[data-property-field="${CSS.escape(path)}"]`) !==
      null,
    async typeInto(target, text) {
      const el =
        typeof target === "string"
          ? h.field(target).querySelector<HTMLInputElement>("input, textarea")
          : target;
      if (!el) throw new Error(`no text input in ${String(target)}`);
      await h.user.clear(el);
      await h.user.type(el, `${text}{Enter}`);
      await settle();
    },
    async choose(target, value) {
      const el =
        typeof target === "string"
          ? h.field(target).querySelector("select")
          : target;
      if (!el) throw new Error(`no select in ${String(target)}`);
      await h.user.selectOptions(el as HTMLSelectElement, value);
      await settle();
    },
    async press(path, optionValue) {
      const el = h
        .field(path)
        .querySelector(`[data-option-value="${CSS.escape(optionValue)}"]`);
      if (!el) throw new Error(`no segment ${optionValue} in ${path}`);
      await h.user.click(el);
      await settle();
    },
    async click(el) {
      await h.user.click(el);
      await settle();
    },
    async mutate(mutation) {
      let reply!: WorkerToMain;
      await h.act(async () => {
        reply = await client.mutate(mutation);
      });
      return reply;
    },
    async select(ids) {
      await h.act(async () => {
        const applied = await client.setElementSelection(ids, "replace");
        const geometry =
          applied.length > 0 ? await client.elementGeometry(applied) : [];
        b().selection.setElementSelection(applied);
        b().selection.setElementGeometry(geometry);
      });
    },
    async leaveText() {
      await h.act(() => {
        b().content.setContentSelection(null);
        b().tool.setBaseTool(SELECT_TOOL_ID);
      });
    },
    async caret(storyId, offset) {
      await h.selectText(storyId, offset, offset);
    },
    async selectText(storyId, start, end) {
      // What a Type-tool click does (canvas-panel.tsx): the text tool in
      // hand and the content selection set; the context's setter posts
      // it to the engine. The element selection is left as it was.
      const sel: ContentSelection = { storyId, start, end, affinity: false };
      await h.act(() => {
        b().tool.setBaseTool(TEXT_TOOL_ID);
        b().content.setContentSelection(sel);
      });
    },
    async enterTable(cell) {
      await h.act(() =>
        cell ? b().table.selectCell(cell) : b().table.clearCell(),
      );
    },
    registerPanel(contribution) {
      if (!b().registries.panels.get(contribution.id)) {
        b().registries.panels.register(contribution);
      }
    },
    async steer(context) {
      await h.act(() => b().cockpit.setInspectorContext(context));
    },
    dock: () => ({
      tabs: [...b().cockpit.rightTabs],
      active: b().cockpit.activeTab,
    }),
    spyCommand(commandId) {
      const calls: unknown[] = [];
      b().registries.commands.register({
        id: commandId,
        title: commandId,
        handler: (_paged: unknown, payload?: unknown) => {
          calls.push(payload);
        },
      });
      return calls;
    },
    invoked: (commandId) =>
      invocations.filter((i) => !commandId || i.id === commandId),
    unmount() {
      mounted.delete(h as PanelHarness<unknown>);
      result.unmount();
      client.dispose();
    },
  };
  mounted.add(h as PanelHarness<unknown>);
  return h;
}

/** Unmount every panel this file mounted (an afterEach). */
export function unmountAll(): void {
  for (const h of [...mounted]) h.unmount();
  cleanup();
}
