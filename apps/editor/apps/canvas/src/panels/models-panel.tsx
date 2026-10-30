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

// Settings ▸ Models (editor ADR 290): the models of the ML service.
//
//   · where models run: WebGPU and its adapter, or the wasm fallback;
//   · the disk the model cache takes on this machine;
//   · Tier A, models in the editor: install (a consent dialog naming the
//     size, the origins and the licence, with an acknowledgement when the
//     licence asks for one), remove, choose a quantisation, try;
//   · Tier B, the local image model: whether paged-ml-host runs, the
//     licence acknowledgement, the quantisation the user installed, the
//     paths of the files the user installed (paged never downloads them),
//     check again, try.
// Every action goes through the service, which registers what is installed
// and healthy into the ML doors every bundle reaches.

import { useEffect, useRef, useState } from "react";

import type { MlImage } from "@paged-media/plugin-api";
import { defineMessages, useStrings } from "@paged-media/strings";
import { color, font, radius } from "@paged-media/panel-kit";
import { FocusScope } from "@paged-media/shell";

import { reachableOrigin } from "../plugin-consent";
import { useMlService, useMlSnapshot } from "../ml/scope";
import type { ModelState, MlService } from "../ml/service";
import { variantBytes } from "../ml/registry";

const M = defineMessages("app.modelsPanel", {
  noService: "The ML service is not running in this editor.",
  where: "Where models run",
  webgpu: "WebGPU: {adapter}",
  webgpuUnnamed: "WebGPU",
  wasm: "wasm (no GPU): {reason}",
  checking: "Checking…",
  disk: "Model cache on this machine: {size}",
  tierA: "In the editor",
  tierANone:
    "This embedded editor runs no in-browser models: its package does not ship the model runtime.",
  tierAIntro:
    "Small models that run in this browser. Each is downloaded only when you install it, and nothing you process leaves this machine.",
  tierB: "Local image model",
  tierBIntro:
    "Generation and editing run in paged-ml-host, a program on this machine that runs stable-diffusion.cpp with model files you install yourself.",
  fixture: "test fixture",
  capabilities: "Answers: {list}",
  licence: "Licence: {title}",
  quantisation: "Quantisation",
  size: "Size: {size}",
  sizeUnknown: "Size: shown by your download",
  installed: "Installed ({variant}) · {detail}",
  notInstalled: "Not installed",
  install: "Install…",
  remove: "Remove",
  try: "Try",
  trying: "Running…",
  tryResult: "Answered by {provider}",
  downloading: "Downloading {file}: {loaded} of {total}",
  hostReady: "paged-ml-host {version} is running; {model} is ready.",
  hostNotReady: "paged-ml-host {version} is running: {detail}.",
  hostDown:
    "Local image model not running. Start paged-ml-host on this machine (see apps/ml-host/README.md); the editor reaches it at /api/ml.",
  checkAgain: "Check again",
  acknowledge: "I have read the {title} and accept its terms",
  notRedistributed:
    "paged never downloads or redistributes this model. Download it yourself from {source} and give the paths below.",
  sdBinary: "stable-diffusion.cpp binary (sd)",
  diffusionModel: "Denoiser (.gguf)",
  textEncoder: "Text encoder (.gguf)",
  vae: "VAE (.safetensors)",
  saveToHost: "Use these files",
  acknowledgeFirst: "Acknowledge the licence first",
  consentTitle: "Install {model}?",
  consentSize: "{size} will be downloaded and kept on this machine.",
  consentOrigins: "From:",
  consentBlocked:
    "This editor's network policy does not admit this origin, so the download is blocked until the deployment lists it.",
  consentLicence: "Licence: {title}",
  cancel: "Cancel",
  confirmInstall: "Install",
});

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

const sectionTitle =
  "text-[10px] uppercase tracking-wide text-muted-foreground";
const button =
  "text-xs border border-input rounded px-2 py-1 disabled:opacity-50";

/** An `MlImage` drawn at a small size. */
function ImagePreview({ image, label }: { image: MlImage; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    canvas.width = image.width;
    canvas.height = image.height;
    ctx.putImageData(
      new ImageData(
        new Uint8ClampedArray(image.data),
        image.width,
        image.height,
      ),
      0,
      0,
    );
  }, [image]);
  return (
    <canvas
      ref={ref}
      aria-label={label}
      data-ml-try-image
      data-width={image.width}
      data-height={image.height}
      style={{ width: 64, height: 64, imageRendering: "pixelated" }}
    />
  );
}

function TryButton({
  service,
  id,
  disabled,
}: {
  service: MlService;
  id: string;
  disabled: boolean;
}) {
  const strings = useStrings();
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "running" }
    | { kind: "done"; image: MlImage; provider: string }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
  const run = () => {
    setState({ kind: "running" });
    service
      .tryModel(id)
      .then((r) => setState({ kind: "done", ...r }))
      .catch((err: unknown) =>
        setState({ kind: "error", message: (err as Error).message }),
      );
  };
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        className={button + " self-start"}
        data-action="ml-try"
        disabled={disabled || state.kind === "running"}
        onClick={run}
      >
        {strings.t(state.kind === "running" ? M.trying : M.try)}
      </button>
      {state.kind === "done" && (
        <div
          className="flex items-center gap-2 text-xs"
          data-ml-try-result={state.provider}
        >
          <ImagePreview
            image={state.image}
            label={strings.t(M.tryResult, { provider: state.provider })}
          />
          <span className="text-muted-foreground">
            {strings.t(M.tryResult, { provider: state.provider })}
          </span>
        </div>
      )}
      {state.kind === "error" && (
        <div
          role="alert"
          className="text-xs"
          data-ml-try-error
          style={{ color: "var(--status-error)" }}
        >
          {state.message}
        </div>
      )}
    </div>
  );
}

function ConsentPrompt({
  model,
  service,
  onClose,
}: {
  model: ModelState;
  service: MlService;
  onClose: () => void;
}) {
  const strings = useStrings();
  const [ack, setAck] = useState(model.acknowledged);
  const variant =
    model.entry.variants.find((v) => v.id === model.variant) ??
    model.entry.variants[0]!;
  const origins = service.downloadOrigins(model.entry.id);
  const needsAck = model.entry.licence.requiresAcknowledgement;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const install = () => {
    onClose();
    service
      .install(model.entry.id, { consented: true, licenceAcknowledged: ack })
      .catch(() => undefined);
  };
  return (
    <div
      data-testid="model-consent-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        display: "grid",
        placeItems: "center",
        background: "rgba(0,0,0,0.6)",
        font: `13px/1.5 ${font.sans}`,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="model-consent-title"
        data-testid="model-consent-dialog"
        style={{
          width: "min(440px, 92vw)",
          padding: 20,
          borderRadius: radius.lg,
          border: `1px solid ${color.border}`,
          background: color.elevated,
          color: color.fg,
        }}
      >
        <FocusScope trap autoFocus restoreFocus>
          <h2
            id="model-consent-title"
            style={{ margin: "0 0 8px", fontSize: 15 }}
          >
            {strings.t(M.consentTitle, { model: model.entry.title })}
          </h2>
          <p style={{ margin: "0 0 8px" }} data-testid="model-consent-size">
            {strings.t(M.consentSize, {
              size: formatBytes(variantBytes(variant) ?? 0),
            })}
          </p>
          <p style={{ margin: "0 0 4px", color: color.mutedFg }}>
            {strings.t(M.consentOrigins)}
          </p>
          <ul style={{ margin: "0 0 8px", paddingLeft: 16 }}>
            {origins.map((o) => (
              <li key={o} data-testid="model-consent-origin">
                <code style={{ font: `12px ${font.mono}` }}>{o}</code>
                {!reachableOrigin(o) && (
                  <p
                    data-testid="model-consent-blocked"
                    style={{ margin: 0, fontSize: 12, color: color.mutedFg }}
                  >
                    {strings.t(M.consentBlocked)}
                  </p>
                )}
              </li>
            ))}
          </ul>
          <p style={{ margin: "0 0 8px" }}>
            <a
              href={model.entry.licence.url}
              target="_blank"
              rel="noreferrer noopener"
            >
              {strings.t(M.consentLicence, {
                title: model.entry.licence.title,
              })}
            </a>
            {model.entry.licence.summary
              ? ` — ${model.entry.licence.summary}`
              : ""}
          </p>
          {needsAck && (
            <label
              style={{
                display: "flex",
                gap: 8,
                alignItems: "center",
                margin: "0 0 12px",
              }}
            >
              <input
                type="checkbox"
                data-testid="model-consent-ack"
                checked={ack}
                onChange={(e) => setAck(e.target.checked)}
              />
              {strings.t(M.acknowledge, { title: model.entry.licence.title })}
            </label>
          )}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button
              type="button"
              className={button}
              data-testid="model-consent-cancel"
              onClick={onClose}
            >
              {strings.t(M.cancel)}
            </button>
            <button
              type="button"
              className={button}
              data-testid="model-consent-install"
              disabled={needsAck && !ack}
              onClick={install}
            >
              {strings.t(M.confirmInstall)}
            </button>
          </div>
        </FocusScope>
      </div>
    </div>
  );
}

function VariantSelect({
  model,
  service,
  disabled,
}: {
  model: ModelState;
  service: MlService;
  disabled?: boolean;
}) {
  const strings = useStrings();
  return (
    <label className="flex items-center gap-2 text-xs">
      <span className="text-muted-foreground">{strings.t(M.quantisation)}</span>
      <select
        className="flex-1 border border-input rounded"
        data-setting="ml-variant"
        value={model.variant}
        disabled={disabled}
        onChange={(e) => service.chooseVariant(model.entry.id, e.target.value)}
      >
        {model.entry.variants.map((v) => (
          <option key={v.id} value={v.id}>
            {v.title}
          </option>
        ))}
      </select>
    </label>
  );
}

function TierAModel({
  model,
  service,
}: {
  model: ModelState;
  service: MlService;
}) {
  const strings = useStrings();
  const [asking, setAsking] = useState(false);
  const { entry } = model;
  return (
    <li
      className="flex flex-col gap-1 border border-input rounded p-2"
      data-ml-model={entry.id}
      data-installed={model.installed ? "true" : "false"}
      data-healthy={model.healthy ? "true" : "false"}
    >
      <div className="flex items-center gap-2 text-xs font-medium">
        {entry.title}
        {entry.fixture && (
          <span className="text-[10px] text-muted-foreground border border-input rounded px-1">
            {strings.t(M.fixture)}
          </span>
        )}
      </div>
      <div className="text-xs text-muted-foreground">
        {strings.t(M.capabilities, { list: entry.capabilities.join(", ") })}
        {" · "}
        <a href={entry.licence.url} target="_blank" rel="noreferrer noopener">
          {strings.t(M.licence, { title: entry.licence.title })}
        </a>
      </div>
      <VariantSelect
        model={model}
        service={service}
        disabled={model.progress !== null}
      />
      <div className="text-xs text-muted-foreground">
        {model.variantBytes !== null
          ? strings.t(M.size, { size: formatBytes(model.variantBytes) })
          : strings.t(M.sizeUnknown)}
      </div>
      <div className="text-xs" data-ml-status>
        {model.installed
          ? strings.t(M.installed, {
              variant: model.installed.variant,
              detail: model.detail ?? "",
            })
          : strings.t(M.notInstalled)}
      </div>
      {model.progress && (
        <div className="text-xs text-muted-foreground" data-ml-progress>
          {strings.t(M.downloading, {
            file: model.progress.file,
            loaded: formatBytes(model.progress.loaded),
            total: formatBytes(model.progress.total),
          })}
        </div>
      )}
      {model.error && (
        <div
          role="alert"
          className="text-xs"
          data-ml-error
          style={{ color: "var(--status-error)" }}
        >
          {model.error}
        </div>
      )}
      <div className="flex gap-2">
        {(!model.installed || model.installed.variant !== model.variant) && (
          <button
            type="button"
            className={button}
            data-action="ml-install"
            disabled={model.progress !== null}
            onClick={() => setAsking(true)}
          >
            {strings.t(M.install)}
          </button>
        )}
        {model.installed && (
          <button
            type="button"
            className={button}
            data-action="ml-remove"
            onClick={() => void service.remove(entry.id)}
          >
            {strings.t(M.remove)}
          </button>
        )}
      </div>
      <TryButton service={service} id={entry.id} disabled={!model.healthy} />
      {asking && (
        <ConsentPrompt
          model={model}
          service={service}
          onClose={() => setAsking(false)}
        />
      )}
    </li>
  );
}

function TierBModel({
  model,
  service,
  ready,
}: {
  model: ModelState;
  service: MlService;
  ready: boolean;
}) {
  const strings = useStrings();
  const snapshot = useMlSnapshot(service);
  const config = snapshot?.host.config;
  const [paths, setPaths] = useState({
    sdBinary: config?.sdBinary ?? "",
    diffusionModel: config?.model?.diffusionModel ?? "",
    textEncoder: config?.model?.textEncoder ?? "",
    vae: config?.model?.vae ?? "",
  });
  const { entry } = model;
  const field = (key: keyof typeof paths, label: string) => (
    <label className="flex flex-col gap-0.5 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <input
        className="border border-input rounded px-1 font-mono"
        data-setting={`ml-path-${key}`}
        value={paths[key]}
        spellCheck={false}
        onChange={(e) => setPaths({ ...paths, [key]: e.target.value })}
      />
    </label>
  );
  return (
    <li
      className="flex flex-col gap-1 border border-input rounded p-2"
      data-ml-model={entry.id}
      data-healthy={model.healthy ? "true" : "false"}
    >
      <div className="text-xs font-medium">{entry.title}</div>
      <div className="text-xs text-muted-foreground">
        {strings.t(M.capabilities, { list: entry.capabilities.join(", ") })}
      </div>
      <div className="text-xs">
        <a
          href={entry.licence.url}
          target="_blank"
          rel="noreferrer noopener"
          data-ml-licence-link
        >
          {strings.t(M.licence, { title: entry.licence.title })}
        </a>
        {entry.licence.summary ? ` — ${entry.licence.summary}` : ""}
      </div>
      <div className="text-xs text-muted-foreground" data-ml-not-redistributed>
        {strings.t(M.notRedistributed, {
          source: entry.source ?? entry.licence.url,
        })}
      </div>
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          data-setting="ml-acknowledge"
          checked={model.acknowledged}
          onChange={(e) =>
            service.acknowledgeLicence(entry.id, e.target.checked)
          }
        />
        {strings.t(M.acknowledge, { title: entry.licence.title })}
      </label>
      <VariantSelect model={model} service={service} />
      <div className="text-xs text-muted-foreground">
        {model.variantBytes !== null
          ? strings.t(M.size, { size: formatBytes(model.variantBytes) })
          : strings.t(M.sizeUnknown)}
      </div>
      {entry.components?.map((c) => (
        <div key={c.role} className="text-[11px] text-muted-foreground">
          {c.title}
        </div>
      ))}
      {field("sdBinary", strings.t(M.sdBinary))}
      {field("diffusionModel", strings.t(M.diffusionModel))}
      {field("textEncoder", strings.t(M.textEncoder))}
      {field("vae", strings.t(M.vae))}
      <div className="flex gap-2">
        <button
          type="button"
          className={button}
          data-action="ml-save-host"
          disabled={!model.acknowledged}
          title={model.acknowledged ? undefined : strings.t(M.acknowledgeFirst)}
          onClick={() =>
            void service.configureHost(entry.id, paths).catch(() => undefined)
          }
        >
          {strings.t(M.saveToHost)}
        </button>
      </div>
      {snapshot?.host.error && (
        <div
          role="alert"
          className="text-xs"
          data-ml-host-error
          style={{ color: "var(--status-error)" }}
        >
          {snapshot.host.error}
        </div>
      )}
      <TryButton
        service={service}
        id={entry.id}
        disabled={!ready || !model.healthy}
      />
    </li>
  );
}

export function ModelsPanel() {
  const strings = useStrings();
  const service = useMlService();
  const snapshot = useMlSnapshot(service);
  if (!service || !snapshot)
    return (
      <div
        className="p-3 text-xs text-muted-foreground"
        data-models-panel="none"
      >
        {strings.t(M.noService)}
      </div>
    );
  const tierA = snapshot.models.filter((m) => m.entry.tier === "A");
  const tierB = snapshot.models.filter((m) => m.entry.tier === "B");
  const { gpu, host } = snapshot;
  const health = host.health;
  return (
    <div className="p-3 text-sm flex flex-col gap-3" data-models-panel="ready">
      <div className={sectionTitle}>{strings.t(M.where)}</div>
      <div
        className="text-xs"
        data-ml-gpu={gpu ? (gpu.webgpu ? "webgpu" : "wasm") : "checking"}
      >
        {!gpu
          ? strings.t(M.checking)
          : gpu.webgpu
            ? gpu.adapter
              ? strings.t(M.webgpu, { adapter: gpu.adapter })
              : strings.t(M.webgpuUnnamed)
            : strings.t(M.wasm, { reason: gpu.reason ?? "" })}
      </div>
      <div className="text-xs" data-ml-disk={snapshot.diskTotal}>
        {strings.t(M.disk, { size: formatBytes(snapshot.diskTotal) })}
      </div>

      <div className={sectionTitle + " border-t border-input pt-2"}>
        {strings.t(M.tierA)}
      </div>
      <p className="text-xs text-muted-foreground m-0">
        {strings.t(M.tierAIntro)}
      </p>
      {snapshot.tierA ? (
        <ul className="flex flex-col gap-2 m-0 p-0 list-none">
          {tierA.map((m) => (
            <TierAModel key={m.entry.id} model={m} service={service} />
          ))}
        </ul>
      ) : (
        <p className="text-xs m-0" data-ml-tier-a="unavailable">
          {strings.t(M.tierANone)}
        </p>
      )}

      {tierB.length > 0 && (
        <>
          <div className={sectionTitle + " border-t border-input pt-2"}>
            {strings.t(M.tierB)}
          </div>
          <p className="text-xs text-muted-foreground m-0">
            {strings.t(M.tierBIntro)}
          </p>
          <div
            className="text-xs"
            data-ml-host={
              health ? (health.ready ? "ready" : "running") : "down"
            }
          >
            {!health
              ? strings.t(M.hostDown)
              : health.ready
                ? strings.t(M.hostReady, {
                    version: health.version,
                    model: health.model.id ?? "",
                  })
                : strings.t(M.hostNotReady, {
                    version: health.version,
                    detail: host.detail,
                  })}
          </div>
          <button
            type="button"
            className={button + " self-start"}
            data-action="ml-check-host"
            onClick={() => void service.refreshHost()}
          >
            {strings.t(M.checkAgain)}
          </button>
          <ul className="flex flex-col gap-2 m-0 p-0 list-none">
            {tierB.map((m) => (
              <TierBModel
                key={`${m.entry.id}:${host.config ? "c" : "n"}`}
                model={m}
                service={service}
                ready={health?.ready === true}
              />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
