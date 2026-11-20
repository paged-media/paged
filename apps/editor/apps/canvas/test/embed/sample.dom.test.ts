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

// A host starts an embedded editor on a sample publication (editor ADR 212,
// amendment 2; ADR 1243): `config.sample` names an entry of the sample
// catalog, read before anything mounts; an id the catalog does not list, or
// a catalog that cannot be read, refuses with `unknownSample` and leaves the
// host's element empty.

import { afterEach, expect, test } from "bun:test";

import { createEditor, findSample } from "../../src/embed/create-editor";
import { isEditorError } from "../../src/embed/errors";

const URL_ = "https://host.example/samples/catalog.json";
const catalog = {
  v: 1,
  samples: [
    {
      id: "lookbook",
      title: "Lookbook",
      document: "lookbook/lookbook.paged",
      fonts: [{ family: "Display Sans", url: "lookbook/fonts/display.ttf" }],
      credit: "A Publisher",
    },
  ],
};
const serve = (body: unknown, ok = true) =>
  (() =>
    Promise.resolve(
      new Response(JSON.stringify(body), { status: ok ? 200 : 404 }),
    )) as unknown as typeof fetch;

const g = globalThis as { crossOriginIsolated?: unknown; fetch: typeof fetch };
const isolated = Object.getOwnPropertyDescriptor(
  globalThis,
  "crossOriginIsolated",
);
const realFetch = g.fetch;
afterEach(() => {
  if (isolated)
    Object.defineProperty(globalThis, "crossOriginIsolated", isolated);
  else delete g.crossOriginIsolated;
  g.fetch = realFetch;
});

test("findSample returns the catalog's entry for an id", async () => {
  const s = await findSample("lookbook", URL_, serve(catalog));
  expect(s.title).toBe("Lookbook");
  expect(s.credit).toBe("A Publisher");
});

test("an id the catalog does not list refuses with unknownSample, naming what it lists", async () => {
  const refused = await findSample("brochure", URL_, serve(catalog)).catch(
    (e: unknown) => e,
  );
  expect(isEditorError(refused)).toBe(true);
  expect((refused as { code: string }).code).toBe("unknownSample");
  expect((refused as Error).message).toContain("It lists: lookbook");
});

test("a catalog that cannot be read refuses with unknownSample, saying so", async () => {
  const refused = await findSample("lookbook", URL_, serve(null, false)).catch(
    (e: unknown) => e,
  );
  expect((refused as { code: string }).code).toBe("unknownSample");
  expect((refused as Error).message).toContain("could not be read");
});

test("createEditor refuses an unknown sample before anything mounts", async () => {
  Object.defineProperty(globalThis, "crossOriginIsolated", {
    value: true,
    configurable: true,
  });
  g.fetch = serve(catalog);
  const element = document.createElement("div");
  const refused = await createEditor(element, {
    sample: "brochure",
    samplesUrl: URL_,
  }).catch((e: unknown) => e);
  expect((refused as { code: string }).code).toBe("unknownSample");
  expect(element.childElementCount).toBe(0);
});
