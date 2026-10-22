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

// The feature store (docs/composable-editor.md §6): everything is on until a
// rule says otherwise; rules apply oldest first, so the newest wins; a glob
// covers a family; a predicate sees the state and the older answer and may
// defer to it; a throwing predicate offers nothing. The command and
// keybinding registries consult it: a command the editor does not offer is
// refused by `invoke` and its binding is no candidate for its key.

import { describe, expect, test } from "bun:test";

import { createCommandRegistry } from "../../src/registries/command";
import { createKeybindingRegistry } from "../../src/registries/keybinding";
import { entryApplies } from "../../src/registries/types";
import { createFeatureStore } from "../../src/state/features";

describe("createFeatureStore", () => {
  test("everything is on until a rule says otherwise", () => {
    const f = createFeatureStore();
    expect(f.isEnabled("command:paged.object.lock")).toBe(true);
    expect(f.allows("chrome", "rulers")).toBe(true);
  });

  test("the newest rule wins, globs cover families", () => {
    const f = createFeatureStore();
    f.disable("command:paged.object.*");
    expect(f.allows("command", "paged.object.lock")).toBe(false);
    expect(f.allows("command", "paged.file.save")).toBe(true);
    f.enable("command:paged.object.lock");
    expect(f.allows("command", "paged.object.lock")).toBe(true);
    expect(f.allows("command", "paged.object.hide")).toBe(false);
  });

  test("a predicate sees the state and may defer to the older answer", () => {
    let pages = 1;
    const f = createFeatureStore(() => ({ pages }));
    f.disable("command:paged.page.*");
    f.set("command:paged.page.add", ({ state, previous }) =>
      (state as { pages: number }).pages < 3 ? true : previous,
    );
    expect(f.allows("command", "paged.page.add")).toBe(true);
    pages = 5;
    expect(f.allows("command", "paged.page.add")).toBe(false);
    expect(f.allows("command", "paged.page.remove")).toBe(false);
  });

  test("a throwing predicate offers nothing", () => {
    const f = createFeatureStore();
    f.set("panel:paged.layers", () => {
      throw new Error("boom");
    });
    expect(f.allows("panel", "paged.layers")).toBe(false);
  });

  test("reset removes a pattern's rules; listeners hear every change", () => {
    const f = createFeatureStore();
    let heard = 0;
    const sub = f.onChange(() => heard++);
    f.disable(["panel:a", "panel:b"]);
    f.reset("panel:a");
    expect(f.allows("panel", "a")).toBe(true);
    expect(f.allows("panel", "b")).toBe(false);
    expect(heard).toBe(2);
    sub.dispose();
    f.disable("panel:c");
    expect(heard).toBe(2);
    expect(f.rules().map((r) => r.pattern)).toEqual(["panel:b", "panel:c"]);
  });
});

describe("the registries consult it", () => {
  const setup = () => {
    const features = createFeatureStore();
    const commands = createCommandRegistry(() => null, features);
    let ran = 0;
    commands.register({
      id: "test.go",
      title: "Go",
      handler: () => void ran++,
    });
    const keybindings = createKeybindingRegistry(
      commands,
      () => null,
      features,
    );
    keybindings.register({ key: "g", command: "test.go" });
    return { features, commands, keybindings, ran: () => ran };
  };
  const press = {
    key: "g",
    code: "KeyG",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
  };

  test("invoke refuses a command the editor does not offer", async () => {
    const t = setup();
    t.features.disable("command:test.go");
    await t.commands.invoke("test.go");
    expect(t.ran()).toBe(0);
    t.features.enable("command:test.go");
    await t.commands.invoke("test.go");
    expect(t.ran()).toBe(1);
  });

  test("an entry onto it does not apply", () => {
    const t = setup();
    expect(entryApplies(undefined, "test.go", t.commands, () => null)).toBe(
      true,
    );
    t.features.disable("command:test.go");
    expect(entryApplies(undefined, "test.go", t.commands, () => null)).toBe(
      false,
    );
  });

  test("its binding is no candidate, by command or by binding id", () => {
    const t = setup();
    expect(t.keybindings.resolve(press)?.command).toBe("test.go");
    t.features.disable("command:test.go");
    expect(t.keybindings.resolve(press)).toBeNull();
    t.features.reset("command:test.go");
    t.features.disable("keybinding:g→test.go");
    expect(t.keybindings.resolve(press)).toBeNull();
  });

  test("the command registry changes when the features do", () => {
    const t = setup();
    let heard = 0;
    t.commands.onChange(() => heard++);
    t.features.disable("command:test.go");
    expect(heard).toBe(1);
  });
});
