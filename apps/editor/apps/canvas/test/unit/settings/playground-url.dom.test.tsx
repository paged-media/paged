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

// The playground's URL flags, read once when their component mounts:
//
//   · `url.script` (PlaygroundController): `?script=<id>` loads the live
//     script /scripts/<id>.js and its manifest entry into the demo guide;
//     `&embed` starts the guide collapsed to its pill; `&autoplay` plays it
//     at once.
//   · `url.embed` (IframeScriptBridge): `?embed=script` opens a blank
//     document once the editor is up, announces `paged:ready` to the
//     allowed parent origins, and runs `paged:run` messages from them —
//     re-seeded first when `&seed=<name>` names a seed prelude.

import { act, cleanup, render, waitFor } from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

import { covers, stubGlobal, unstubAllGlobals } from "@paged-media/test-kit";

import { IframeScriptBridge } from "../../../src/playground/IframeScriptBridge";
import { PlaygroundController } from "../../../src/playground/PlaygroundController";
import { seedPrelude } from "../../../src/playground/seeds";

const DOCS = "https://docs.paged.media";

const happyDOM = (
  window as unknown as { happyDOM: { setURL(url: string): void } }
).happyDOM;
/** Where the DOM lane's window starts; put back when this file is done,
 *  because a worker's later test files share the window. */
const STARTING_URL = window.location.href;

/** Navigate the test window to the editor's origin at `search` (the
 *  realm starts at about:blank, where history cannot set a query). */
function at(search: string) {
  happyDOM.setURL(`http://localhost:5180/${search}`);
}

type CanvasStub = {
  registries: { commands: { invoke: (id: string) => Promise<unknown> } };
  client: {
    executeScript: (
      src: string,
    ) => Promise<{ output: string[]; error: string | null }>;
  };
};

/** A `window.__canvas` that records File ▸ New and every script run. */
function installCanvas() {
  const log: string[] = [];
  const canvas: CanvasStub = {
    registries: {
      commands: {
        invoke: async (id) => void log.push(`invoke ${id}`),
      },
    },
    client: {
      executeScript: async (src) => {
        log.push(`run ${src.length > 30 ? `${src.slice(0, 30)}…` : src}`);
        return { output: [`ran ${src.length}`], error: null };
      },
    },
  };
  (window as unknown as { __canvas?: CanvasStub }).__canvas = canvas;
  return log;
}

/** Every `postMessage` the bridge sends to its parent (window.parent is
 *  window itself in the test realm). */
function captureParent() {
  const sent: Array<[unknown, string]> = [];
  const original = window.postMessage.bind(window);
  window.postMessage = ((data: unknown, origin: string) =>
    void sent.push([data, origin])) as typeof window.postMessage;
  return { sent, restore: () => (window.postMessage = original) };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  delete (window as unknown as { __canvas?: unknown }).__canvas;
});
afterAll(() => happyDOM.setURL(STARTING_URL));
afterEach(() => {
  cleanup();
  unstubAllGlobals();
  at("");
  delete (window as unknown as { __canvas?: unknown }).__canvas;
});

describe("setting url.script", () => {
  function serveScripts(scripts: Record<string, string>, manifest: unknown) {
    const asked: string[] = [];
    stubGlobal("fetch", async (url: string) => {
      asked.push(url);
      if (url === "/scripts/manifest.json")
        return new Response(JSON.stringify(manifest), { status: 200 });
      const id = url.match(/^\/scripts\/(.+)\.js$/)?.[1];
      return id && id in scripts
        ? new Response(scripts[id], { status: 200 })
        : new Response("not found", { status: 404 });
    });
    return asked;
  }

  test("absent: no playground, nothing fetched", async () => {
    covers("setting:url.script");
    const asked = serveScripts({}, { scripts: [] });
    at("");
    const { container } = render(<PlaygroundController />);
    await wait(20);
    expect(container.innerHTML).toBe("");
    expect(asked).toEqual([]);
  });

  test("?script=<id> loads the script and its manifest title, guide open", async () => {
    covers("setting:url.script");
    const asked = serveScripts(
      { intro: "const a = 1;" },
      { scripts: [{ id: "intro", title: "Introduction" }] },
    );
    at("?script=intro");
    render(<PlaygroundController />);
    await waitFor(() =>
      expect(
        document.querySelector("[data-playground-source]")?.textContent,
      ).toContain("Introduction"),
    );
    expect(asked.sort()).toEqual([
      "/scripts/intro.js",
      "/scripts/manifest.json",
    ]);
    expect(
      document
        .querySelector("[data-playground-toggle]")
        ?.getAttribute("aria-expanded"),
    ).toBe("true");
  });

  test("&embed starts with the guide collapsed to its pill", async () => {
    covers("setting:url.script");
    serveScripts({ intro: "const a = 1;" }, { scripts: [] });
    at("?script=intro&embed");
    render(<PlaygroundController />);
    await waitFor(() =>
      expect(
        document
          .querySelector("[data-playground-toggle]")
          ?.getAttribute("aria-expanded"),
      ).toBe("false"),
    );
    expect(document.querySelector("[data-playground-source]")).toBeNull();
  });

  test("&autoplay plays the script as soon as it loads; without it the session waits", async () => {
    covers("setting:url.script");
    serveScripts({ intro: "const a = 1;" }, { scripts: [] });
    (window as unknown as { __canvas?: unknown }).__canvas = {};
    const status = () =>
      document
        .querySelector("[data-playground]")
        ?.getAttribute("data-playground-status");
    at("?script=intro");
    const idle = render(<PlaygroundController />);
    await waitFor(() => expect(status()).toBe("idle"));
    await wait(50);
    expect(status()).toBe("idle");
    idle.unmount();
    at("?script=intro&autoplay");
    render(<PlaygroundController />);
    await waitFor(() => expect(status()).not.toBe("idle"), { timeout: 3000 });
  });
});

describe("setting url.embed", () => {
  test("absent, or not `script`: no bridge — no document, no ready message", async () => {
    covers("setting:url.embed");
    for (const search of ["", "?embed", "?embed=frame"]) {
      const log = installCanvas();
      const parent = captureParent();
      try {
        at(search);
        const view = render(<IframeScriptBridge />);
        await wait(400);
        expect({ search, log, sent: parent.sent }).toEqual({
          search,
          log: [],
          sent: [],
        });
        view.unmount();
      } finally {
        parent.restore();
      }
    }
  });

  test("?embed=script: once the editor is up, a blank document and one paged:ready per allowed origin", async () => {
    covers("setting:url.embed");
    const parent = captureParent();
    try {
      at("?embed=script");
      render(<IframeScriptBridge />);
      await wait(200);
      // Not up yet: nothing happens until window.__canvas has a client.
      expect(parent.sent).toEqual([]);
      const log = installCanvas();
      await waitFor(() => expect(parent.sent).toHaveLength(1));
      expect(log).toEqual(["invoke paged.file.new"]);
      expect(parent.sent[0]).toEqual([{ type: "paged:ready" }, DOCS]);
      await wait(400);
      expect(parent.sent).toHaveLength(1);
    } finally {
      parent.restore();
    }
  });

  test("&seed=<name> runs the seed after File > New, and again before each run", async () => {
    covers("setting:url.embed");
    const name = "two-frames";
    const prelude = seedPrelude(name);
    expect(prelude.length).toBeGreaterThan(0);
    const parent = captureParent();
    try {
      const log = installCanvas();
      at(`?embed=script&seed=${name}`);
      render(<IframeScriptBridge />);
      await waitFor(() => expect(parent.sent).toHaveLength(1));
      const seedRun = `run ${prelude.slice(0, 30)}…`;
      expect(log).toEqual(["invoke paged.file.new", seedRun]);
      const replies: unknown[] = [];
      await act(async () => {
        window.dispatchEvent(
          new MessageEvent("message", {
            data: { type: "paged:run", id: 7, source: "paged.pages()" },
            origin: DOCS,
            source: { postMessage: (m: unknown) => replies.push(m) } as never,
          }),
        );
        await wait(20);
      });
      expect(log.slice(2)).toEqual([
        "invoke paged.file.new",
        seedRun,
        "run paged.pages()",
      ]);
      expect(replies).toEqual([
        { type: "paged:result", id: 7, output: ["ran 13"], error: null },
      ]);
    } finally {
      parent.restore();
    }
  });

  test("a run from an origin that is not allowed is ignored", async () => {
    covers("setting:url.embed");
    const parent = captureParent();
    try {
      const log = installCanvas();
      at("?embed=script");
      render(<IframeScriptBridge />);
      await waitFor(() => expect(parent.sent).toHaveLength(1));
      const replies: unknown[] = [];
      await act(async () => {
        window.dispatchEvent(
          new MessageEvent("message", {
            data: { type: "paged:run", id: 1, source: "paged.pages()" },
            origin: "https://evil.example",
            source: { postMessage: (m: unknown) => replies.push(m) } as never,
          }),
        );
        await wait(20);
      });
      expect(log).toEqual(["invoke paged.file.new"]);
      expect(replies).toEqual([]);
    } finally {
      parent.restore();
    }
  });
});
