/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * This file is part of paged (https://paged.media) and is additionally
 * available under the Paged Media Enterprise License (PMEL). Full
 * copyright and license information is available in LICENSE.md which is
 * distributed with this source code.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    MPL-2.0 OR Paged Media Enterprise License (PMEL)
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createHeadlessHost } from "@paged-media/plugin-sdk";

import { main } from "../src/main";
import { minimalIdml } from "../../plugin-sdk/test/fixtures/minimal-idml";

export const silent = { debug() {}, info() {}, warn() {}, error() {} };
export const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));

/** Run the CLI in-process; stdout parsed as JSON when it is JSON. */
export async function cli(argv: string[], cwd?: string): Promise<{ code: number; json: any; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, { stdout: (t) => out.push(t), stderr: (t) => err.push(t), ...(cwd ? { cwd } : {}) });
  const text = out.join("\n");
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* text output */
  }
  return { code, json, out: text, err: err.join("\n") };
}

export function tempDir(): { dir: string; done(): void } {
  const dir = mkdtempSync(join(tmpdir(), "paged-cli-"));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

/** The SDK's minimal fixture (one page "usp", one black rectangle "urect")
 *  with a text frame ("Hello") and a label on the rectangle, saved as .paged. */
export async function writeFixture(dir: string): Promise<{ idml: string; paged: string; story: string; frame: string }> {
  const idml = join(dir, "min.idml");
  writeFileSync(idml, minimalIdml());
  const h = await createHeadlessHost({ console: silent });
  try {
    const [pageId] = await h.load(minimalIdml());
    const made = await h.host.document.mutate({
      op: "batch",
      args: {
        ops: [
          { op: "insertTextFrame", args: { pageId: pageId!, bounds: [10, 10, 100, 200] } },
          { op: "bindCreated", args: { handle: "t" } },
          { op: "insertText", args: { storyId: "$h:t", offset: 0, text: "Hello" } },
        ],
      },
    } as never);
    if (!made.applied) throw new Error("fixture: text frame refused");
    const minted = made.minted?.[0] as { storyId: string; id?: { id: string } } | undefined;
    const labelled = await h.host.document.setMetadata({ kind: "rectangle", id: "urect" } as never, { v: 1, data: { role: "hero" } });
    if (!labelled.applied) throw new Error("fixture: label refused");
    const { bytes } = await h.exportDocument("paged");
    const paged = join(dir, "fixture.paged");
    writeFileSync(paged, bytes);
    const frames = await h.objects.query("textFrame");
    return { idml, paged, story: (await h.objects.query("story"))[0]!, frame: frames[0]! ?? String(minted?.id?.id) };
  } finally {
    h.dispose();
  }
}
