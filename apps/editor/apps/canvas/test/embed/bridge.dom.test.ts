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

// The iframe bridge's gate (plan E6): the frame answers only its parent,
// only from an allowed origin, and once an origin has initialised the
// editor, no other origin is heard.

import { describe, expect, test } from "bun:test";

import { serveBridge } from "../../src/embed/bridge";
import type { EditorConfig, EditorHandle } from "../../src/embed/create-editor";
import { unknownSeed } from "../../src/embed/errors";
import { BRIDGED_METHODS, embedOrigins } from "../../src/embed/protocol";

function rig() {
  const self = new EventTarget() as unknown as Window;
  const posted: { msg: { type: string }; origin: string }[] = [];
  const peer = {
    postMessage: (msg: { type: string }, origin: string) =>
      posted.push({ msg, origin }),
  } as unknown as Window;
  const stranger = {} as Window;
  const send = (data: unknown, origin: string, source: Window = peer) =>
    self.dispatchEvent(
      Object.assign(new Event("message"), { data, origin, source }),
    );
  return { self, peer, stranger, posted, send };
}

describe("iframe bridge", () => {
  test("announces itself, and ignores a foreign origin and a window that is not its parent", async () => {
    const r = rig();
    void serveBridge({
      element: document.createElement("div"),
      peer: r.peer,
      self: r.self,
      origins: ["https://host.example"],
    });
    expect(r.posted.map((p) => p.msg.type)).toEqual(["paged:loaded"]);
    // A call before init, from the right origin, is ignored without an
    // origin to answer to; from a foreign origin or another window too.
    r.send(
      { type: "paged:call", id: 1, method: "save", args: [] },
      "https://evil.example",
    );
    r.send({ type: "paged:init", config: {} }, "https://evil.example");
    r.send(
      { type: "paged:init", config: {} },
      "https://host.example",
      r.stranger,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(r.posted.map((p) => p.msg.type)).toEqual(["paged:loaded"]);
  });

  test("init hands the seed to the editor; fitSelection reaches the handle (ADR 212, amendment 1)", async () => {
    const r = rig();
    const made: EditorConfig[] = [];
    let fits = 0;
    const handle = {
      on: () => () => {},
      fitSelection: async () => void (fits += 1),
    } as unknown as EditorHandle;
    const ready = serveBridge({
      element: document.createElement("div"),
      peer: r.peer,
      self: r.self,
      origins: ["https://host.example"],
      create: async (_element, config) => {
        made.push(config);
        return handle;
      },
    });
    r.send(
      {
        type: "paged:init",
        config: { profile: "viewer", seed: "flyer" },
      },
      "https://host.example",
    );
    expect(await ready).toBe(handle);
    expect(made.map((c) => [c.profile, c.seed])).toEqual([["viewer", "flyer"]]);
    expect(BRIDGED_METHODS).toContain("fitSelection");
    r.send(
      { type: "paged:call", id: 4, method: "fitSelection", args: [] },
      "https://host.example",
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fits).toBe(1);
    expect(r.posted.map((p) => p.msg)).toContainEqual({
      type: "paged:reply",
      id: 4,
      ok: true,
    });
  });

  test("an unknown seed fails the init with its code", async () => {
    const r = rig();
    const ready = serveBridge({
      element: document.createElement("div"),
      peer: r.peer,
      self: r.self,
      origins: ["https://host.example"],
      create: async (_element, config) => {
        throw unknownSeed(String(config.seed), ["blank", "flyer"]);
      },
    });
    r.send(
      { type: "paged:init", config: { seed: "nope" } },
      "https://host.example",
    );
    expect(await ready).toBeNull();
    expect(r.posted.at(-1)?.msg).toEqual({
      type: "paged:failed",
      code: "unknownSeed",
      error: 'No seed document is named "nope". The seeds: blank, flyer.',
    });
  });

  test("the allowed origins are the deploy's list and the editor's own", () => {
    expect(
      embedOrigins(
        " https://a.example/, https://b.example ",
        "https://editor.example",
      ),
    ).toEqual([
      "https://editor.example",
      "https://a.example",
      "https://b.example",
    ]);
    expect(embedOrigins(undefined, "https://editor.example")).toEqual([
      "https://editor.example",
    ]);
  });
});
