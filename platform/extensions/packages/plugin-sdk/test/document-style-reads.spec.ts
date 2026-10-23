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

// Extensions ADR 336 — host.document.styleProperties and swatchDisplay: the
// typed reads over requestStyleProperties / requestColorPreview; unknown
// styles answer null, unknown swatches are left out, and both are probed.

import { describe, expect, it } from "bun:test";

import type { PluginManifest } from "@paged-media/plugin-api";

import { createBundleHost } from "../src/host-impl";
import { makeFakeEditor } from "./fake-editor";
import { silentConsole as silent } from "../src/testing";

const MANIFEST: PluginManifest = {
  id: "media.paged.test",
  name: "test",
  version: "1.0.0",
  apiVersion: "^0.2",
  capabilities: { document: { read: "broad" } },
} as PluginManifest;

describe("document style reads (extensions ADR 336)", () => {
  it("styleProperties forwards to the engine and answers null for an unknown style", async () => {
    const fake = makeFakeEditor();
    fake.onSend("requestStyleProperties", (p) => {
      const { styleId } = p as { styleId: string };
      return {
        kind: "styleProperties",
        payload: {
          result:
            styleId === "ParagraphStyle/Body"
              ? { collection: "paragraph", styleId, name: "Body", entries: [] }
              : null,
        },
      };
    });
    const { host } = createBundleHost(() => fake.editor, MANIFEST, {
      console: silent,
    });
    expect(host.supports("document.styleProperties@1")).toBe(true);
    const body = await host.document.styleProperties(
      "paragraph" as never,
      "ParagraphStyle/Body",
    );
    expect(body?.name).toBe("Body");
    expect(
      await host.document.styleProperties("paragraph" as never, "nope"),
    ).toBeNull();
  });

  it("swatchDisplay maps each known swatch to its display colour", async () => {
    const fake = makeFakeEditor();
    fake.onSend("requestColorPreview", (p) => {
      const { swatchId } = p as { swatchId: string };
      if (swatchId !== "Color/Brand")
        return { kind: "colorPreviewReply", payload: { result: null } };
      return {
        kind: "colorPreviewReply",
        payload: {
          result: {
            selfId: swatchId,
            name: "Brand",
            model: "process",
            cmyk: [100, 50, 0, 0],
            rgbHex: "#0080ff",
            outOfGamut: false,
          },
        },
      };
    });
    const { host } = createBundleHost(() => fake.editor, MANIFEST, {
      console: silent,
    });
    expect(host.supports("document.swatchDisplay@1")).toBe(true);
    expect(
      await host.document.swatchDisplay(["Color/Brand", "Color/Missing"]),
    ).toEqual([
      {
        id: "Color/Brand",
        rgbHex: "#0080ff",
        model: "process",
        cmyk: [100, 50, 0, 0],
        outOfGamut: false,
      },
    ]);
  });
});
