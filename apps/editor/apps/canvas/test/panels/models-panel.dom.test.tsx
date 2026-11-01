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

// Settings ▸ Models (paged.models, editor ADR 290): where models run, the
// disk the cache takes, a Tier-A fixture installed through the consent
// dialog (cancel installs nothing), tried through the ML doors and removed;
// the Tier-B model's host status, and its paths offered only once the
// licence is acknowledged.

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "@testing-library/react";
import { covers } from "@paged-media/test-kit";

import { createMlHostClient, createMlRegistry } from "@paged-media/plugin-sdk";
import { createEditorScope } from "@paged-media/shell";

import { createMemoryModelFiles, ModelStore } from "../../src/ml/model-store";
import { SHIPPED_REGISTRY } from "../../src/ml/registry";
import { setMlService } from "../../src/ml/scope";
import { MlService } from "../../src/ml/service";
import { ModelsPanel } from "../../src/panels/models-panel";
import { ORIGIN, publicFetch, realWorker } from "../unit/ml/kit";
import { mountPanel, unmountAll } from "./harness";

afterEach(unmountAll);

const settle = () =>
  act(async () => await new Promise((r) => setTimeout(r, 30)));

function service() {
  const backend = createMlRegistry();
  const worker = realWorker();
  const svc = new MlService({
    backend,
    registry: SHIPPED_REGISTRY,
    store: new ModelStore({
      files: createMemoryModelFiles(),
      origin: ORIGIN,
      fetch: publicFetch().fetch,
    }),
    worker: () => worker,
    // Nothing listens there: the host is "not running".
    host: createMlHostClient({
      baseUrl: "",
      fetch: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    }),
    codec: {
      decode: async () => ({
        width: 1,
        height: 1,
        data: new Uint8ClampedArray(4),
      }),
      encode: async () => new Uint8Array(),
    },
    settings: { get: () => null, set: () => undefined },
    detectGpu: async () => ({ webgpu: true, adapter: "Test GPU" }),
    pollMs: 0,
  });
  return { svc, backend };
}

async function mount() {
  const { svc, backend } = service();
  const scope = createEditorScope();
  setMlService(scope, svc);
  await act(async () => void (await svc.start()));
  const h = await mountPanel(ModelsPanel, {
    id: "paged.models",
    document: "none",
    scope,
  });
  await settle();
  return { h, svc, backend };
}

const q = (root: Element, sel: string) =>
  root.querySelector(sel) as HTMLElement | null;

describe("Models panel", () => {
  test("where models run and the disk they take", async () => {
    covers("panel:paged.models");
    const { h } = await mount();
    expect(q(h.root, "[data-models-panel]")!.dataset["modelsPanel"]).toBe(
      "ready",
    );
    expect(q(h.root, "[data-ml-gpu]")!.textContent).toBe("WebGPU: Test GPU");
    expect(q(h.root, "[data-ml-disk]")!.textContent).toContain("0 B");
  });

  test("install goes through the consent dialog; cancel installs nothing", async () => {
    covers("panel:paged.models");
    const { h, backend } = await mount();
    const row = () => q(h.root, '[data-ml-model="paged.fixture.matte"]')!;
    expect(row().dataset["installed"]).toBe("false");
    await act(async () => q(row(), '[data-action="ml-install"]')!.click());
    const dialog = q(document.body, '[data-testid="model-consent-dialog"]')!;
    expect(dialog.textContent).toContain(
      "Install Test fixture: sigmoid matte?",
    );
    expect(
      q(dialog, '[data-testid="model-consent-size"]')!.textContent,
    ).toContain("147 B");
    expect(
      q(dialog, '[data-testid="model-consent-origin"]')!.textContent,
    ).toContain(ORIGIN.replace("http://", "http://"));
    await act(async () =>
      q(dialog, '[data-testid="model-consent-cancel"]')!.click(),
    );
    expect(q(document.body, '[data-testid="model-consent-dialog"]')).toBeNull();
    expect(row().dataset["installed"]).toBe("false");
    expect(backend.supports("matting")).toBe(false);

    await act(async () => q(row(), '[data-action="ml-install"]')!.click());
    await act(async () =>
      q(document.body, '[data-testid="model-consent-install"]')!.click(),
    );
    await settle();
    expect(row().dataset["installed"]).toBe("true");
    expect(row().dataset["healthy"]).toBe("true");
    expect(backend.supports("matting")).toBe(true);
    expect(q(row(), "[data-ml-status]")!.textContent).toContain(
      "Installed (fp32)",
    );
    expect(q(h.root, "[data-ml-disk]")!.textContent).not.toContain("0 B");

    await act(async () => q(row(), '[data-action="ml-try"]')!.click());
    // The try runs the real onnxruntime in-process: its first session can
    // take far longer than a settle on a loaded runner, so wait for the
    // outcome (a result or an error) rather than a fixed time.
    for (let i = 0; i < 300; i++) {
      if (q(row(), "[data-ml-try-result], [data-ml-try-error]")) break;
      await settle();
    }
    expect(q(row(), "[data-ml-try-error]")?.textContent ?? null).toBeNull();
    expect(q(row(), "[data-ml-try-result]")!.dataset["mlTryResult"]).toBe(
      "paged.ml.paged.fixture.matte",
    );

    await act(async () => q(row(), '[data-action="ml-remove"]')!.click());
    await settle();
    expect(row().dataset["installed"]).toBe("false");
    expect(backend.supports("matting")).toBe(false);
  });

  test("the quantisation select chooses the variant", async () => {
    covers("panel:paged.models");
    const { h, svc } = await mount();
    const select = q(
      h.root,
      '[data-ml-model="paged.fixture.matte"] [data-setting="ml-variant"]',
    ) as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(["fp32", "hard"]);
    await act(async () => {
      select.value = "hard";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(svc.snapshot().models[0]!.variant).toBe("hard");
  });

  test("Tier B: the host is not running; the paths wait for the licence", async () => {
    covers("panel:paged.models");
    const { h } = await mount();
    expect(q(h.root, "[data-ml-host]")!.dataset["mlHost"]).toBe("down");
    expect(q(h.root, "[data-ml-host]")!.textContent).toContain(
      "Local image model not running",
    );
    const row = q(h.root, '[data-ml-model="qwen-image-2.1"]')!;
    expect(q(row, "[data-ml-not-redistributed]")!.textContent).toContain(
      "never downloads or redistributes",
    );
    expect(q(row, "[data-ml-licence-link]")!.textContent).toContain(
      "Qwen Research License",
    );
    const save = q(row, '[data-action="ml-save-host"]') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await act(async () =>
      (q(row, '[data-setting="ml-acknowledge"]') as HTMLInputElement).click(),
    );
    expect(
      (
        q(
          h.root,
          '[data-ml-model="qwen-image-2.1"] [data-action="ml-save-host"]',
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    expect(
      (
        q(
          h.root,
          '[data-ml-model="qwen-image-2.1"] [data-action="ml-try"]',
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  test("without a service the panel says so", async () => {
    covers("panel:paged.models");
    const h = await mountPanel(ModelsPanel, {
      id: "paged.models",
      document: "none",
      scope: createEditorScope(),
    });
    expect(q(h.root, "[data-models-panel]")!.dataset["modelsPanel"]).toBe(
      "none",
    );
  });
});
