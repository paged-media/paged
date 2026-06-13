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
  AssetSurface,
  BindingsSurface,
  BlobSurface,
  BundleHost,
  ClipboardSurface,
  ClipboardPayload,
  ContributionSurface,
  Diagnostic,
  DiagnosticsSurface,
  Disposable,
  DocumentChangeEvent,
  FrameChainLink,
  DocumentSurface,
  EditContextContribution,
  ElementId,
  FontFaceAsset,
  HitFilter,
  HitResult,
  ImagesSurface,
  ImageResourceClaimOptions,
  ProviderTileWire,
  ConsentResult,
  DataProvidersSurface,
  DataProviderRegistration,
  DataProviderHandle,
  DataProviderInfo,
  DataProviderSnapshot,
  Mutation,
  MutationOutcome,
  NetworkSurface,
  ObjectTypeContribution,
  OverlaySurface,
  PagedEditor,
  PanelContribution,
  PluginLogger,
  PluginManifest,
  PluginMetadataEnvelope,
  SceneTreeNode,
  SceneLayerSurface,
  SchemaPanelContribution,
  SchemaPanelRenderer,
  SelectionMode,
  SelectionSurface,
  ShellSurface,
  StorageSurface,
  TextSurface,
  ViewportSurface,
  WidgetSurface,
} from "@paged-media/plugin-api";

import { DisposableStore, toDisposable } from "./disposables";
import { FALLBACK_WIDGETS } from "./widgets-fallback";
import { makeSchemaPanelComponent } from "./schema-panel";

/** The implemented feature set — `host.supports()` answers from this,
 *  so docs/tests can't drift from code. Form: `"area.member@major"`. */
export const HOST_FEATURES: readonly string[] = [
  "contribute.tool@1",
  "contribute.panel@1",
  "contribute.schemaPanel@1",
  "bindings@1",
  "contribute.command@1",
  "contribute.keybinding@1",
  "contribute.overlay@1",
  "contribute.editContext@1",
  "contribute.objectType@1",
  "contribute.importer@1",
  "contribute.exporter@1",
  "document.mutate@1",
  "document.undo@1",
  "document.collection@1",
  "document.frameChain@1",
  "document.meta@1",
  "document.pathAnchors@1",
  "document.hitTest@1",
  "document.elementGeometry@1",
  "document.elementProperties@1",
  "document.placeholders@1",
  "document.tree@1",
  "document.onDidChange@1",
  "document.getMetadata@1",
  "document.setMetadata@1",
  "selection@1",
  "viewport@1",
  "overlay.toolPreview@1",
  "storage@1",
  "diagnostics@1",
  // C-5 / I-04 (core v42): the placed-image bytes read is engine-served
  // through the wire (no injected source), so it is unconditionally
  // implemented at the pinned canvas-wasm — unlike assets.fonts@1, which
  // stays conditional on the editor's injected byte source.
  "assets.images@1",
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

/**
 * Thrown (in `capabilityMode: 'enforce'`) when a bundle USES a host
 * door it did not DECLARE in its manifest — the trust-line record's
 * (W0.11) "manifest capabilities ENFORCED, not advisory" gate, applied
 * at the chokepoint. Same loud-honesty style as the namespace gate: the
 * message names the door, the missing declaration, and where to add it.
 *
 * v1 stance (in-process, no isolation): this is HONESTY +
 * accident-prevention, not a security boundary — a bundle holding the
 * raw `host.editor` handle can still bypass the facade. The error makes
 * declaration↔use drift loud during dogfooding so the manifest stays a
 * truthful description of what the bundle actually touches.
 */
export class PluginCapabilityError extends Error {
  /** The host door that was called (e.g. `"contribute.tool"`). */
  readonly door: string;
  /** The manifest declaration that would authorize it (e.g.
   *  `'contributes.tools[] must include "media.paged.web.tool.pen"'`). */
  readonly missingDeclaration: string;
  constructor(door: string, missingDeclaration: string, pluginId: string) {
    super(
      `plugin-api: ${pluginId} called ${door} without declaring it — ` +
        `${missingDeclaration}. Manifest capabilities are ENFORCED ` +
        `(trust-line W0.11): declare the use or the host refuses it.`,
    );
    this.name = "PluginCapabilityError";
    this.door = door;
    this.missingDeclaration = missingDeclaration;
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

/** The host-provided network consent primitive (paged.data D-03; base-idea §11).
 *  The editor owns the consent UI (the visible data-source manifest) and the
 *  CSP `connect-src` enforcement; this hook is how the host adapter asks the
 *  user. When absent, `host.network.requestConsent` DENIES every origin (the
 *  honest no-consent posture) and `supports("network.consent@1")` is false. */
export interface ConsentBackend {
  request(origins: readonly string[], purpose: string): Promise<ConsentResult>;
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

/**
 * A host-side aggregator the editor injects to power a PROBLEMS PANEL
 * (paged.web W-05): every `host.diagnostics.set/clear` is mirrored
 * here keyed by `(bundleId, key)`, so one editor surface can list
 * diagnostics across all loaded bundles. The per-bundle in-host store
 * (`host.diagnostics.get`) is unchanged — this is a fan-out, not a
 * replacement. `bundleId` lets the panel attribute + de-dupe and
 * lets click-to-focus resolve the owning panel.
 */
export interface DiagnosticsSink {
  publish(bundleId: string, key: string, diagnostics: Diagnostic[]): void;
  clear(bundleId: string, key?: string): void;
}

/** Asset-store budgets (W-06). The per-face cap mirrors the wasm lane's
 *  per-artifact ceiling (DESIGN.md §10/§13.3) — a bundle can never be
 *  handed an unbounded face buffer. The host facade refuses an
 *  over-budget face (returns `null` + a `log.warn`). */
export const ASSET_BUDGETS = {
  /** Largest font face the door will serve, in bytes (8 MiB). */
  maxFontFaceBytes: 8 * 1024 * 1024,
} as const;

/**
 * The byte source the editor injects to back `host.assets` (W-06). The
 * same injection shape as `widgets`/`diagnosticsSink`: a value the host
 * app passes at `loadBundle` time. It serves the bytes the DOCUMENT
 * already holds for a face — READ-ONLY, never a network fetch on the
 * bundle's behalf (offline-forever, DESIGN.md §13.3). Returning `null`
 * is the honest no-bytes answer (an unregistered family, or — in v1 of
 * the editor adapter — every family, until the engine exposes a
 * font-bytes read-back; DESIGN.md §13.4).
 */
export interface BundleAssetProvider {
  /** The bytes of a document font face, or `null` when the host has
   *  none. Style-agnostic when `style` is omitted. */
  getFontFace(
    family: string,
    style?: string,
  ): Promise<FontFaceAsset | null>;
}

/** Blob-store budgets (K-4 / S-08). The default per-plugin quota when a
 *  manifest requests none; a manifest's `storage.quotaBytes` may only
 *  TIGHTEN it (the adapter enforces the stricter). */
export const BLOB_BUDGETS = {
  /** Default per-plugin blob ceiling, in bytes (64 MiB). */
  defaultQuotaBytes: 64 * 1024 * 1024,
} as const;

/**
 * The backend the editor injects to back `host.blob` (K-4 / S-08): a
 * RAW per-plugin byte store (OPFS in-browser; an in-memory map in the
 * headless harness). The SDK adapter owns namespacing (passes the
 * plugin id), the capability gate, and the quota — the backend only does
 * scoped IO. Keys are opaque strings the adapter forwards verbatim.
 */
export interface BlobStore {
  write(pluginId: string, key: string, bytes: Uint8Array): Promise<void>;
  read(pluginId: string, key: string): Promise<Uint8Array | null>;
  delete(pluginId: string, key: string): Promise<void>;
  keys(pluginId: string): Promise<string[]>;
  /** Total bytes this plugin currently stores. */
  used(pluginId: string): Promise<number>;
}

/**
 * The backend the editor injects to back `host.clipboard` (K-6 / S-14): a
 * thin read/write pair over the REAL system clipboard (`navigator.clipboard`
 * in-browser; a fake in the headless harness). The SDK adapter owns the
 * capability gate + the `"vector"` tabular-stripping; this backend only does
 * the raw IO. `read` recovers a `{ text?, tabular? }` payload (or `null` when
 * the platform offers nothing / refuses); `write` puts a payload on the
 * clipboard (the editor backend lays down BOTH `text/plain` TSV and a
 * `text/html` `<table>` so a paste into Excel/Sheets/Word lands a real grid).
 */
export interface ClipboardBackend {
  read(): Promise<ClipboardPayload | null>;
  write(payload: ClipboardPayload): Promise<void>;
}

/** The SHARED cross-plugin data-provider registry (paged.data §7.1 / D-09). The
 *  editor creates ONE (`createDataProviderRegistry`) and injects the SAME
 *  instance into every plugin host, so a provider plugin and a consumer plugin
 *  rendezvous through it. The per-plugin capability gate lives in the host
 *  surface; this backend is the neutral store + fan-out. */
export interface DataProviderBackend {
  register(registration: DataProviderRegistration): DataProviderHandle;
  discover(category?: string): readonly DataProviderInfo[];
  get(id: string): Promise<DataProviderSnapshot | null>;
  onDidChange(id: string, listener: (revision: string) => void): Disposable;
}

/** Build a shared in-memory data-provider registry (D-09). The editor holds ONE
 *  and injects it into every `createBundleHost` call as `options.dataProviders`;
 *  providers and consumers (different plugin hosts) meet through it. Reference
 *  implementation — an RPC/isolate host swaps a proxy with the same contract. */
export function createDataProviderRegistry(): DataProviderBackend {
  const providers = new Map<
    string,
    { reg: DataProviderRegistration; revision: string }
  >();
  const listeners = new Map<string, Set<(revision: string) => void>>();
  return {
    register(registration) {
      providers.set(registration.id, {
        reg: registration,
        revision: registration.revision,
      });
      return {
        update(revision) {
          const entry = providers.get(registration.id);
          if (entry) entry.revision = revision;
          for (const l of listeners.get(registration.id) ?? []) l(revision);
        },
        dispose() {
          providers.delete(registration.id);
        },
      };
    },
    discover(category) {
      return [...providers.values()]
        .filter((e) => category === undefined || e.reg.category === category)
        .map((e) => ({
          id: e.reg.id,
          category: e.reg.category,
          schema: e.reg.schema,
          revision: e.revision,
        }));
    },
    async get(id) {
      const entry = providers.get(id);
      if (!entry) return null;
      const records = await entry.reg.getSnapshot();
      return { id, revision: entry.revision, records };
    },
    onDidChange(id, listener) {
      let set = listeners.get(id);
      if (!set) {
        set = new Set();
        listeners.set(id, set);
      }
      set.add(listener);
      return toDisposable(() => set.delete(listener));
    },
  };
}

/**
 * Trust posture the HOST asserts for a bundle at the load path
 * (`plugin-trust-line.md`). Same-realm execution — full `BundleHost`
 * + the raw `PagedEditor` via `host.editor` — is FIRST-PARTY-ONLY
 * during incubation. There is no sound *cryptographic* identity signal
 * yet (package signing is the last unchecked gate box), and the
 * manifest `id` namespace (`media.paged.*`) is SELF-ASSERTED — a
 * foreign bundle could claim it — so the trust signal cannot come from
 * the bundle. It comes from the HOST vouching, here: a value the
 * caller supplies, defaulting to `'first-party'`. The loader refuses
 * anything else (`load.ts`), turning the drift-by-default the trust
 * line warns about (a quiet dynamic-import of foreign code on the
 * same-realm path) into a deliberate, greppable, reviewable act that
 * still does not load until the isolate/RPC host gate is built.
 */
export type BundleTrust = "first-party";

export interface CreateBundleHostOptions {
  /**
   * The host's trust assertion for this bundle (`plugin-trust-line.md`).
   * Defaults to `'first-party'` — the only value the loader accepts
   * today. Passing any other value (e.g. via a future dynamic-import
   * experiment) is refused loudly at the load path, gated on the
   * isolate/RPC host + capability enforcement + signing.
   */
  trust?: BundleTrust;
  storage?: StorageBacking;
  /** Host-provided network consent (paged.data D-03; base-idea §11): the editor
   *  injects the consent prompt + the data-source-manifest UI. When absent,
   *  `host.network` denies every origin and `supports("network.consent@1")` is
   *  false (the honest no-consent posture). */
  consent?: ConsentBackend;
  /** Host-provided SHARED data-provider registry (paged.data §7.1 / D-09): the
   *  editor creates ONE (`createDataProviderRegistry`) and injects the SAME
   *  instance into every plugin host, so a provider and a consumer rendezvous
   *  through it. When absent, `host.dataProviders` discover() is empty +
   *  register() is a no-op and `supports("dataProviders@1")` is false. */
  dataProviders?: DataProviderBackend;
  /** Console sink override (tests). */
  console?: Pick<Console, "debug" | "info" | "warn" | "error">;
  /** Shell actions the HOST APP owns (the cockpit's panel placement).
   *  When absent, `host.shell` warns and no-ops, and
   *  `supports("shell.openPanel@1")` answers false. */
  shell?: ShellSurface;
  /** Host-provided panel widgets (W-04): the real code editor lives in
   *  the editor's UI package and is injected here. When absent,
   *  `host.widgets` is the plain-textarea fallback and
   *  `supports("widgets.codeEditor@1")` answers false. */
  widgets?: WidgetSurface;
  /** Host-provided SCHEMA-PANEL renderer (W3.1): the editor's
   *  `SchemaPanelRenderer` that walks a `PanelSchema` through the
   *  catalog + subscribes to the bundle's bindings. When absent,
   *  `contribute.schemaPanel` registers a visible "needs a host
   *  renderer" seam panel (never a throw, never fake UI) and
   *  `supports("contribute.schemaPanel@1")` still answers true (the
   *  door exists; only the rich rendering is host-injected). */
  schemaPanelRenderer?: SchemaPanelRenderer;
  /** Internal registration hook (the headless harness): called at the
   *  moment a schema panel registers, with the verbatim contribution,
   *  so the conformance log can record the SCHEMA assertably (the
   *  registry only sees the synthesized React `PanelContribution`). The
   *  returned disposer (if any) is tracked alongside the panel
   *  registration. Not part of the public contract — a host-adapter
   *  seam. */
  onSchemaPanelRegistered?: (
    contribution: SchemaPanelContribution,
  ) => Disposable | void;
  /** Internal registration hook (the headless harness, W3.2): called
   *  when an EDIT CONTEXT registers (after the namespace + capability
   *  gates pass), with the verbatim contribution, so the conformance log
   *  can record it. When the editor provides no `editContexts` registry,
   *  this is ALSO the recording stub's only consumer — the door no
   *  longer throws, it records. Not part of the public contract. */
  onEditContextRegistered?: (
    contribution: EditContextContribution,
  ) => Disposable | void;
  /** Internal registration hook (the headless harness, W3.2): the
   *  object-type analogue of `onEditContextRegistered`. */
  onObjectTypeRegistered?: (
    contribution: ObjectTypeContribution,
  ) => Disposable | void;
  /** Host-side problems-panel aggregator (W-05). When present,
   *  `supports("diagnostics.publish@1")` answers true and every
   *  `host.diagnostics.set/clear` fans out to it. */
  diagnosticsSink?: DiagnosticsSink;
  /** Host-provided ASSET byte source (W-06). When present,
   *  `host.assets.getFontFace` serves DOCUMENT font face bytes through
   *  it (capability-gated, budget-clamped) and
   *  `supports("assets.fonts@1")` answers true. When absent, every
   *  asset read answers `null` (the honest no-bytes door) and the
   *  feature flag is false. */
  assetSource?: BundleAssetProvider;
  /** Host-provided BLOB backend (K-4 / S-08). When present,
   *  `host.blob.*` persists per-plugin bytes through it (capability-
   *  gated, quota-clamped) and `supports("storage.blob@1")` answers true.
   *  When absent, reads answer empty and writes reject (the honest
   *  no-store door). */
  blobStore?: BlobStore;
  /** Host-provided CLIPBOARD backend (K-6 / S-14). When present,
   *  `host.clipboard.read/write` go through it (capability-gated on
   *  `capabilities.clipboard`) and `supports("clipboard@1")` answers true.
   *  When absent, `read` answers `null` and `write` is a no-op (the honest
   *  no-clipboard door). */
  clipboard?: ClipboardBackend;
  /**
   * How the host treats a declaration↔use mismatch — a bundle that
   * USES a door (`contribute.tool`, `document.mutate`, …) it did not
   * DECLARE in its manifest (trust-line W0.11). Defaults to
   * `'enforce'`: the violating call throws `PluginCapabilityError`
   * (contribution registrations) or returns a non-applied
   * `MutationOutcome` for the write doors (mutate-never-throws). In
   * `'warn'` mode the violation is logged through `host.log.warn`
   * and the call proceeds — the migration escape hatch for a host
   * that loads not-yet-adopted manifests. The namespace gate and the
   * metadata-namespace gate are UNAFFECTED — they are always loud.
   */
  capabilityMode?: "enforce" | "warn";
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

  // ------------------------------------------ capability enforcement
  // The trust-line W0.11 gate: a door a bundle USES must be DECLARED
  // in its manifest. Same chokepoint as the namespace rule (DESIGN.md
  // §2.7), stricter policy. 'warn' logs + proceeds (migration hatch);
  // 'enforce' (default) refuses — throwing for the contribution doors,
  // a non-applied outcome for the write doors (mutate-never-throws).
  const capabilityMode = options?.capabilityMode ?? "enforce";
  const caps = manifest.capabilities;
  const declared = manifest.contributes;

  /** Declaration predicates — one per door class. Read straight off
   *  the manifest so the manifest stays the single source of truth. */
  const hasDoc = (dir: "read" | "write"): boolean =>
    caps?.document?.[dir] !== undefined;
  const hasRendering = (
    s: "sceneLayer" | "overlay" | "hitTest" | "resourceProvider",
  ): boolean => caps?.rendering?.includes(s) ?? false;
  const hasAsset = (k: "fonts" | "images"): boolean =>
    caps?.assets?.includes(k) ?? false;
  const hasBlobStore = (): boolean => caps?.storage?.blob === true;
  /** K-6 — the clipboard grant. `"full"` authorizes the whole door
   *  (text + tabular); `"vector"` authorizes the door but text-ONLY (the
   *  surface strips a tabular write + never surfaces a tabular read);
   *  `"none"`/absent denies entirely. Returns the granted tier. */
  const clipboardGrant = (): "full" | "vector" | "none" =>
    caps?.clipboard === "full"
      ? "full"
      : caps?.clipboard === "vector"
        ? "vector"
        : "none";
  const lists = (
    arr: readonly string[] | undefined,
    id: string,
  ): boolean => arr?.includes(id) ?? false;

  /** W3.2 — an edit-context / object-type `type` is DECLARED when the
   *  manifest's `contributes.editContexts[]` / `contributes.objectTypes[]`
   *  lists an entry with that `type`. (These are object arrays keyed by
   *  `type`, not flat id arrays, so they need their own predicate.) */
  const declaresType = (
    arr: ReadonlyArray<{ type: string }> | undefined,
    type: string,
  ): boolean => arr?.some((e) => e.type === type) ?? false;

  /** The verdict for the contribution/non-document doors: in 'enforce'
   *  a violation throws PluginCapabilityError; in 'warn' it logs and
   *  the caller proceeds. Returns void either way. */
  const requireDeclared = (
    ok: boolean,
    door: string,
    missing: string,
  ): void => {
    if (ok) return;
    if (capabilityMode === "warn") {
      log.warn(
        `${door} used without declaring it — ${missing} (capabilityMode: ` +
          `'warn'; would refuse in 'enforce')`,
      );
      return;
    }
    throw new PluginCapabilityError(door, missing, manifest.id);
  };

  /** The verdict for the WRITE doors, which never throw (mutate-never-
   *  throws): in 'enforce' a violation returns a failure REASON string
   *  (the caller maps it to `{ applied: false, error }`); in 'warn' it
   *  logs and returns null (proceed). `null` = authorized/allowed. */
  const denyWrite = (ok: boolean, door: string, missing: string): string | null => {
    if (ok) return null;
    const reason = `${door} requires ${missing} (trust-line W0.11)`;
    if (capabilityMode === "warn") {
      log.warn(`${reason} — proceeding (capabilityMode: 'warn')`);
      return null;
    }
    return reason;
  };

  // ---------------------------------------------------- contribute
  // The namespace rule fires FIRST (always loud), then the capability
  // gate: a contributed id must be listed in the matching
  // `contributes.*` category (the manifest is the declaration).
  const contribute: ContributionSurface = {
    tool(c) {
      assertNamespaced(c.id, "tool");
      requireDeclared(
        lists(declared?.tools, c.id),
        "contribute.tool",
        `contributes.tools[] must include "${c.id}"`,
      );
      return store.add(getEditor().registries.tools.register(c));
    },
    panel(c) {
      assertNamespaced(c.id, "panel");
      requireDeclared(
        lists(declared?.panels, c.id),
        "contribute.panel",
        `contributes.panels[] must include "${c.id}"`,
      );
      return store.add(getEditor().registries.panels.register(c));
    },
    schemaPanel(c) {
      // SAME gates as `panel`: the namespace rule (always loud) then the
      // capability gate — a schema panel is still a panel, so its id
      // must be listed in `contributes.panels[]`. It carries NO React;
      // the host's injected `SchemaPanelRenderer` (or the seam fallback)
      // turns the schema + this bundle's `bindings` into the component
      // the registry needs.
      assertNamespaced(c.id, "schemaPanel");
      requireDeclared(
        lists(declared?.panels, c.id),
        "contribute.schemaPanel",
        `contributes.panels[] must include "${c.id}"`,
      );
      const panel: PanelContribution = {
        id: c.id,
        title: c.title,
        icon: c.icon,
        defaultDock: c.defaultDock,
        defaultGroup: c.defaultGroup,
        closable: c.closable,
        movable: c.movable,
        component: makeSchemaPanelComponent(
          c,
          bindings,
          options?.schemaPanelRenderer,
        ),
      };
      const reg = store.add(getEditor().registries.panels.register(panel));
      // Let a host adapter (the headless harness) record the SCHEMA
      // itself; the registry only ever saw the synthesized React panel.
      const recorded = options?.onSchemaPanelRegistered?.(c);
      if (recorded) {
        const d = store.add(recorded);
        return toDisposable(() => {
          reg.dispose();
          d.dispose();
        });
      }
      return reg;
    },
    command(c) {
      assertNamespaced(c.id, "command");
      requireDeclared(
        lists(declared?.commands, c.id),
        "contribute.command",
        `contributes.commands[] must include "${c.id}"`,
      );
      return store.add(getEditor().registries.commands.register(c));
    },
    keybinding(c) {
      // Keybindings carry no id to list; the boolean capability is
      // their declaration.
      requireDeclared(
        caps?.keybindings === true,
        "contribute.keybinding",
        "capabilities.keybindings must be true",
      );
      return store.add(getEditor().registries.keybindings.register(c));
    },
    overlay(c) {
      assertNamespaced(c.id, "overlay");
      requireDeclared(
        hasRendering("overlay"),
        "contribute.overlay",
        'capabilities.rendering must include "overlay"',
      );
      return store.add(getEditor().registries.overlays.register(c));
    },
    // W3.2 (un-reserved — B-02 / W-03): the last two reserved doors. The
    // capability gate keys off the OBJECT arrays in `contributes`
    // (`editContexts[]` / `objectTypes[]` carry `{type,…}`, not flat
    // ids). The shell owns the stack / chrome / write-scope; the SDK
    // adapter just hands the contribution to the editor's registry (or,
    // when the host hasn't wired one — headless / not-yet-adopted —
    // records it through the harness hook). The `type` is a content-type
    // name, NOT a namespaced id, so the namespace rule does NOT apply
    // (the capability gate is the only gate).
    editContext(c) {
      requireDeclared(
        declaresType(declared?.editContexts, c.type),
        "contribute.editContext",
        `contributes.editContexts[] must declare { type: "${c.type}" }`,
      );
      // Stamp the OWN-namespace metadata key so the host resolves the
      // candidate's `metadata` from THIS plugin's envelope before calling
      // `matches` (a bundle never sees a foreign plugin's metadata).
      const stamped: EditContextContribution = {
        ...c,
        metadataKey: metadataKey(manifest),
      };
      const reg = getEditor().registries.editContexts;
      const recorded = options?.onEditContextRegistered?.(stamped);
      if (reg) {
        const d = store.add(reg.register(stamped));
        if (recorded) {
          const r = store.add(recorded);
          return toDisposable(() => {
            d.dispose();
            r.dispose();
          });
        }
        return d;
      }
      // No shell registry wired — the recording stub IS the
      // registration (the door no longer throws). The harness hook (if
      // present) captures it; otherwise it is a tracked no-op.
      if (recorded) return store.add(recorded);
      return store.add(toDisposable(() => {}));
    },
    objectType(c) {
      requireDeclared(
        declaresType(declared?.objectTypes, c.type),
        "contribute.objectType",
        `contributes.objectTypes[] must declare { type: "${c.type}" }`,
      );
      const stamped: ObjectTypeContribution = {
        ...c,
        metadataKey: metadataKey(manifest),
      };
      const reg = getEditor().registries.objectTypes;
      const recorded = options?.onObjectTypeRegistered?.(stamped);
      if (reg) {
        const d = store.add(reg.register(stamped));
        if (recorded) {
          const r = store.add(recorded);
          return toDisposable(() => {
            d.dispose();
            r.dispose();
          });
        }
        return d;
      }
      if (recorded) return store.add(recorded);
      return store.add(toDisposable(() => {}));
    },
    // K-2 / S-06 — document IO. Mirrors `command`: namespaced id the
    // manifest must list, routed to the shell registry. The registry is
    // OPTIONAL on the handle (a host that hasn't wired it stays
    // assignable) — when absent the door is a tracked no-op; the headless
    // harness injects a recording registry so conformance can assert it.
    importer(c) {
      assertNamespaced(c.id, "importer");
      requireDeclared(
        lists(declared?.importers, c.id),
        "contribute.importer",
        `contributes.importers[] must include "${c.id}"`,
      );
      const reg = getEditor().registries.importers;
      if (reg) return store.add(reg.register(c));
      return store.add(toDisposable(() => {}));
    },
    exporter(c) {
      assertNamespaced(c.id, "exporter");
      requireDeclared(
        lists(declared?.exporters, c.id),
        "contribute.exporter",
        `contributes.exporters[] must include "${c.id}"`,
      );
      const reg = getEditor().registries.exporters;
      if (reg) return store.add(reg.register(c));
      return store.add(toDisposable(() => {}));
    },
    // C-1 — the in-frame scene-layer surface. Capability-gated on
    // `rendering ∋ sceneLayer`; routes submit/clear to the editor's scene
    // channel (`getEditor().sceneLayers` → canvas-wasm submit/clear). When
    // no channel is wired (headless / older editor) the surface warns +
    // no-ops (probe `supports("rendering.sceneLayer@1")`). Disposing the
    // surface clears every layer it submitted (tracked so host.dispose()
    // tears them down).
    sceneLayer() {
      requireDeclared(
        hasRendering("sceneLayer"),
        "contribute.sceneLayer",
        'capabilities.rendering must include "sceneLayer"',
      );
      const submitted = new Set<string>();
      const channel = () => getEditor().sceneLayers;
      const surface: SceneLayerSurface = {
        async submit(elementId, layer) {
          const ch = channel();
          if (!ch) {
            log.warn(
              `contribute.sceneLayer().submit("${elementId}") ignored — the ` +
                `host wired no scene channel (probe ` +
                `supports("rendering.sceneLayer@1"))`,
            );
            return;
          }
          submitted.add(elementId);
          await ch.submit(elementId, layer);
        },
        async clear(elementId) {
          submitted.delete(elementId);
          await channel()?.clear(elementId);
        },
        dispose() {
          const ch = channel();
          if (ch) {
            for (const id of submitted) void ch.clear(id);
          }
          submitted.clear();
        },
      };
      return store.add(surface);
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
  /** Read doors require `capabilities.document.read`. Like the
   *  contribution gate, an undeclared read throws in 'enforce' (it is a
   *  manifest bug, surfaced loudly) and logs+proceeds in 'warn'. */
  const requireDocRead = (door: string): void =>
    requireDeclared(
      hasDoc("read"),
      door,
      "capabilities.document.read must be declared",
    );
  const document: DocumentSurface = {
    async mutate(mutation: Mutation): Promise<MutationOutcome> {
      // Write-door capability gate (mutate-never-throws → non-applied
      // outcome). The namespace gate below stays loud regardless.
      const denied = denyWrite(
        hasDoc("write"),
        "document.mutate",
        "capabilities.document.write",
      );
      if (denied !== null) return { applied: false, error: denied };
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
      // undo/redo move shared history — write doors. They return void,
      // so an undeclared call throws (enforce) / warns (warn) rather
      // than silently no-opping.
      requireDeclared(
        hasDoc("write"),
        "document.undo",
        "capabilities.document.write",
      );
      await getEditor().client.undo();
    },
    async redo() {
      requireDeclared(
        hasDoc("write"),
        "document.redo",
        "capabilities.document.write",
      );
      await getEditor().client.redo();
    },
    collection(name) {
      requireDocRead("document.collection");
      return getEditor().client.collection(name);
    },
    meta() {
      requireDocRead("document.meta");
      return getEditor().client.documentMeta();
    },
    pathAnchors(id: ElementId) {
      requireDocRead("document.pathAnchors");
      return getEditor()
        .client.pathAnchors(id)
        .catch(() => null);
    },
    async hitTest(
      pageId,
      point,
      filter: HitFilter = "any",
    ): Promise<HitResult | null> {
      // hitTest is a render-pipeline read: it needs BOTH a document
      // read AND the `hitTest` rendering surface (the host-side picking
      // service). Both must be declared.
      requireDocRead("document.hitTest");
      requireDeclared(
        hasRendering("hitTest"),
        "document.hitTest",
        'capabilities.rendering must include "hitTest"',
      );
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
      requireDocRead("document.elementGeometry");
      return getEditor().client.elementGeometry(ids);
    },
    async placeholders() {
      // D-01 — the read half of the tagged-placeholder loop (protocol
      // v43). Channel failure answers an empty list, never a throw.
      requireDocRead("document.placeholders");
      try {
        const reply = await getEditor().client.send({
          kind: "requestDocumentPlaceholders",
        });
        return reply.kind === "documentPlaceholders"
          ? reply.payload.items
          : [];
      } catch {
        return [];
      }
    },
    async elementProperties(id) {
      // B-19 — the typed read over `requestElementProperties` (the same
      // wire query getMetadata filters); null on miss or channel failure.
      requireDocRead("document.elementProperties");
      try {
        const reply = await getEditor().client.send({
          kind: "requestElementProperties",
          payload: { id },
        });
        return reply.kind === "elementProperties"
          ? reply.payload.result
          : null;
      } catch {
        return null;
      }
    },
    async tree(): Promise<SceneTreeNode[]> {
      requireDocRead("document.tree");
      const reply = await getEditor().client.send({
        kind: "requestSceneTree",
      });
      return reply.kind === "sceneTree" ? reply.payload.roots : [];
    },
    async getMetadata(id) {
      requireDocRead("document.getMetadata");
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
      // the 64 KiB cap and the envelope shape). B-16: name the calling
      // plugin so the ENGINE cross-checks the key is in this plugin's
      // `x-paged:<id>` namespace (protocol v36, additive) — defense in
      // depth that holds even for a bundle reaching the raw handle, and
      // the teeth the isolate boundary will rely on.
      return this.mutate({
        op: "setPluginMetadata",
        args: {
          elementId: id,
          key: metadataKey(manifest),
          value: envelope === null ? null : JSON.stringify(envelope),
          caller: manifest.id,
        },
      });
    },
    async frameChain(storyId: string): Promise<FrameChainLink[]> {
      requireDocRead("document.frameChain");
      const reply = await getEditor().client.send({
        kind: "requestFrameChain",
        payload: { storyId },
      });
      return reply.kind === "frameChainResult" ? reply.payload.links : [];
    },
    onDidChange(listener: (e: DocumentChangeEvent) => void): Disposable {
      requireDocRead("document.onDidChange");
      const off = getEditor().client.subscribe((msg) => {
        if (
          msg.kind === "mutationApplied" ||
          msg.kind === "undoApplied" ||
          msg.kind === "redoApplied"
        ) {
          // Reflow (v38, C-2): only `mutationApplied` carries it, and only
          // when a resizeFrame changed a content box (§8.5). Pass it through
          // so a pagination consumer re-splits on resize, not on transform.
          const reflow =
            msg.kind === "mutationApplied" ? msg.payload.reflow : undefined;
          listener({
            kind: msg.kind,
            pageIds: msg.payload.pageIds,
            ...(reflow
              ? { reflow: { frameId: reflow.frameId, contentBox: reflow.contentBox } }
              : {}),
          });
        }
      });
      return store.add(toDisposable(off));
    },
  };

  // ----------------------------------------------------- selection
  // Reading selection (get/onDidChange) is ambient UI state — every
  // bundle may observe it, no capability needed. CHANGING it
  // (`selection.set`) is a document-level action, gated on
  // `capabilities.document.write` (the post-insert select pattern is
  // part of a write flow).
  const selection: SelectionSurface = {
    get() {
      return getEditor().selection.elementSelection;
    },
    async set(ids: ElementId[], mode: SelectionMode = "replace") {
      requireDeclared(
        hasDoc("write"),
        "selection.set",
        "capabilities.document.write",
      );
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

  // --------------------------------------------------------- text
  // Font measurement (S-13). A read door — no capability gate (like
  // `viewport`). Routes to the editor's shaper when wired; otherwise an
  // honest monospace-ish estimate so headless / older editors stay
  // usable (the plugin checks `supports("text.measure@1")` to know which
  // it got). `~0.5em` advance + `0.8em/0.2em` asc/desc are the standard
  // fallback the bundle already used before this door existed.
  const text: TextSurface = {
    async measureString(family, style, str, sizePt) {
      const editorText = getEditor().text;
      if (editorText) {
        return editorText.measure(family, style, str, sizePt);
      }
      return {
        advance: str.length * sizePt * 0.5,
        ascender: sizePt * 0.8,
        descender: -sizePt * 0.2,
      };
    },
  };

  // ------------------------------------------------------- overlay
  // The tool-preview channel is a render-pipeline surface — gated on
  // `capabilities.rendering` including "overlay" (same surface as
  // `contribute.overlay`).
  const overlay: OverlaySurface = {
    setToolPreview(shape) {
      requireDeclared(
        hasRendering("overlay"),
        "overlay.setToolPreview",
        'capabilities.rendering must include "overlay"',
      );
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

  // --------------------------------------------------- network (D-03)
  //
  // `capabilities.network` is the OUTER bound (the origins the bundle MAY ever
  // request); per-origin user consent is the inner gate. Remembered grants
  // persist in the bundle's own storage namespace. No consent backend wired →
  // every request is denied (honest no-consent posture). The host never proxies
  // bytes; a granted origin authorizes the BUNDLE's own reach (DuckDB httpfs),
  // enforced at the realm boundary by the editor's CSP (the editor follow-up).
  const declaredNetwork = manifest.capabilities?.network;
  const networkDeclared =
    declaredNetwork === true ||
    (typeof declaredNetwork === "object" && declaredNetwork !== null);
  const mayRequest = (origin: string): boolean => {
    if (declaredNetwork === true) return true;
    if (typeof declaredNetwork === "object" && declaredNetwork !== null) {
      const o = declaredNetwork.origins;
      return o === "consent" || (Array.isArray(o) && o.includes(origin));
    }
    return false;
  };
  const CONSENT_KEY = "network.consentedOrigins";
  const granted = new Set<string>(storage.get<string[]>(CONSENT_KEY) ?? []);
  const network: NetworkSurface = {
    async requestConsent(origins, purpose): Promise<ConsentResult> {
      requireDeclared(
        networkDeclared,
        "network.requestConsent",
        "capabilities.network must declare the network capability (boolean or { origins })",
      );
      const inScope = origins.filter(mayRequest);
      const outOfScope = origins.filter((o) => !mayRequest(o));
      if (outOfScope.length > 0) {
        log.warn(
          `network.requestConsent: ${outOfScope.length} origin(s) outside the ` +
            `declared capabilities.network allow-list — denied: ${outOfScope.join(", ")}`,
        );
      }
      const need = inScope.filter((o) => !granted.has(o));
      let prompted: ConsentResult = { granted: [], denied: [], remembered: false };
      if (need.length > 0) {
        if (options?.consent) {
          prompted = await options.consent.request(need, purpose);
        } else {
          log.warn(
            "network.requestConsent: no consent backend wired — denying " +
              "(supports('network.consent@1') is false; the editor injects one)",
          );
          prompted = { granted: [], denied: need, remembered: false };
        }
      }
      for (const o of prompted.granted) granted.add(o);
      if (prompted.remembered) storage.set(CONSENT_KEY, [...granted]);
      return {
        granted: inScope.filter((o) => granted.has(o)),
        denied: [...outOfScope, ...inScope.filter((o) => !granted.has(o))],
        remembered: prompted.remembered,
      };
    },
    consentedOrigins() {
      return [...granted];
    },
  };

  // ----------------------------------------- data providers (D-09)
  //
  // The cross-plugin registry is a SHARED backend (options.dataProviders) the
  // editor injects identically into every plugin host; this surface adds the
  // per-plugin capability gate: register needs publish ∋ category, discover/get
  // need consume. No backend wired → discover empty, register a no-op handle,
  // get null (graceful absence + the honest no-registry posture).
  const dpCap = manifest.capabilities?.dataProviders;
  const mayPublish = (category: string): boolean =>
    Array.isArray(dpCap?.publish) && dpCap.publish.includes(category);
  const mayConsume = (category?: string): boolean =>
    Array.isArray(dpCap?.consume) &&
    (category === undefined || dpCap.consume.includes(category));
  const consumeDeclared =
    Array.isArray(dpCap?.consume) && dpCap.consume.length > 0;
  const dataProviders: DataProvidersSurface = {
    register(registration) {
      requireDeclared(
        mayPublish(registration.category),
        "dataProviders.register",
        `capabilities.dataProviders.publish must include "${registration.category}"`,
      );
      if (!options?.dataProviders) {
        log.warn(
          `dataProviders.register("${registration.id}") — no shared registry ` +
            "wired (supports('dataProviders@1') is false; the editor injects one)",
        );
        return { update() {}, dispose() {} };
      }
      return options.dataProviders.register(registration);
    },
    discover(category) {
      requireDeclared(
        mayConsume(category),
        "dataProviders.discover",
        "capabilities.dataProviders.consume must include the category",
      );
      return options?.dataProviders?.discover(category) ?? [];
    },
    async get(id) {
      requireDeclared(
        consumeDeclared,
        "dataProviders.get",
        "capabilities.dataProviders.consume must be declared",
      );
      return (await options?.dataProviders?.get(id)) ?? null;
    },
    onDidChange(id, listener) {
      if (!options?.dataProviders) return toDisposable(() => undefined);
      return store.add(options.dataProviders.onDidChange(id, listener));
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
      // Console mirror — the v0 floor (a problems panel consumes the
      // SAME store via the injected sink; the mirror stays for
      // headless hosts).
      for (const d of items) {
        const line = `${tag} ${key}: ${d.message}` +
          (d.line !== undefined ? ` (${d.source ?? ""}:${d.line})` : "");
        if (d.severity === "error") sink.error(line);
        else if (d.severity === "warning") sink.warn(line);
        else sink.info(line);
      }
      // Fan out to the host problems panel (W-05) keyed by bundle id.
      options?.diagnosticsSink?.publish(manifest.id, key, items);
      emitDiagnostics(key);
    },
    clear(key) {
      if (key !== undefined) diagnosticStore.delete(key);
      else diagnosticStore.clear();
      options?.diagnosticsSink?.clear(manifest.id, key);
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

  // -------------------------------------------------------- bindings
  // The publish-bindings store (W3.1) — named reactive values the
  // bundle publishes; schema rows reference them via `{ bind: name }`
  // for visible/enabled. The plugin owns the derivation; the store owns
  // the lookup + change fan-out (the host's SchemaPanelRenderer
  // subscribes). JSON-only, in-memory, per-bundle (cleared on dispose
  // via the listener teardown through the DisposableStore).
  const bindingStore = new Map<string, unknown>();
  const bindingListeners = new Set<(name: string) => void>();
  const emitBinding = (name: string) => {
    for (const l of bindingListeners) l(name);
  };
  const bindings: BindingsSurface = {
    publish(name, value) {
      bindingStore.set(name, value);
      emitBinding(name);
    },
    get(name) {
      return bindingStore.get(name);
    },
    delete(name) {
      if (bindingStore.delete(name)) emitBinding(name);
    },
    onDidChange(listener) {
      bindingListeners.add(listener);
      return store.add(toDisposable(() => bindingListeners.delete(listener)));
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
    async pickFile() {
      // No picker wired (headless / not-yet-adopted host): the honest
      // no-picker door resolves empty (probe supports("shell.pickFile@1")).
      log.warn(
        `shell.pickFile() ignored — the host app provided no shell actions ` +
          `(probe with supports("shell.pickFile@1"))`,
      );
      return [];
    },
  };

  // --------------------------------------------------------- widgets
  // The host app owns the widget catalog (W-04). When it injects one,
  // bundles get the rich CodeEditor; otherwise the plain-textarea
  // fallback stands in — same props contract, honest seam.
  const widgets: WidgetSurface = options?.widgets ?? FALLBACK_WIDGETS;

  // --------------------------------------------------------- assets
  // The capability-gated asset store (W-06). READ-ONLY: serves the
  // bytes the DOCUMENT already holds for a face, through the injected
  // `assetSource` — never a network fetch on the bundle's behalf
  // (offline-forever, DESIGN.md §13.3). The gate (`getFontFace` needs
  // `capabilities.assets` ∋ "fonts") is a READ door: it THROWS in
  // 'enforce', warns+proceeds in 'warn', like every other read door.
  // No source injected → every read answers `null` (the honest
  // no-bytes door), and `supports("assets.fonts@1")` is false.
  const assetSource = options?.assetSource;
  const assets: AssetSurface = {
    async getFontFace(family, style) {
      requireDeclared(
        hasAsset("fonts"),
        "assets.getFontFace",
        'capabilities.assets must include "fonts"',
      );
      if (!assetSource) return null;
      let face: FontFaceAsset | null;
      try {
        face = await assetSource.getFontFace(family, style);
      } catch {
        // A throwing source must not break a bundle's preview — the
        // door's failure mode is "no bytes", not an exception.
        return null;
      }
      if (!face) return null;
      // Budget clamp — refuse an over-budget face rather than hand a
      // bundle an unbounded buffer (DESIGN.md §13.3).
      if (face.bytes.byteLength > ASSET_BUDGETS.maxFontFaceBytes) {
        log.warn(
          `assets.getFontFace("${family}"${style ? `, "${style}"` : ""}) ` +
            `served ${face.bytes.byteLength} bytes, over the ` +
            `${ASSET_BUDGETS.maxFontFaceBytes}-byte per-face cap — refused`,
        );
        return null;
      }
      return face;
    },
    // C-5 / I-04 (core v42): a placed DOCUMENT image's ORIGINAL bytes,
    // straight from the engine's resolver/parse cache through the
    // `requestPlacedAssetBytes` wire query — no injected source needed
    // (the engine IS the byte holder). `found:false` and any channel
    // failure both answer `null`, the door's honest no-bytes mode. No
    // size clamp: document-scale originals (PSDs) are the use case and
    // the engine only serves what the document already holds.
    async getPlacedImage(elementId) {
      requireDeclared(
        hasAsset("images"),
        "assets.getPlacedImage",
        'capabilities.assets must include "images"',
      );
      try {
        const reply = await getEditor().client.send({
          kind: "requestPlacedAssetBytes",
          payload: { elementId },
        });
        if (reply.kind !== "placedAssetBytes" || !reply.payload.found) {
          return null;
        }
        const p = reply.payload;
        return {
          bytes: Uint8Array.from(p.encoded),
          uri: p.uri,
          width: p.width,
          height: p.height,
        };
      } catch {
        return null;
      }
    },
  };

  // --------------------------------------------------------- images
  // The capability-gated RENDERER RESOURCE-PROVIDER door (C-6 / I-06; the
  // v44 wire). A claim registers a placed image's pyramid with the
  // renderer (`channel.claim` → `claimImageResource`); the renderer pulls
  // tiles it needs by emitting `resourceTilesNeeded`, which the editor
  // surfaces through `channel.onResourceTilesNeeded`. THE SDK ADAPTER
  // OWNS THE PLUMBING: per needed event for THIS image, it calls the
  // bundle's `source(level, x, y)` for each grid origin, batches the
  // non-null results, and submits them (`channel.submitTiles` →
  // `submitResourceTiles`) echoing the generation so a stale reply is
  // dropped worker-side. Disposing the claim releases it (`channel.release`
  // → `releaseImageResource`) and stops routing its needed events. The
  // gate is a render-pipeline door: `claimImageResource` requires
  // `capabilities.rendering` ∋ "resourceProvider" (throws in 'enforce',
  // warns in 'warn'). No channel wired → claim warns + returns an inert
  // Disposable and `supports("rendering.resourceProvider@1")` is false.
  const imageChannel = () => getEditor().images;
  const images: ImagesSurface = {
    claimImageResource(elementId: string, opts: ImageResourceClaimOptions) {
      requireDeclared(
        hasRendering("resourceProvider"),
        "images.claimImageResource",
        'capabilities.rendering must include "resourceProvider"',
      );
      const channel = imageChannel();
      if (!channel) {
        log.warn(
          `images.claimImageResource("${elementId}") ignored — the host ` +
            `wired no resource channel (probe ` +
            `supports("rendering.resourceProvider@1"))`,
        );
        return store.add(toDisposable(() => {}));
      }
      let released = false;
      // Route only THIS image's needed events; pull → submit per miss.
      const off = channel.onResourceTilesNeeded((need) => {
        if (released || need.imageId !== elementId) return;
        void (async () => {
          const tiles: ProviderTileWire[] = [];
          for (const [x, y] of need.tiles) {
            let tile: Awaited<ReturnType<typeof opts.source>>;
            try {
              tile = await opts.source(need.level, x, y);
            } catch (err) {
              // A throwing source must not strand the fill — skip the
              // tile (the renderer keeps the fallback level for it).
              log.warn(
                `images.source(level ${need.level}, ${x}, ${y}) threw — ` +
                  `tile skipped`,
                err,
              );
              continue;
            }
            if (!tile) continue;
            tiles.push({
              x: tile.x,
              y: tile.y,
              width: tile.width,
              height: tile.height,
              // The wire carries a plain number[]; Array.from copies the
              // RGBA8 view (isolate-proxy-safe, like the scene-layer path).
              rgba: Array.from(tile.rgba),
            });
          }
          if (released || tiles.length === 0) return;
          try {
            await channel.submitTiles(
              elementId,
              need.level,
              tiles,
              need.generation,
            );
          } catch (err) {
            log.warn(
              `images.submitTiles("${elementId}", level ${need.level}) failed`,
              err,
            );
          }
        })();
      });
      // The claim itself — fire-and-forget; the renderer registers it and
      // begins pulling. A claim that races a release is harmless (release
      // wins via `released`).
      void channel
        .claim({
          imageId: elementId,
          levels: opts.levels,
          tileSize: opts.tileSize,
          baseWidth: opts.baseWidth,
          baseHeight: opts.baseHeight,
          revision: opts.revision(),
        })
        .catch((err) => {
          log.warn(`images.claim("${elementId}") failed`, err);
        });
      return store.add(
        toDisposable(() => {
          if (released) return;
          released = true;
          off();
          void channel.release(elementId).catch((err) => {
            log.warn(`images.release("${elementId}") failed`, err);
          });
        }),
      );
    },
  };

  // --------------------------------------------------------- blob
  // The capability-gated binary store (K-4 / S-08). Per-plugin namespaced
  // (the adapter passes manifest.id; the backend scopes by it), quota-
  // clamped (the stricter of the host default and the manifest's
  // requested storage.quotaBytes). No backend injected → reads answer
  // empty, writes reject (the honest no-store door); supports() is false.
  const blobBackend = options?.blobStore;
  const blobQuota = Math.min(
    BLOB_BUDGETS.defaultQuotaBytes,
    caps?.storage?.quotaBytes ?? BLOB_BUDGETS.defaultQuotaBytes,
  );
  const blobGate = (door: string): void =>
    requireDeclared(
      hasBlobStore(),
      door,
      'capabilities.storage must include { blob: true }',
    );
  const blob: BlobSurface = {
    async write(key, bytes) {
      blobGate("blob.write");
      if (!blobBackend) {
        throw new Error(
          `host.blob.write("${key}") — no blob store wired ` +
            `(supports("storage.blob@1") is false; the editor injects one)`,
        );
      }
      // Overwrite = delete-then-write so `used` already excludes the old
      // value; then the quota check is a simple projected-total compare.
      await blobBackend.delete(manifest.id, key);
      const used = await blobBackend.used(manifest.id);
      if (used + bytes.byteLength > blobQuota) {
        throw new Error(
          `host.blob.write("${key}") — ${bytes.byteLength} bytes would ` +
            `exceed the ${blobQuota}-byte quota (used ${used}) — refused`,
        );
      }
      await blobBackend.write(manifest.id, key, bytes);
    },
    async read(key) {
      blobGate("blob.read");
      if (!blobBackend) return null;
      return blobBackend.read(manifest.id, key);
    },
    async delete(key) {
      blobGate("blob.delete");
      if (!blobBackend) return;
      await blobBackend.delete(manifest.id, key);
    },
    async keys() {
      blobGate("blob.keys");
      if (!blobBackend) return [];
      return blobBackend.keys(manifest.id);
    },
    async usage() {
      blobGate("blob.usage");
      if (!blobBackend) return { used: 0, quota: 0 };
      return { used: await blobBackend.used(manifest.id), quota: blobQuota };
    },
  };

  // ----------------------------------------------------- clipboard
  // The capability-gated SYSTEM-clipboard door (K-6 / S-14). Read/write a
  // `{ text?, tabular? }` payload through the injected backend. The gate
  // is a READ-AND-WRITE door: it THROWS in 'enforce' (a manifest bug —
  // the bundle used a door it didn't declare), warns+proceeds in 'warn',
  // like every other gated door. The TIER decides tabular: `"full"` ⇒
  // both halves; `"vector"` ⇒ text only (a tabular WRITE is stripped + a
  // tabular READ is never surfaced); `"none"`/absent ⇒ denied. No backend
  // wired → read answers `null`, write no-ops (the honest no-clipboard
  // door); supports("clipboard@1") is false.
  const clipboardBackend = options?.clipboard;
  const clipboardGate = (door: string): "full" | "vector" => {
    const grant = clipboardGrant();
    requireDeclared(
      grant !== "none",
      door,
      'capabilities.clipboard must be "full" or "vector"',
    );
    // In 'warn' mode an undeclared bundle reaches here with grant "none";
    // treat the proceed as the narrower "vector" tier (text only) so a
    // warn-migration host never silently leaks a cell grid.
    return grant === "full" ? "full" : "vector";
  };
  const clipboard: ClipboardSurface = {
    async read() {
      const tier = clipboardGate("clipboard.read");
      if (!clipboardBackend) return null;
      let payload: ClipboardPayload | null;
      try {
        payload = await clipboardBackend.read();
      } catch {
        // A throwing/denied platform read is "nothing readable", not an
        // exception the bundle must handle.
        return null;
      }
      if (!payload) return null;
      // A "vector" grant never receives the tabular half.
      if (tier === "vector" && payload.tabular !== undefined) {
        const { tabular: _dropped, ...rest } = payload;
        return rest;
      }
      return payload;
    },
    async write(payload: ClipboardPayload) {
      const tier = clipboardGate("clipboard.write");
      if (!clipboardBackend) return;
      let toWrite = payload;
      // A "vector" grant may only write text — strip a supplied tabular
      // half (log once so the author sees the honest narrowing).
      if (tier === "vector" && payload.tabular !== undefined) {
        log.warn(
          'clipboard.write: dropping the tabular payload — capabilities.clipboard ' +
            'is "vector" (text only); declare "full" to copy a cell grid',
        );
        const { tabular: _dropped, ...rest } = payload;
        toWrite = rest;
      }
      try {
        await clipboardBackend.write(toWrite);
      } catch (err) {
        // A platform refusal (no user gesture, permission denied) is not a
        // bundle error — the door's failure mode is "nothing copied".
        log.warn("clipboard.write: the platform refused the write", err);
      }
    },
  };

  const featureSet = new Set(HOST_FEATURES);
  if (getEditor().text) {
    // The door always exists (it falls back to an estimate); the FEATURE
    // flag means "a real engine shaper is wired" — a bundle probes it to
    // decide whether to trust measured widths for cross-surface fidelity.
    featureSet.add("text.measure@1");
  }
  if (getEditor().sceneLayers) {
    // C-1 — a real scene channel is wired (the editor routes to the
    // canvas-wasm submit/clear). The contribute.sceneLayer() door always
    // exists (warns + no-ops without this); the flag tells a bundle the
    // in-frame layer will actually render.
    featureSet.add("rendering.sceneLayer@1");
  }
  if (getEditor().images) {
    // C-6 (I-06) — a real resource channel is wired (the editor routes the
    // v44 claim/submit/release + surfaces resourceTilesNeeded). The
    // host.images door always exists (warns + no-ops without this); the
    // flag tells a bundle the renderer will actually pull its tiles.
    featureSet.add("rendering.resourceProvider@1");
  }
  if (options?.shell) {
    featureSet.add("shell.openPanel@1");
    // A wired shell implements the file picker too (the ShellSurface
    // contract mandates pickFile); the flag tells a bundle a real picker
    // is reachable rather than the empty no-picker door (K-5 / S-11).
    featureSet.add("shell.pickFile@1");
  }
  if (options?.widgets) {
    featureSet.add("widgets.codeEditor@1");
  }
  if (options?.schemaPanelRenderer) {
    featureSet.add("schemaPanel.renderer@1");
  }
  if (options?.diagnosticsSink) {
    featureSet.add("diagnostics.publish@1");
  }
  if (options?.assetSource) {
    // The door always exists; the FEATURE flag means "a real byte
    // source is wired" — a bundle probes it to decide whether to
    // attempt `@font-face` composition at all.
    featureSet.add("assets.fonts@1");
  }
  if (options?.consent) {
    // The network door always exists (default-deny); this flag means a real
    // consent backend is wired, so a bundle can actually obtain a grant (D-03).
    featureSet.add("network.consent@1");
  }
  if (options?.dataProviders) {
    // The door always exists (no-registry fallback); this flag means a real
    // SHARED registry is wired, so providers + consumers can actually
    // rendezvous (D-09).
    featureSet.add("dataProviders@1");
  }
  if (options?.blobStore) {
    // The blob door always exists (no-store fallback); this flag means a
    // real OPFS/backing store is wired, so a bundle can actually persist
    // bytes (K-4 / S-08).
    featureSet.add("storage.blob@1");
  }
  if (options?.clipboard) {
    // The clipboard door always exists (no-clipboard fallback); this flag
    // means a real system-clipboard backend is wired, so a bundle can
    // actually read/write the clipboard (K-6 / S-14).
    featureSet.add("clipboard@1");
  }

  const host: BundleHost = {
    manifest,
    log,
    contribute,
    document,
    selection,
    viewport,
    text,
    overlay,
    shell,
    storage,
    blob,
    network,
    dataProviders,
    diagnostics,
    bindings,
    widgets,
    assets,
    images,
    clipboard,
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
