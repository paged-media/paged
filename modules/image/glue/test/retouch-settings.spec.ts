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

// WP5.8 — the retouching tools' OPTIONS in the host's tool-options bar,
// set the way the bar sets them (`inMemoryToolSettings`) and asserted
// where they land in the session, with the declared field asserted from
// the registered contribution.

import { describe, expect, it } from "bun:test";

import type { ToolContribution } from "@paged-media/plugin-api";
import { inMemoryToolSettings } from "@paged-media/plugin-sdk";
import { covers } from "@paged-media/test-kit";

import { bundleOnFake } from "./command-kit";

const T = "media.paged.image.tool";

async function withSettings() {
  const settings = inMemoryToolSettings();
  const k = await bundleOnFake({ toolSettings: settings });
  await k.ingest();
  const field = (tool: string, key: string) =>
    (
      k.fake.tools.get(`${T}.${tool}`) as unknown as ToolContribution
    ).options?.fields.find((f) => f.key === key);
  return { k, settings, field, rt: () => k.session.state().retouch };
}

describe("clone stamp options", () => {
  it("clone · sample (current / current & below / all)", async () => {
    covers("setting:media.paged.image.tool.clone.sample");
    const { k, settings, field, rt } = await withSettings();
    expect(field("clone", "sample")).toMatchObject({ kind: "select" });
    settings.set(`${T}.clone`, "sample", "all");
    expect(rt().cloneSource.sample).toBe("all");
    k.dispose();
  });

  it("clone · aligned", async () => {
    covers("setting:media.paged.image.tool.clone.aligned");
    const { k, settings, field } = await withSettings();
    expect(field("clone", "aligned")).toMatchObject({ kind: "toggle" });
    k.session.setCloneSource([1, 1]);
    settings.set(`${T}.clone`, "aligned", false);
    expect(k.session.state().cloneSource?.aligned).toBe(false);
    k.dispose();
  });
});

describe("healing brush options", () => {
  it("heal · diffusion 1–7", async () => {
    covers("setting:media.paged.image.tool.heal.diffusion");
    const { k, settings, field, rt } = await withSettings();
    expect(field("heal", "diffusion")).toMatchObject({ min: 1, max: 7 });
    settings.set(`${T}.heal`, "diffusion", 2);
    expect(rt().heal.diffusion).toBe(2);
    k.dispose();
  });

  it("heal · sample", async () => {
    covers("setting:media.paged.image.tool.heal.sample");
    const { k, settings, rt } = await withSettings();
    settings.set(`${T}.heal`, "sample", "below");
    expect(rt().heal.sample).toBe("below");
    k.dispose();
  });

  it("heal · aligned", async () => {
    covers("setting:media.paged.image.tool.heal.aligned");
    const { k, settings } = await withSettings();
    k.session.setCloneSource([1, 1]);
    settings.set(`${T}.heal`, "aligned", false);
    expect(k.session.state().cloneSource?.aligned).toBe(false);
    k.dispose();
  });
});

describe("spot healing brush options", () => {
  it("spotHeal · type", async () => {
    covers("setting:media.paged.image.tool.spotHeal.type");
    const { k, settings, field, rt } = await withSettings();
    expect(field("spotHeal", "type")).toMatchObject({ kind: "select" });
    settings.set(`${T}.spotHeal`, "type", "proximity");
    expect(rt().heal.spotType).toBe("proximity");
    k.dispose();
  });

  it("spotHeal · diffusion", async () => {
    covers("setting:media.paged.image.tool.spotHeal.diffusion");
    const { k, settings, rt } = await withSettings();
    settings.set(`${T}.spotHeal`, "diffusion", 6);
    expect(rt().heal.diffusion).toBe(6);
    k.dispose();
  });

  it("spotHeal · sample", async () => {
    covers("setting:media.paged.image.tool.spotHeal.sample");
    const { k, settings, rt } = await withSettings();
    settings.set(`${T}.spotHeal`, "sample", "all");
    expect(rt().heal.sample).toBe("all");
    k.dispose();
  });
});

describe("Content-Aware Move options", () => {
  it("contentAwareMove · mode", async () => {
    covers("setting:media.paged.image.tool.contentAwareMove.mode");
    const { k, settings, field, rt } = await withSettings();
    expect(field("contentAwareMove", "mode")).toMatchObject({
      kind: "select",
    });
    settings.set(`${T}.contentAwareMove`, "mode", "extend");
    expect(rt().move.mode).toBe("extend");
    k.dispose();
  });

  it("contentAwareMove · structure 1–7", async () => {
    covers("setting:media.paged.image.tool.contentAwareMove.structure");
    const { k, settings, field, rt } = await withSettings();
    expect(field("contentAwareMove", "structure")).toMatchObject({
      min: 1,
      max: 7,
    });
    settings.set(`${T}.contentAwareMove`, "structure", 0);
    expect(rt().move.structure).toBe(1);
    k.dispose();
  });

  it("contentAwareMove · colour 0–10", async () => {
    covers("setting:media.paged.image.tool.contentAwareMove.colour");
    const { k, settings, rt } = await withSettings();
    settings.set(`${T}.contentAwareMove`, "colour", 12);
    expect(rt().move.colour).toBe(10);
    k.dispose();
  });

  it("contentAwareMove · transform on drop", async () => {
    covers("setting:media.paged.image.tool.contentAwareMove.transformOnDrop");
    const { k, settings, rt } = await withSettings();
    settings.set(`${T}.contentAwareMove`, "transformOnDrop", false);
    expect(rt().move.transformOnDrop).toBe(false);
    k.dispose();
  });

  it("contentAwareMove · sample all layers", async () => {
    covers("setting:media.paged.image.tool.contentAwareMove.sampleAll");
    const { k, settings, rt } = await withSettings();
    settings.set(`${T}.contentAwareMove`, "sampleAll", true);
    expect(rt().move.sampleAll).toBe(true);
    k.dispose();
  });
});

describe("Remove options", () => {
  it("remove · sample all layers", async () => {
    covers("setting:media.paged.image.tool.remove.sampleAll");
    const { k, settings, field, rt } = await withSettings();
    expect(field("remove", "sampleAll")).toMatchObject({ kind: "toggle" });
    settings.set(`${T}.remove`, "sampleAll", true);
    expect(rt().remove.sampleAll).toBe(true);
    k.dispose();
  });
});
