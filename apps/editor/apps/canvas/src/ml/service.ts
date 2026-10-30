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

// The editor's ML service (editor ADR 290): both tiers behind the ML doors
// (extensions ADR 1100). It owns
//   · the registry (what can be installed),
//   · the Tier-A cache (OPFS) and one provider per downloadable model,
//     answered by the ML worker,
//   · the Tier-B provider over the local generative host, its health and
//     its configuration (model paths the user gives, the licence the user
//     acknowledged),
//   · the user's choices: the quantisation per model and the licences
//     acknowledged (localStorage, shape-checked, ADR 247),
// and registers its providers into the ONE ML backend every bundle host
// shares, so `supports("ml.x@1")` follows what is installed and healthy.
// Settings ▸ Models reads it through `subscribe`/`snapshot`.

import type { MlImage } from "@paged-media/plugin-api";
import {
  mlHostProvider,
  type MlBackend,
  type MlHostClient,
  type MlHostConfig,
  type MlHostHealth,
  type MlHostProvider,
  type MlPngCodec,
  type MlProviderHandle,
} from "@paged-media/plugin-sdk";

import type { GpuInfo } from "./gpu";
import type {
  InstallProgress,
  InstallRecord,
  ModelConsent,
  ModelStore,
} from "./model-store";
import type { ModelEntry, ModelRegistry } from "./registry";
import { variantBytes, variantOf } from "./registry";
import { tierAProvider, type TierAProvider } from "./tier-a-provider";
import type { MlWorkerClient } from "./worker-protocol";

export const ML_SETTINGS_KEY = "paged.ml.settings";

/** What the user chose, kept between sessions. */
export interface MlSettings {
  /** Model id → the chosen variant. */
  variants: Record<string, string>;
  /** Model id → the licence id acknowledged (a changed licence asks
   *  again). */
  acknowledged: Record<string, string>;
}

const isStringRecord = (v: unknown): v is Record<string, string> =>
  typeof v === "object" &&
  v !== null &&
  !Array.isArray(v) &&
  Object.values(v).every((x) => typeof x === "string");

/** Read stored settings field by field (ADR 247). */
export function readMlSettings(raw: string | null | undefined): MlSettings {
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : undefined;
  } catch {
    parsed = undefined;
  }
  const o =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  return {
    variants: isStringRecord(o["variants"]) ? { ...o["variants"] } : {},
    acknowledged: isStringRecord(o["acknowledged"])
      ? { ...o["acknowledged"] }
      : {},
  };
}

export interface SettingsStorage {
  get(): string | null;
  set(value: string): void;
}

export function localSettingsStorage(): SettingsStorage {
  return {
    get() {
      try {
        return localStorage.getItem(ML_SETTINGS_KEY);
      } catch {
        return null;
      }
    },
    set(value) {
      try {
        localStorage.setItem(ML_SETTINGS_KEY, value);
      } catch {
        // storage unavailable: the choice lasts this session
      }
    },
  };
}

export interface ModelState {
  entry: ModelEntry;
  /** The chosen variant id. */
  variant: string;
  /** Bytes of the chosen variant (null: not known). */
  variantBytes: number | null;
  /** The licence acknowledged by the user (its current id). */
  acknowledged: boolean;
  /** Tier A: what is installed. */
  installed: InstallRecord | null;
  /** Tier A: the cache's bytes for it. */
  diskBytes: number;
  /** A running install. */
  progress: InstallProgress | null;
  /** The last thing that went wrong with it. */
  error: string | null;
  /** The provider answers now. */
  healthy: boolean;
  /** Where it runs / why it does not. */
  detail: string | null;
}

export interface MlServiceSnapshot {
  models: ModelState[];
  diskTotal: number;
  /** Whether this editor runs in-browser models (Tier A): an embed of
   *  `@paged-media/editor` ships without the ML worker (editor ADR 290). */
  tierA: boolean;
  gpu: GpuInfo | null;
  host: {
    health: MlHostHealth | null;
    config: MlHostConfig | null;
    detail: string;
    error: string | null;
  };
}

export interface MlServiceOptions {
  backend: MlBackend;
  registry: ModelRegistry;
  store: ModelStore;
  /** The ML worker; `null` where the build has none (the embedded editor):
   *  no Tier-A provider is registered, so `ml.segment@1` and its kin
   *  answer false. */
  worker: (() => MlWorkerClient) | null;
  host: MlHostClient;
  codec: MlPngCodec;
  settings?: SettingsStorage;
  detectGpu?: () => Promise<GpuInfo>;
  /** Health poll of the local host (ms); 0 polls never. */
  pollMs?: number;
}

/** The fields of a Tier-B model the user gives. */
export interface HostModelPaths {
  sdBinary: string;
  diffusionModel: string;
  textEncoder: string;
  vae: string;
}

export class MlService {
  private readonly o: MlServiceOptions;
  private readonly storage: SettingsStorage;
  private settings: MlSettings;
  private readonly tierA = new Map<string, TierAProvider>();
  private readonly handles: MlProviderHandle[] = [];
  private hostProvider: MlHostProvider | null = null;
  private readonly progress = new Map<string, InstallProgress>();
  private readonly errors = new Map<string, string>();
  private readonly records = new Map<string, InstallRecord | null>();
  private disk: { total: number; byModel: Record<string, number> } = {
    total: 0,
    byModel: {},
  };
  private gpu: GpuInfo | null = null;
  private hostConfig: MlHostConfig | null = null;
  private hostError: string | null = null;
  private readonly listeners = new Set<() => void>();
  private current: MlServiceSnapshot;
  private timer: ReturnType<typeof setInterval> | null = null;
  private started = false;

  constructor(options: MlServiceOptions) {
    this.o = options;
    this.storage = options.settings ?? localSettingsStorage();
    this.settings = readMlSettings(this.storage.get());
    this.current = this.build();
  }

  /** The models the panel offers (enabled entries). */
  get entries(): ModelEntry[] {
    return this.o.registry.models.filter((m) => m.enabled);
  }

  private entry(id: string): ModelEntry {
    const e = this.entries.find((m) => m.id === id);
    if (!e) throw new Error(`no model "${id}" in the registry`);
    return e;
  }

  /** Register the providers, read the cache, check the host and the GPU. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const worker = this.o.worker;
    for (const entry of this.entries) {
      if (entry.tier !== "A" || !worker) continue;
      const p = tierAProvider({
        entry,
        store: this.o.store,
        worker,
        record: null,
        onStatus: () => this.changed(),
      });
      this.tierA.set(entry.id, p);
      this.handles.push(this.o.backend.register(p));
    }
    if (this.entries.some((e) => e.tier === "B")) {
      let handle: MlProviderHandle | null = null;
      const tierB = this.entries.find((e) => e.tier === "B")!;
      this.hostProvider = mlHostProvider({
        client: this.o.host,
        codec: this.o.codec,
        id: "paged.ml-host",
        title: tierB.title,
        onStatus: () => handle?.changed(),
      });
      handle = this.o.backend.register(this.hostProvider);
      this.handles.push(handle);
    }
    await Promise.all([
      this.readCache(),
      this.refreshHost(),
      (this.o.detectGpu?.() ?? Promise.resolve(null)).then((g) => {
        this.gpu = g;
      }),
    ]);
    this.changed();
    const poll = this.o.pollMs ?? 15_000;
    if (poll > 0)
      this.timer = setInterval(() => {
        if (typeof document === "undefined" || !document.hidden)
          void this.refreshHost();
      }, poll);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const h of this.handles.splice(0)) h.dispose();
    for (const p of this.tierA.values()) void p.release();
    this.tierA.clear();
    this.listeners.clear();
  }

  private async readCache(): Promise<void> {
    for (const entry of this.entries) {
      if (entry.tier !== "A") continue;
      const record = await this.o.store.installed(entry);
      this.records.set(entry.id, record);
      this.tierA.get(entry.id)?.setInstalled(record);
    }
    this.disk = await this.o.store.diskUse();
  }

  // ------------------------------------------------------------ reads

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot = (): MlServiceSnapshot => this.current;

  private changed(): void {
    this.current = this.build();
    for (const l of [...this.listeners]) l();
  }

  private build(): MlServiceSnapshot {
    const providers = new Map(this.o.backend.providers().map((p) => [p.id, p]));
    const models = this.entries.map((entry): ModelState => {
      const variant = variantOf(entry, this.settings.variants[entry.id]);
      const pid = entry.tier === "A" ? `paged.ml.${entry.id}` : "paged.ml-host";
      const info = providers.get(pid);
      const record = this.records.get(entry.id) ?? null;
      return {
        entry,
        variant: variant.id,
        variantBytes: variantBytes(variant),
        acknowledged: this.settings.acknowledged[entry.id] === entry.licence.id,
        installed: record,
        diskBytes: this.disk.byModel[entry.id] ?? 0,
        progress: this.progress.get(entry.id) ?? null,
        error: this.errors.get(entry.id) ?? null,
        healthy: info?.healthy ?? false,
        detail: info?.detail ?? null,
      };
    });
    const health = this.hostProvider?.lastHealth ?? null;
    return {
      models,
      diskTotal: this.disk.total,
      tierA: this.o.worker !== null,
      gpu: this.gpu,
      host: {
        health,
        config: this.hostConfig,
        detail: this.hostProvider?.status().detail ?? "no local model offered",
        error: this.hostError,
      },
    };
  }

  // ----------------------------------------------------------- writes

  private save(): void {
    this.storage.set(JSON.stringify(this.settings));
  }

  chooseVariant(id: string, variant: string): void {
    const entry = this.entry(id);
    if (!entry.variants.some((v) => v.id === variant))
      throw new Error(`${entry.title} has no variant "${variant}"`);
    this.settings.variants[id] = variant;
    this.save();
    this.changed();
  }

  acknowledgeLicence(id: string, acknowledged: boolean): void {
    const entry = this.entry(id);
    if (acknowledged) this.settings.acknowledged[id] = entry.licence.id;
    else delete this.settings.acknowledged[id];
    this.save();
    this.changed();
  }

  /** The origins the chosen variant of a model downloads from. */
  downloadOrigins(id: string): string[] {
    const entry = this.entry(id);
    return this.o.store.originsOf(variantOf(entry, this.settings.variants[id]));
  }

  /** Download and keep a Tier-A model (the consent dialog's answer). */
  async install(id: string, consent: ModelConsent): Promise<void> {
    const entry = this.entry(id);
    this.errors.delete(id);
    this.progress.set(id, { file: "", loaded: 0, total: 0 });
    this.changed();
    try {
      const record = await this.o.store.install(entry, {
        variant: this.settings.variants[id] ?? entry.defaultVariant,
        consent,
        onProgress: (p) => {
          this.progress.set(id, p);
          this.changed();
        },
      });
      if (consent.licenceAcknowledged)
        this.settings.acknowledged[id] = entry.licence.id;
      this.save();
      this.records.set(id, record);
      this.tierA.get(id)?.setInstalled(record);
    } catch (err) {
      this.errors.set(id, (err as Error).message);
      this.records.set(id, await this.o.store.installed(entry));
      this.tierA.get(id)?.setInstalled(this.records.get(id) ?? null);
      throw err;
    } finally {
      this.progress.delete(id);
      this.disk = await this.o.store.diskUse();
      this.changed();
    }
  }

  async remove(id: string): Promise<void> {
    const entry = this.entry(id);
    await this.o.store.remove(entry);
    this.records.set(id, null);
    this.tierA.get(id)?.setInstalled(null);
    this.errors.delete(id);
    this.disk = await this.o.store.diskUse();
    this.changed();
  }

  /** Check the local host again (and read its configuration). */
  async refreshHost(): Promise<void> {
    if (!this.hostProvider) return;
    const health = await this.hostProvider.refresh();
    if (health) {
      try {
        this.hostConfig = await this.o.host.config();
      } catch {
        this.hostConfig = null;
      }
    } else this.hostConfig = null;
    this.changed();
  }

  /** Give the local host the user's paths for a Tier-B model. Refused
   *  until its licence is acknowledged here; the host checks again. */
  async configureHost(id: string, paths: HostModelPaths): Promise<void> {
    const entry = this.entry(id);
    if (entry.tier !== "B") throw new Error(`${entry.title} is not Tier B`);
    this.hostError = null;
    if (this.settings.acknowledged[id] !== entry.licence.id) {
      this.hostError = `acknowledge the ${entry.licence.title} first`;
      this.changed();
      throw new Error(this.hostError);
    }
    try {
      this.hostConfig = await this.o.host.configure({
        sdBinary: paths.sdBinary.trim() || null,
        model: {
          id: entry.id,
          licenceId: entry.licence.id,
          licenceAcknowledged: true,
          diffusionModel: paths.diffusionModel.trim(),
          textEncoder: paths.textEncoder.trim(),
          vae: paths.vae.trim(),
        },
      });
    } catch (err) {
      this.hostError = (err as Error).message;
      this.changed();
      throw err;
    }
    await this.refreshHost();
  }

  /** Run a capability through the backend: what Settings ▸ Models' "Try"
   *  buttons call, the same route a bundle's call takes. */
  async tryModel(id: string): Promise<{ image: MlImage; provider: string }> {
    const entry = this.entry(id);
    const tier = entry.tier;
    if (entry.capabilities.includes("generate")) {
      const r = await this.o.backend.run(
        "generate",
        {
          prompt: "a test card: a grey gradient",
          width: 64,
          height: 64,
          steps: 4,
        },
        { tier },
      );
      return { image: r.image, provider: r.provider };
    }
    const image = testCard(32, 32);
    const cap = entry.capabilities[0]!;
    if (cap === "matting" || cap === "segment") {
      const r =
        cap === "matting"
          ? (await this.o.backend.run("matting", { image }, { tier })).alpha
          : (await this.o.backend.run("segment", { image }, { tier })).mask;
      return {
        image: maskPreview(r),
        provider: tier === "A" ? `paged.ml.${entry.id}` : "paged.ml-host",
      };
    }
    if (cap === "superres") {
      const r = await this.o.backend.run("superres", { image }, { tier });
      return { image: r.image, provider: r.provider };
    }
    throw new Error(`no test for ml.${cap}@1`);
  }
}

/** A gradient test card. */
export function testCard(width: number, height: number): MlImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const v = Math.round((x / Math.max(1, width - 1)) * 255);
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = Math.round((y / Math.max(1, height - 1)) * 255);
      data[i + 3] = 255;
    }
  return { width, height, data };
}

function maskPreview(mask: {
  width: number;
  height: number;
  data: Uint8Array;
}): MlImage {
  const data = new Uint8ClampedArray(mask.width * mask.height * 4);
  for (let i = 0; i < mask.data.length; i++) {
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = mask.data[i]!;
    data[i * 4 + 3] = 255;
  }
  return { width: mask.width, height: mask.height, data };
}
