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

import { describe, expect, it } from "bun:test";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { makeFakeEditor } from "./fake-editor";
import { defineBundle, loadBundle } from "../src/index";
import {
  API_GENERATION_RANGE,
  API_VERSION,
  explainApiMismatch,
  satisfiesApiVersion,
} from "../src/version";

describe("satisfiesApiVersion", () => {
  it("wildcard matches anything", () => {
    expect(satisfiesApiVersion("*", "9.9.9")).toBe(true);
  });

  it("exact matches (missing patch = 0)", () => {
    expect(satisfiesApiVersion("0.2.0", "0.2.0")).toBe(true);
    expect(satisfiesApiVersion("0.2", "0.2.0")).toBe(true);
    expect(satisfiesApiVersion("0.2.0", "0.2.1")).toBe(false);
  });

  it("caret on 0.x locks the minor (incubation rule)", () => {
    expect(satisfiesApiVersion("^0.2", "0.2.0")).toBe(true);
    expect(satisfiesApiVersion("^0.2.0", "0.2.5")).toBe(true);
    expect(satisfiesApiVersion("^0.2", "0.3.0")).toBe(false);
    expect(satisfiesApiVersion("^0.1", "0.2.0")).toBe(false);
  });

  it("caret on >=1 locks the major", () => {
    expect(satisfiesApiVersion("^1.2.3", "1.3.0")).toBe(true);
    expect(satisfiesApiVersion("^1.2.3", "1.2.2")).toBe(false);
    expect(satisfiesApiVersion("^1.2.3", "2.0.0")).toBe(false);
  });

  it("defaults to the SDK's own API_VERSION", () => {
    expect(satisfiesApiVersion(`^${API_VERSION}`)).toBe(true);
  });

  it("malformed input is a refusal, not a pass", () => {
    expect(satisfiesApiVersion("latest")).toBe(false);
    expect(satisfiesApiVersion("^x.y")).toBe(false);
  });
});

describe("API_VERSION policy (ADR 304, amendment 2026-11-28)", () => {
  const [major, generation, revision] = API_VERSION.split(".").map(Number) as [
    number,
    number,
    number,
  ];

  it("is 0.<generation>.<revision>, and the revision has moved", () => {
    expect(API_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    // It sat at 0.2.0 through several hundred contract changes; a value
    // back at the start of a generation's first one means the counter was
    // reset by hand.
    expect(API_VERSION).not.toBe("0.2.0");
    expect(major).toBe(0);
  });

  it("the contract guard can read the line it holds to 'greater than before'", () => {
    const source = readFileSync(
      join(import.meta.dir, "..", "src", "version.ts"),
      "utf8",
    );
    const match = /export const API_VERSION = "(\d+)\.(\d+)\.(\d+)";/.exec(
      source,
    );
    expect(match?.slice(1).join(".")).toBe(API_VERSION);
  });

  it("a host older than the revision a manifest names is refused", () => {
    const needsNewer = `^0.${generation}.${revision + 1}`;
    expect(satisfiesApiVersion(needsNewer)).toBe(false);
    expect(explainApiMismatch(needsNewer)).toContain("update the host");
    expect(satisfiesApiVersion(`^0.${generation}.${revision}`)).toBe(true);
    expect(satisfiesApiVersion(`^0.${generation}.${revision - 1}`)).toBe(true);
  });

  it("another generation is refused in both directions", () => {
    const older = `^0.${generation - 1}`;
    const newer = `^0.${generation + 1}`;
    expect(satisfiesApiVersion(older)).toBe(false);
    expect(satisfiesApiVersion(newer)).toBe(false);
    expect(explainApiMismatch(older)).toContain("older plugin API generation");
    expect(explainApiMismatch(newer)).toContain("newer plugin API generation");
  });

  it("the generation range accepts this host and names no revision", () => {
    expect(API_GENERATION_RANGE).toBe(`^0.${generation}`);
    expect(satisfiesApiVersion(API_GENERATION_RANGE)).toBe(true);
    expect(explainApiMismatch(API_GENERATION_RANGE)).toBeNull();
  });

  it("explains an exact pin and an unreadable range", () => {
    expect(explainApiMismatch("0.2.0", "0.2.5")).toContain("caret range");
    expect(explainApiMismatch("latest")).toContain("not a range");
  });

  it("loadBundle refuses a bundle that needs a later revision, and says why", () => {
    const fake = makeFakeEditor();
    const bundle = defineBundle({
      manifest: {
        id: "media.paged.test.version",
        name: "version",
        version: "0.0.0",
        apiVersion: `^0.${generation}.${revision + 1}`,
      },
      activate: () => ({ dispose() {} }),
    });
    expect(() => loadBundle(() => fake.editor, bundle)).toThrow(
      new RegExp(
        `needs plugin API 0\\.${generation}\\.${revision + 1} or later and this host implements ` +
          API_VERSION.replaceAll(".", "\\."),
      ),
    );
  });
});
