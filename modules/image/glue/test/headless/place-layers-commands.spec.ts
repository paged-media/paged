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

// Engine ADR 1099 — Layer ▸ Place Layers as Frames against the real
// engine: a PSD Photoshop wrote (a styled layer over a background) opened
// in the image session lands on the page as frames, one document undo
// step.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "bun:test";

import type { ImporterContribution } from "@paged-media/plugin-api";
import { createHeadlessHost } from "@paged-media/plugin-sdk";
import { covers } from "@paged-media/test-kit";

import { imageBundle } from "../../src";
import { lastSession } from "../bundle-session";
import { C, quiesce } from "../command-kit";
import { minimalIdml } from "../fixtures/minimal-idml";
import { silentConsole } from "../helpers";

const ENGINE_ANCHOR = fileURLToPath(new URL("..", import.meta.url));

// Recorded from Photoshop 27.10 by the layer-styles probe (provenance in
// the fixtures' `layer-styles.photoshop.json`).
const PSD = new Uint8Array(
  readFileSync(
    fileURLToPath(
      new URL(
        "../../../../../engine/core/crates/paged-psd-fx/tests/fixtures/photoshop-layer-styles/ds-basic.psd",
        import.meta.url,
      ),
    ),
  ),
);

describe("Place layers as frames [images-graphics.psd-layer-styles]", () => {
  it("places the open PSD's layers on the page as one undo step", async () => {
    covers("command:media.paged.image.command.placeLayersAsFrames");
    const h = await createHeadlessHost({
      resolveFrom: ENGINE_ANCHOR,
      console: silentConsole,
    });
    await h.load(minimalIdml());
    h.loadBundle(imageBundle);
    const session = lastSession();
    const importer = h.importersContributed()[0] as ImporterContribution;
    await importer.import({
      name: "ds-basic.psd",
      bytes: PSD,
      mimeType: "image/vnd.adobe.photoshop",
    });
    await quiesce(session);
    expect(session.sourcePsd()?.length).toBe(PSD.length);
    // Every node of the page tree, nested ones included.
    const count = (nodes: readonly unknown[]): number =>
      nodes.reduce<number>(
        (n, x) =>
          n +
          1 +
          count(((x as { children?: unknown[] }).children ?? []) as unknown[]),
        0,
      );
    const nodes = async () => count(await h.host.document.tree());
    const before = await nodes();
    const c = h.contributions.find(
      (x) => x.kind === "command" && x.id === `${C}.placeLayersAsFrames`,
    );
    await (c!.value as { handler: (p: unknown) => unknown }).handler(null);
    // The two layers as frames, grouped.
    expect(await nodes()).toBe(before + 3);
    await h.host.document.undo();
    expect(await nodes()).toBe(before);
    h.dispose();
  });
});
