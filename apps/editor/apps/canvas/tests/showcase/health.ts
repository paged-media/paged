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

// The document's own health, read the way the editor's Publication
// health panel reads it: overset stories (the stories read-out's flag),
// missing links (`LinkSummary.status === "missing"`) and missing fonts
// (`FontSummary.isMissing`). The annual opens with all three empty — the
// chapter runner checks the first after every chapter, the assembly all
// three on the finished book — so a page whose copy does not fit, a link
// to nothing or a face the build does not ship fails the build that
// made it instead of reaching the film.

import type { Page } from "@playwright/test";

import { script } from "../e2e/harness/ui";

export interface OversetStory {
  id: string;
  /** The story's first characters, so a failure names the copy. */
  text: string;
}

/**
 * The stories the engine reports overset. The flag derives from build
 * diagnostics, so the pages that carry them must have been composed
 * (rendered) since the last edit.
 */
export async function oversetStories(page: Page): Promise<OversetStory[]> {
  const out = await script(
    page,
    `JSON.stringify(JSON.parse(paged.stories()).filter((s) => s.overset).map((s) => {
      const v = JSON.parse(paged.get("story:" + s.selfId, "text") || "null");
      return { id: s.selfId, text: String((v && v.value) || "").slice(0, 90) };
    }))`,
  );
  return JSON.parse(out[0] ?? "[]") as OversetStory[];
}

interface Collections {
  links: Array<{ uri: string; status?: string; hostSelfId: string }>;
  fonts: Array<{ family: string; isMissing: boolean }>;
}

/** Links the engine resolved to nothing, by URI. */
export async function missingLinks(page: Page): Promise<string[]> {
  const links = await collection(page, "links");
  return links.filter((l) => l.status === "missing").map((l) => l.uri);
}

/** Families the text is set in that no registered face serves. */
export async function missingFonts(page: Page): Promise<string[]> {
  const fonts = await collection(page, "fonts");
  return fonts.filter((f) => f.isMissing).map((f) => f.family);
}

async function collection<K extends keyof Collections>(
  page: Page,
  name: K,
): Promise<Collections[K]> {
  return page.evaluate(
    async (n) =>
      (await (
        globalThis as unknown as {
          __canvas: { client: { collection(n: string): Promise<unknown> } };
        }
      ).__canvas.client.collection(n)) as never,
    name,
  ) as Promise<Collections[K]>;
}
