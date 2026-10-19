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

// The public test doubles (src/testing.ts) and the fake editor's `ids`, as
// a bundle's own activation test uses them.

import { describe, expect, it } from "bun:test";

import { defineBundle } from "../src/define-bundle";
import { createFakeEditor } from "../src/fake-editor";
import { loadBundle } from "../src/load";
import { mapBacking, silentConsole } from "../src/testing";

describe("mapBacking", () => {
  it("is a private in-memory StorageBacking, optionally seeded", () => {
    const a = mapBacking([["k", "1"]]);
    const b = mapBacking();
    expect(a.getItem("k")).toBe("1");
    expect(b.getItem("k")).toBeNull();
    a.setItem("x", "2");
    expect(a.keys()).toEqual(["k", "x"]);
    a.removeItem("k");
    expect(a.keys()).toEqual(["x"]);
    expect(b.keys()).toEqual([]);
  });
});

describe("silentConsole", () => {
  it("has the four levels and says nothing", () => {
    for (const level of ["debug", "info", "warn", "error"] as const) {
      expect(silentConsole[level]("anything")).toBeUndefined();
    }
    expect(Object.isFrozen(silentConsole)).toBe(true);
  });
});

describe("an activation test over the SDK's doubles", () => {
  const bundle = defineBundle({
    manifest: {
      id: "com.example.hello",
      name: "Hello",
      version: "0.1.0",
      apiVersion: "^0.2",
      contributes: { commands: ["com.example.hello.command.report"] },
    },
    activate(host) {
      host.storage.set("seen", true);
      return host.contribute.command({
        id: "com.example.hello.command.report",
        title: "Report",
        handler: () => {},
      });
    },
  });

  it("reads back the registrations, and dispose leaves the editor as found", () => {
    const fake = createFakeEditor();
    const storage = mapBacking();
    const loaded = loadBundle(() => fake.editor, bundle, {
      console: silentConsole,
      storage,
    });
    expect(fake.ids("commands")).toEqual(["com.example.hello.command.report"]);
    expect(storage.keys().length).toBe(1);
    loaded.dispose();
    expect(fake.ids("commands")).toEqual([]);
  });
});
