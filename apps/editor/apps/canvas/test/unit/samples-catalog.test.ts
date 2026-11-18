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

// Editor ADR 1243 — the sample catalog: what it accepts, and that opening a
// sample registers its faces before the document opens.

import { describe, expect, test } from "bun:test";
import type { PagedEditor } from "@paged-media/shell";
import {
  loadCatalog,
  openSample,
  parseCatalog,
  resolve,
  type Sample,
} from "../../src/samples/catalog";

const BASE = "https://host.example/samples/catalog.json";

const sample: Sample = {
  id: "lookbook",
  title: "Lookbook",
  document: "lookbook/lookbook.paged",
  fonts: [
    { family: "Display Sans", url: "lookbook/fonts/display.ttf" },
    {
      family: "Display Sans",
      style: "Italic",
      url: "lookbook/fonts/display-italic.ttf",
    },
  ],
};

describe("parseCatalog", () => {
  test("keeps well-formed entries and drops the rest", () => {
    const got = parseCatalog({
      v: 1,
      samples: [
        sample,
        { id: "no-document", title: "x", fonts: [] },
        { id: "bad-font", title: "x", document: "a", fonts: [{ url: 1 }] },
        null,
      ],
    });
    expect(got.map((s) => s.id)).toEqual(["lookbook"]);
  });

  test("an unknown version or shape is no samples", () => {
    expect(parseCatalog({ v: 2, samples: [sample] })).toEqual([]);
    expect(parseCatalog({ v: 1 })).toEqual([]);
    expect(parseCatalog("catalog")).toEqual([]);
    expect(parseCatalog(null)).toEqual([]);
  });
});

describe("loadCatalog", () => {
  test("an unreachable catalog is no samples, not an error", async () => {
    const failing = (() =>
      Promise.reject(new Error("offline"))) as unknown as typeof fetch;
    expect(await loadCatalog(failing, BASE)).toEqual([]);
  });
});

test("resolve reads a path against the catalog", () => {
  expect(resolve("lookbook/lookbook.paged", BASE)).toBe(
    "https://host.example/samples/lookbook/lookbook.paged",
  );
  // A catalog named by its path is read against the page.
  expect(resolve("a/b.paged", "/samples/catalog.json")).toMatch(
    /^https?:\/\/[^/]+\/samples\/a\/b\.paged$/,
  );
});

describe("openSample", () => {
  test("registers every face, then opens the document", async () => {
    const steps: string[] = [];
    const fetcher = ((url: string) => {
      steps.push(`fetch ${url.split("/").pop()}`);
      return Promise.resolve(new Response(new Uint8Array([1, 2, 3])));
    }) as unknown as typeof fetch;
    const editor = {
      client: {
        registerFont: (
          family: string,
          _b: Uint8Array,
          style: string | null,
        ) => {
          steps.push(`font ${family}/${style ?? "-"}`);
          return Promise.resolve();
        },
      },
    } as unknown as PagedEditor;
    await openSample(
      editor,
      sample,
      { setStatus: () => undefined, pushWarning: () => undefined },
      {
        fetcher,
        open: (_e, file) => {
          steps.push(`open ${file.name}`);
          return Promise.resolve();
        },
      },
    );
    const opened = steps.indexOf("open Lookbook.paged");
    expect(opened).toBe(steps.length - 1);
    expect(steps.indexOf("font Display Sans/-")).toBeLessThan(opened);
    expect(steps.indexOf("font Display Sans/Italic")).toBeLessThan(opened);
  });

  test("a missing font stops before the document opens", async () => {
    let opened = false;
    const fetcher = (() =>
      Promise.resolve(
        new Response("", { status: 404 }),
      )) as unknown as typeof fetch;
    const editor = {
      client: { registerFont: () => Promise.resolve() },
    } as unknown as PagedEditor;
    await expect(
      openSample(
        editor,
        sample,
        { setStatus: () => undefined, pushWarning: () => undefined },
        {
          fetcher,
          open: () => {
            opened = true;
            return Promise.resolve();
          },
        },
      ),
    ).rejects.toThrow("font Display Sans (404)");
    expect(opened).toBe(false);
  });
});
