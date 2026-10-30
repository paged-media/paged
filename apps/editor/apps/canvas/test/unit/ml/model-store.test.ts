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

// Editor ADR 290 — the Tier-A model cache: no download without consent, or
// without the licence acknowledged when it asks for one, or from an origin
// the wall does not admit; a file of the wrong size or hash is not kept; a
// file changed on disk is removed on load, not run; remove and disk use.

import { describe, expect, test } from "bun:test";

import {
  createMemoryModelFiles,
  ModelBlockedError,
  ModelConsentError,
  ModelIntegrityError,
  ModelStore,
} from "../../../src/ml/model-store";
import { SHIPPED_REGISTRY, type ModelEntry } from "../../../src/ml/registry";
import { ORIGIN, publicFetch } from "./kit";

const FIXTURE = SHIPPED_REGISTRY.models.find(
  (m) => m.id === "paged.fixture.matte",
)!;
const YES = { consented: true, licenceAcknowledged: false };

function store(override?: (url: URL) => Uint8Array | null) {
  const files = createMemoryModelFiles();
  const net = publicFetch(override);
  return {
    files,
    net,
    store: new ModelStore({ files, origin: ORIGIN, fetch: net.fetch }),
  };
}

describe("[plugin-platform.ml-service] model cache: consent and integrity", () => {
  test("no consent, no download", async () => {
    const s = store();
    await expect(
      s.store.install(FIXTURE, {
        consent: { consented: false, licenceAcknowledged: true },
      }),
    ).rejects.toBeInstanceOf(ModelConsentError);
    expect(s.net.asked).toEqual([]);
  });

  test("a licence that asks for acknowledgement is not skipped", async () => {
    const s = store();
    const strict: ModelEntry = {
      ...FIXTURE,
      licence: { ...FIXTURE.licence, requiresAcknowledgement: true },
    };
    await expect(s.store.install(strict, { consent: YES })).rejects.toThrow(
      /acknowledge/,
    );
    expect(s.net.asked).toEqual([]);
    await s.store.install(strict, {
      consent: { consented: true, licenceAcknowledged: true },
    });
    expect(await s.store.installed(strict)).not.toBeNull();
  });

  test("a user-installed model is never downloaded", async () => {
    const s = store();
    const qwen = SHIPPED_REGISTRY.models.find(
      (m) => m.id === "qwen-image-2.1",
    )!;
    await expect(
      s.store.install(qwen, {
        consent: { consented: true, licenceAcknowledged: true },
      }),
    ).rejects.toThrow(/installed by you/);
    expect(s.net.asked).toEqual([]);
  });

  test("an origin the wall does not admit is refused before any request", async () => {
    const s = store();
    const remote: ModelEntry = {
      ...FIXTURE,
      variants: [
        {
          ...FIXTURE.variants[0]!,
          files: [
            {
              ...FIXTURE.variants[0]!.files[0]!,
              url: "https://models.example/m.onnx",
            },
          ],
        },
      ],
    };
    await expect(
      s.store.install(remote, { consent: YES }),
    ).rejects.toBeInstanceOf(ModelBlockedError);
    expect(s.store.blockedOrigins(remote.variants[0]!)).toEqual([
      "https://models.example",
    ]);
    expect(s.net.asked).toEqual([]);
  });

  test("installs the chosen variant, with progress, and records it", async () => {
    const s = store();
    const progress: number[] = [];
    const record = await s.store.install(FIXTURE, {
      variant: "hard",
      consent: YES,
      onProgress: (p) => progress.push(p.loaded),
    });
    expect(record.variant).toBe("hard");
    expect(s.net.asked).toEqual([
      `${ORIGIN}/ml/fixtures/matte-hard-sigmoid.onnx`,
    ]);
    expect(progress.at(-1)).toBe(159);
    expect((await s.store.load(FIXTURE)).get("model.onnx")!.length).toBe(159);
    expect(
      (await s.store.diskUse()).byModel["paged.fixture.matte"],
    ).toBeGreaterThan(159);
  });

  test("a file whose hash differs is not kept", async () => {
    const s = store((url) =>
      url.pathname.endsWith("matte-sigmoid.onnx")
        ? new Uint8Array(147).fill(7)
        : null,
    );
    await expect(s.store.install(FIXTURE, { consent: YES })).rejects.toThrow(
      ModelIntegrityError,
    );
    expect(await s.store.installed(FIXTURE)).toBeNull();
    expect(s.files.map.size).toBe(0);
  });

  test("a file longer than the registry says is cut off and refused", async () => {
    const s = store((url) =>
      url.pathname.endsWith("matte-sigmoid.onnx")
        ? new Uint8Array(10_000)
        : null,
    );
    await expect(s.store.install(FIXTURE, { consent: YES })).rejects.toThrow(
      /more than the registry/,
    );
    expect(s.files.map.size).toBe(0);
  });

  test("a file changed on disk is removed on load, never run", async () => {
    const s = store();
    await s.store.install(FIXTURE, { consent: YES });
    const key = "paged.fixture.matte/model.onnx";
    const bytes = s.files.map.get(key)!;
    bytes[bytes.length - 1] ^= 0xff;
    await expect(s.store.load(FIXTURE)).rejects.toThrow(/changed on disk/);
    expect(await s.store.installed(FIXTURE)).toBeNull();
  });

  test("remove empties the model's directory; disk use follows", async () => {
    const s = store();
    await s.store.install(FIXTURE, { consent: YES });
    expect((await s.store.diskUse()).total).toBeGreaterThan(0);
    await s.store.remove(FIXTURE);
    expect(await s.store.diskUse()).toEqual({ total: 0, byModel: {} });
  });
});
