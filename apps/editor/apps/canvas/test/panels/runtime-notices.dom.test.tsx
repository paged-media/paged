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

// What the editor runs on and where files go, said where it is seen: the
// CPU notice once the worker reports a canvas without WebGPU, the desktop
// notice in a desktop editor below the phone breakpoint (editor ADR 294),
// and the empty canvas's privacy line in an editor that is the page. Each
// in English and German.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { useLayoutEffect } from "react";
import {
  BUILT_IN_LOCALES,
  createStrings,
  englishSource,
  setActiveStrings,
} from "@paged-media/strings";
import {
  REGION_IDS,
  chromeRegionsOf,
  useInstrumentation,
  type RegionId,
  type ResolvedRegion,
} from "@paged-media/shell";

import "../../src/strings";
import {
  EditorInstanceProvider,
  type EditorInstance,
} from "../../src/app/instance";
import { EmptyCanvas, PrivacyLine } from "../../src/panels/empty-canvas";
import {
  CpuRenderingNotice,
  DesktopScreenNotice,
} from "../../src/panels/runtime-notices";
import { mountPanel, unmountAll } from "./harness";

const german = () => setActiveStrings(createStrings("de", BUILT_IN_LOCALES.de));

// happy-dom reports a driven browser (`navigator.webdriver` is true), where
// the notices stay away; these tests are the user's browser.
function setAutomation(on: boolean | null) {
  if (on === null) {
    delete (navigator as { webdriver?: boolean }).webdriver;
    return;
  }
  Object.defineProperty(navigator, "webdriver", {
    configurable: true,
    get: () => on,
  });
}

const realWidth = window.innerWidth;
function setWidth(px: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: px,
  });
}

beforeEach(() => setAutomation(false));
afterEach(() => {
  unmountAll();
  setAutomation(null);
  setWidth(realWidth);
  setActiveStrings(createStrings());
});

// The worker's `attachReady.gpuActive`, as the shell hands it on.
let setGpu: ((active: boolean | null) => void) | null = null;
function CpuProbe() {
  const { setGpuActive } = useInstrumentation();
  useLayoutEffect(() => {
    setGpu = setGpuActive;
  });
  return <CpuRenderingNotice />;
}

const notice = (kind: string) =>
  document.querySelector(`[data-runtime-notice="${kind}"]`);

describe("the CPU notice", () => {
  test("says the canvas is drawn on the CPU once the worker reports it, and Hide hides it", async () => {
    const h = await mountPanel(CpuProbe, {
      id: "test.cpu-notice",
      document: "none",
    });
    // Not known yet: the worker has attached no canvas.
    expect(notice("cpu")).toBeNull();
    await h.act(() => setGpu!(true));
    expect(notice("cpu")).toBeNull();
    await h.act(() => setGpu!(false));
    expect(notice("cpu")?.textContent).toContain(
      "WebGPU is not available in this browser, so pages are drawn on the CPU at lower resolution.",
    );
    expect(notice("cpu")?.getAttribute("role")).toBe("status");
    await h.click(
      notice("cpu")!.querySelector<HTMLElement>("[data-runtime-notice-hide]")!,
    );
    expect(notice("cpu")).toBeNull();
  });

  test("in German", async () => {
    german();
    const h = await mountPanel(CpuProbe, {
      id: "test.cpu-notice",
      document: "none",
    });
    await h.act(() => setGpu!(false));
    expect(notice("cpu")?.textContent).toContain(
      "WebGPU ist in diesem Browser nicht verfügbar, daher werden die Seiten auf der CPU in geringerer Auflösung gezeichnet.",
    );
    expect(notice("cpu")?.textContent).toContain("Ausblenden");
  });

  test("a driven browser shows nothing", async () => {
    setAutomation(true);
    const h = await mountPanel(CpuProbe, {
      id: "test.cpu-notice",
      document: "none",
    });
    await h.act(() => setGpu!(false));
    expect(notice("cpu")).toBeNull();
  });
});

const ALL: ResolvedRegion = { kind: "all", exclude: [], append: [] };
function fillShape() {
  const regions = {} as Record<RegionId, ResolvedRegion | null>;
  for (const id of REGION_IDS) regions[id] = ALL;
  regions.form = { kind: "list", items: ["paged.template.form"] };
  return chromeRegionsOf(
    regions,
    { rulers: false, titleBar: false, thumbnails: false },
    "field-sheet",
  );
}

describe("the desktop notice", () => {
  test("the full editor on a phone-sized root says what works there, and Hide hides it", async () => {
    setWidth(390);
    const h = await mountPanel(DesktopScreenNotice, {
      id: "test.desktop-notice",
      document: "none",
    });
    expect(notice("desktop")?.textContent).toContain(
      "This editor is made for desktop screens. On a phone, the Fill in and Form layouts work for filling in a template; for everything else, use a larger screen.",
    );
    await h.click(
      notice("desktop")!.querySelector<HTMLElement>(
        "[data-runtime-notice-hide]",
      )!,
    );
    expect(notice("desktop")).toBeNull();
  });

  test("in German", async () => {
    setWidth(390);
    german();
    await mountPanel(DesktopScreenNotice, {
      id: "test.desktop-notice",
      document: "none",
    });
    expect(notice("desktop")?.textContent).toContain(
      "Dieser Editor ist für Desktop-Bildschirme gemacht. Auf einem Smartphone eignen sich die Layouts „Ausfüllen“ und „Formular“ zum Ausfüllen einer Vorlage; für alles andere nutzen Sie einen größeren Bildschirm.",
    );
  });

  test("not at the breakpoint or wider", async () => {
    setWidth(720);
    await mountPanel(DesktopScreenNotice, {
      id: "test.desktop-notice",
      document: "none",
    });
    expect(notice("desktop")).toBeNull();
  });

  test("not in a fill shape, nor for a viewer", async () => {
    setWidth(390);
    await mountPanel(DesktopScreenNotice, {
      id: "test.desktop-notice",
      document: "none",
      chrome: fillShape(),
      role: "filler",
    });
    expect(notice("desktop")).toBeNull();
    unmountAll();
    await mountPanel(DesktopScreenNotice, {
      id: "test.desktop-notice",
      document: "none",
      role: "viewer",
    });
    expect(notice("desktop")).toBeNull();
  });

  test("a driven browser shows nothing", async () => {
    setAutomation(true);
    setWidth(390);
    await mountPanel(DesktopScreenNotice, {
      id: "test.desktop-notice",
      document: "none",
    });
    expect(notice("desktop")).toBeNull();
  });
});

const PAGE = { ownsPage: true } as EditorInstance;
const EMBEDDED = { ownsPage: false } as EditorInstance;

function OwnedEmptyCanvas() {
  return (
    <EditorInstanceProvider instance={PAGE}>
      <EmptyCanvas />
    </EditorInstanceProvider>
  );
}

function EmbeddedEmptyCanvas() {
  return (
    <EditorInstanceProvider instance={EMBEDDED}>
      <EmptyCanvas />
    </EditorInstanceProvider>
  );
}

function WithServer() {
  return (
    <EditorInstanceProvider instance={PAGE}>
      <PrivacyLine server="https://server.example:8443" />
    </EditorInstanceProvider>
  );
}

const privacy = () => document.querySelector("[data-empty-privacy]");

describe("the empty canvas's privacy line", () => {
  test("an editor that is the page says files stay in the browser, and what Claude is sent", async () => {
    await mountPanel(OwnedEmptyCanvas, {
      id: "test.empty-canvas",
      document: "none",
    });
    expect(privacy()?.textContent).toBe(
      "Files you open are read in this browser and are not uploaded. Before a request goes to Claude, the editor lists what leaves this device and waits for you to agree.",
    );
  });

  test("in German", async () => {
    german();
    await mountPanel(OwnedEmptyCanvas, {
      id: "test.empty-canvas",
      document: "none",
    });
    expect(privacy()?.textContent).toBe(
      "Dateien, die Sie öffnen, werden in diesem Browser gelesen und nicht hochgeladen. Bevor eine Anfrage an Claude geht, zeigt der Editor, was dieses Gerät verlässt, und wartet auf Ihre Zustimmung.",
    );
  });

  test("a build with a paged.server names it and the two ways a document reaches it", async () => {
    await mountPanel(WithServer, { id: "test.privacy", document: "none" });
    expect(privacy()?.textContent).toBe(
      "Files you open are read in this browser. They reach server.example:8443 only when you push a document or connect this tab to Claude in the Library panel. Before a request goes to Claude, the editor lists what leaves this device and waits for you to agree.",
    );
  });

  test("an embedded editor leaves it to its host", async () => {
    await mountPanel(EmbeddedEmptyCanvas, {
      id: "test.empty-canvas",
      document: "none",
    });
    expect(document.querySelector("[data-empty-canvas]")).not.toBeNull();
    expect(privacy()).toBeNull();
    unmountAll();
    await mountPanel(EmptyCanvas, {
      id: "test.empty-canvas",
      document: "none",
    });
    expect(privacy()).toBeNull();
  });
});

test("the German catalogue has every new message, with its parameters", () => {
  const english = englishSource();
  const de = BUILT_IN_LOCALES.de!;
  const keys = [
    "app.runtimeNotice.cpu",
    "app.runtimeNotice.desktop",
    "app.runtimeNotice.hide",
    "app.emptyCanvas.privacy",
    "app.emptyCanvas.privacyServer",
  ];
  const params = (s: string) =>
    [...s.matchAll(/\{(\w+)[},]/g)].map((m) => m[1]).sort();
  for (const k of keys) {
    expect(english[k]).toBeDefined();
    expect(de[k]).toBeDefined();
    expect({ k, p: params(de[k]!) }).toEqual({ k, p: params(english[k]!) });
  }
});
