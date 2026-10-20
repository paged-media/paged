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

// The demo guide (editor ADR 269): the playground's card floating over the
// editor. Its first view is the demo's title, a plain line, the steps and
// play / restart; the script sits behind "Show the script". It collapses
// to a pill and docks to either bottom corner, and remembers both (and the
// script disclosure) per viewer under `paged.demoGuide.v1`.

import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

import { covers, stubGlobal, unstubAllGlobals } from "@paged-media/test-kit";
import {
  DemoOverlay,
  demoResetOverlay,
  demoShowInfo,
} from "@paged-media/shell";

import {
  PlaygroundController,
  SCRIPTING_DOCS,
} from "../../../src/playground/PlaygroundController";
import { GUIDE_PREFS_KEY } from "../../../src/playground/guide-prefs";

const happyDOM = (
  window as unknown as { happyDOM: { setURL(url: string): void } }
).happyDOM;
const STARTING_URL = window.location.href;
function at(search: string) {
  happyDOM.setURL(`http://localhost:5180/${search}`);
}

const SOURCE = [
  "// Draw a frame.",
  'await demo.showInfo("Draw a frame", "A frame appears.");',
  "const n = 3;",
  'await demo.showInfo("Fill it", "It turns violet.");',
].join("\n");

function serve() {
  stubGlobal("fetch", async (url: string) => {
    if (url === "/scripts/manifest.json")
      return new Response(
        JSON.stringify({
          scripts: [
            {
              id: "intro",
              title: "Draw & fill a frame",
              description: "A script draws a frame and fills it.",
            },
          ],
        }),
        { status: 200 },
      );
    if (url === "/scripts/intro.js")
      return new Response(SOURCE, { status: 200 });
    return new Response("not found", { status: 404 });
  });
}

const $ = <T extends Element = HTMLElement>(sel: string) =>
  document.querySelector<T>(sel);
const root = () => $("[data-playground]")!;
const stored = () => JSON.parse(localStorage.getItem(GUIDE_PREFS_KEY) ?? "{}");

async function mount(search = "?script=intro") {
  serve();
  at(search);
  const r = render(<PlaygroundController />);
  await waitFor(() =>
    expect($("[data-playground]")?.textContent).toContain(
      "Draw & fill a frame",
    ),
  );
  return r;
}

beforeEach(() => {
  localStorage.clear();
  // A session needs a live editor handle; an empty one is enough to
  // split the script into statements and steps.
  (window as unknown as { __canvas?: unknown }).__canvas = {};
});
afterAll(() => happyDOM.setURL(STARTING_URL));
afterEach(() => {
  cleanup();
  unstubAllGlobals();
  localStorage.clear();
  at("");
  delete (window as unknown as { __canvas?: unknown }).__canvas;
});

describe("the demo guide's first view", () => {
  test("title, a plain line, the steps and play / restart; the script hidden", async () => {
    covers("setting:paged.demoGuide.v1");
    await mount();
    expect($("[data-playground-title]")?.textContent).toBe(
      "Draw & fill a frame",
    );
    expect($("[data-playground-description]")?.textContent).toBe(
      "A script draws a frame and fills it.",
    );
    await waitFor(() =>
      expect(
        document.querySelectorAll("[data-playground-chapter]").length,
      ).toBe(2),
    );
    const steps = document.querySelectorAll("[data-playground-chapter]");
    expect($("[data-playground-now]")?.textContent).toBe("2 steps");
    expect(steps[0].getAttribute("aria-label")).toBe("Step 1: Draw a frame");
    expect($("[data-playground-play]")?.getAttribute("aria-label")).toBe(
      "Play",
    );
    expect($("[data-playground-restart]")?.textContent).toBe("Restart");
    expect(root().getAttribute("data-playground-status")).toBe("idle");
    // The code is secondary: behind the disclosure, closed.
    const disclosure = $("[data-playground-script-toggle]")!;
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    expect(disclosure.textContent).toContain("Show the script");
    expect($("[data-playground-code]")).toBeNull();
    expect($("[data-playground-step]")).toBeNull();
  });
});

describe("Show the script", () => {
  test("opens the highlighted source with step, speed, copy and the docs link", async () => {
    covers("setting:paged.demoGuide.v1");
    const copied: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (t: string) => void copied.push(t) },
    });
    await mount();
    const disclosure = $("[data-playground-script-toggle]")!;
    fireEvent.click(disclosure);
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    expect(disclosure.textContent).toContain("Hide the script");
    const code = $("[data-playground-code]")!;
    expect(code.querySelectorAll("[data-line]").length).toBe(4);
    expect(code.textContent).toContain("const n = 3;");
    // Highlighted: the keyword and the comment are their own spans.
    const spans = [...code.querySelectorAll("span")].map((s) => s.textContent);
    expect(spans).toContain("const");
    expect(spans).toContain("// Draw a frame.");
    expect($("[data-playground-step]")).not.toBeNull();
    expect(
      [...document.querySelectorAll('[aria-label="Speed"] button')].map((b) =>
        b.getAttribute("aria-pressed"),
      ),
    ).toEqual(["false", "true", "false"]);
    expect($<HTMLAnchorElement>("[data-playground-docs]")?.href).toBe(
      SCRIPTING_DOCS,
    );
    await act(async () => {
      fireEvent.click($("[data-playground-copy]")!);
    });
    expect(copied).toEqual([SOURCE]);
    await waitFor(() =>
      expect($("[data-playground-copy]")?.textContent).toBe("Copied"),
    );
    expect(stored().script).toBe(true);
  });
});

describe("collapse and expand", () => {
  test("the collapse button folds the guide to a pill and back; focus follows", async () => {
    covers("setting:paged.demoGuide.v1");
    await mount();
    const collapse = $("[data-playground-toggle]")!;
    expect(collapse.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(collapse);
    expect($("[data-playground-source]")).toBeNull();
    const pill = $("[data-playground-toggle]")!;
    expect(pill.getAttribute("aria-expanded")).toBe("false");
    expect(pill.textContent).toContain("Demo");
    expect(pill.textContent).toContain("Draw & fill a frame");
    expect(pill.getAttribute("aria-controls")).toBeTruthy();
    expect(document.activeElement).toBe(pill);
    // The pill keeps play / pause at hand.
    expect($("[data-playground-play]")).not.toBeNull();
    expect(root().getAttribute("data-playground-collapsed")).toBe("true");
    expect(stored().collapsed).toBe(true);

    fireEvent.click(pill);
    expect($("[data-playground-source]")).not.toBeNull();
    expect(document.activeElement).toBe($("[data-playground-toggle]"));
    expect(stored().collapsed).toBe(false);
  });

  test("Escape inside the guide collapses it", async () => {
    covers("setting:paged.demoGuide.v1");
    await mount();
    const play = $("[data-playground-play]")!;
    play.focus();
    fireEvent.keyDown(play, { key: "Escape" });
    expect($("[data-playground-source]")).toBeNull();
    expect(document.activeElement).toBe($("[data-playground-toggle]"));
  });

  test("the guide docks to the other corner, and the narration box moves aside", async () => {
    covers("setting:paged.demoGuide.v1");
    await mount();
    render(<DemoOverlay />);
    act(() => void demoShowInfo({ title: "Draw a frame" }));
    await waitFor(() => expect($("[data-demo-overlay]")).not.toBeNull());
    expect(root().getAttribute("data-playground-side")).toBe("left");
    expect($("[data-demo-overlay]")!.style.right).toBe("24px");

    fireEvent.click($("[data-playground-dock]")!);
    expect(root().getAttribute("data-playground-side")).toBe("right");
    expect(stored().side).toBe("right");
    await waitFor(() =>
      expect($("[data-demo-overlay]")!.style.left).toBe("24px"),
    );
    act(() => demoResetOverlay());
  });
});

describe("remembered per viewer", () => {
  test("a stored layout is where the guide starts", async () => {
    covers("setting:paged.demoGuide.v1");
    localStorage.setItem(
      GUIDE_PREFS_KEY,
      JSON.stringify({ collapsed: true, side: "right", script: true }),
    );
    await mount();
    expect(root().getAttribute("data-playground-collapsed")).toBe("true");
    expect(root().getAttribute("data-playground-side")).toBe("right");
    fireEvent.click($("[data-playground-toggle]")!);
    expect($("[data-playground-code]")).not.toBeNull();
  });

  test("an embed starts as the pill whatever was stored", async () => {
    covers("setting:paged.demoGuide.v1");
    localStorage.setItem(GUIDE_PREFS_KEY, JSON.stringify({ collapsed: false }));
    await mount("?script=intro&embed");
    expect(root().getAttribute("data-playground-collapsed")).toBe("true");
  });

  test("storage that throws leaves the defaults", async () => {
    covers("setting:paged.demoGuide.v1");
    const refuse = () => {
      throw new Error("SecurityError");
    };
    stubGlobal("localStorage", {
      getItem: refuse,
      setItem: refuse,
      removeItem: refuse,
      clear: () => {},
      key: () => null,
      length: 0,
    });
    await mount();
    expect(root().getAttribute("data-playground-collapsed")).toBe("false");
    fireEvent.click($("[data-playground-toggle]")!);
    expect(root().getAttribute("data-playground-collapsed")).toBe("true");
  });

  test("a stored value of the wrong shape is ignored", async () => {
    covers("setting:paged.demoGuide.v1");
    localStorage.setItem(
      GUIDE_PREFS_KEY,
      JSON.stringify({ collapsed: "yes", side: "top" }),
    );
    await mount();
    expect(root().getAttribute("data-playground-collapsed")).toBe("false");
    expect(root().getAttribute("data-playground-side")).toBe("left");
  });
});
