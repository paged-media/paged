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

// Editor ADR 290 — the model registry: the shipped list parses whole, its
// fixtures are the committed files (bytes, sha256, size), no Tier-A model
// but the fixtures is enabled, the Tier-B model is user-installed behind a
// licence acknowledgement, and a bad entry is dropped with its reason.

import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";

import { ML_FIXTURES } from "../../../src/ml/fixtures";
import {
  parseModelRegistry,
  SHIPPED_REGISTRY,
  variantBytes,
  variantOf,
} from "../../../src/ml/registry";
import shipped from "../../../src/ml/models.json";
import { readPublic } from "./kit";

describe("[plugin-platform.ml-service] model registry", () => {
  test("the shipped registry parses with no problem", () => {
    const { registry, problems } = parseModelRegistry(shipped);
    expect(problems).toEqual([]);
    expect(registry.models.map((m) => m.id)).toEqual([
      "paged.fixture.matte",
      "qwen-image-2.1",
    ]);
  });

  test("every fixture file is the generator's bytes, with the registry's sha256 and size", () => {
    const files = SHIPPED_REGISTRY.models
      .filter((m) => m.fixture)
      .flatMap((m) => m.variants.flatMap((v) => v.files));
    expect(files.length).toBe(2);
    for (const f of files) {
      const name = f.url.split("/").pop()!;
      const committed = readPublic(f.url)!;
      expect(committed).not.toBeNull();
      expect([...committed]).toEqual([...ML_FIXTURES[name]!()]);
      expect(createHash("sha256").update(committed).digest("hex")).toBe(
        f.sha256,
      );
      expect(committed.length).toBe(f.size);
    }
  });

  test("no Tier-A model is enabled but the test fixtures", () => {
    for (const m of SHIPPED_REGISTRY.models)
      if (m.tier === "A" && m.enabled) expect(m.fixture).toBe(true);
  });

  test("the Tier-B model is never downloaded and asks for its licence", () => {
    const qwen = SHIPPED_REGISTRY.models.find(
      (m) => m.id === "qwen-image-2.1",
    )!;
    expect(qwen.install).toBe("user");
    expect(qwen.licence.requiresAcknowledgement).toBe(true);
    expect(qwen.licence.title).toBe("Qwen Research License");
    for (const v of qwen.variants) expect(v.files).toEqual([]);
    expect(qwen.components!.map((c) => c.role)).toEqual([
      "diffusionModel",
      "textEncoder",
      "vae",
    ]);
    expect(variantBytes(variantOf(qwen, "Q8_0"))).toBe(7_600_000_000);
    expect(variantBytes(variantOf(qwen, "Q4_K_M"))).toBeNull();
    expect(variantOf(qwen, "nope").id).toBe("Q4_K_M");
  });

  test("a bad entry is dropped with its reason; the rest stay", () => {
    const good = shipped.models[0]!;
    const { registry, problems } = parseModelRegistry({
      version: 1,
      models: [
        good,
        { ...good, id: "Bad Id" },
        {
          ...good,
          id: "no-hash",
          variants: [
            {
              id: "x",
              title: "x",
              files: [{ name: "m.onnx", url: "/m", sha256: "zz", size: 1 }],
            },
          ],
          defaultVariant: "x",
        },
        { ...good, id: "tier-b-download", tier: "B" },
        { ...good, id: "paged.fixture.matte" },
        {
          ...good,
          id: "path-name",
          variants: [
            {
              id: "x",
              title: "x",
              files: [
                {
                  name: "../m.onnx",
                  url: "/m",
                  sha256: "a".repeat(64),
                  size: 1,
                },
              ],
            },
          ],
          defaultVariant: "x",
        },
      ],
    });
    expect(registry.models.map((m) => m.id)).toEqual(["paged.fixture.matte"]);
    expect(problems.map((p) => p.id)).toEqual([
      "Bad Id",
      "no-hash",
      "tier-b-download",
      "paged.fixture.matte",
      "path-name",
    ]);
    expect(
      parseModelRegistry({ version: 2, models: [] }).problems[0]!.problem,
    ).toMatch(/version 1/);
  });
});
