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
import { embedOrigins } from "../../src/embed/protocol";

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
