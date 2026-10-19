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

// THE BUNDLEHOST CONTRACT — `host.supports()`, per adapter, PINNED.
//
// A bundle decides what to offer from `supports()`: a door it answers true
// for must work, and one it answers false for must take the documented
// no-backend path (the other files of this folder assert both, door by
// door). This file pins WHICH features each adapter answers, so a backend
// the editor stops wiring (or starts wiring) shows up here by name instead
// of as a bundle that quietly lost a menu item, and states where the
// headless harness a bundle is tested on answers differently from the
// editor, and why.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { HOST_FEATURES } from "@paged-media/plugin-sdk";

import {
  bareAdapter,
  editorAdapter,
  headlessAdapter,
  type HostUnderTest,
} from "./hosts";

/** Every feature `supports()` can answer beyond the static set
 *  (plugin-sdk host-impl.ts, the `featureSet.add` calls). */
const DYNAMIC = [
  "journal@1",
  "text.measure@1",
  "text.measureStrings@1",
  "rendering.sceneLayer@1",
  "rendering.sceneLayer.faces@1",
  "rendering.sceneLayer.binary@1",
  "rendering.resourceProvider@1",
  "overlay.multiPreview@1",
  "overlay.layers@1",
  "editContext.enterPoint@1",
  "shell.openPanel@1",
  "shell.pickFile@1",
  "shell.saveFile@1",
  "shell.enterEditContext@1",
  "widgets.codeEditor@1",
  "widgets.colorPicker@1",
  "widgets.propertyField@1",
  "widgets.propertyField.values@1",
  "document.onWillSave@1",
  "document.mutateBinary@1",
  "tools.settings@1",
  "assets.documentFont@2",
  "assets.fonts@1",
  "assets.registerFont@1",
  "schemaPanel.renderer@1",
  "diagnostics.publish@1",
  "network.consent@1",
  "dataProviders@1",
  "bindings.provider@1",
  "objects.shared@1",
  "storage.blob@1",
  "clipboard@1",
  "text.caret@1",
  "document.readNative@1",
  "document.openNative@1",
  "documents.exportPaged@1",
  "documents.open@1",
  "viewport.pages@1",
  "viewport.revealText@1",
  "workers@1",
  "modules@1",
  "secrets@1",
  "gpu@1",
] as const;

/** What the editor answers: every door its host options wire, and the
 *  members of the shell's PagedEditor. Not: `journal@1` (HOST-4, the
 *  editor passes no journal) and `gpu@1` (a bundle's own declaration,
 *  which the probe does not make). */
const EDITOR = [
  "text.measure@1",
  "text.measureStrings@1",
  "rendering.sceneLayer@1",
  "rendering.sceneLayer.faces@1",
  "rendering.sceneLayer.binary@1",
  "rendering.resourceProvider@1",
  "overlay.multiPreview@1",
  "overlay.layers@1",
  "editContext.enterPoint@1",
  "shell.openPanel@1",
  "shell.pickFile@1",
  "shell.saveFile@1",
  "shell.enterEditContext@1",
  "widgets.codeEditor@1",
  "widgets.colorPicker@1",
  "widgets.propertyField@1",
  "widgets.propertyField.values@1",
  "document.onWillSave@1",
  "document.mutateBinary@1",
  "tools.settings@1",
  "assets.documentFont@2",
  "assets.fonts@1",
  "assets.registerFont@1",
  "schemaPanel.renderer@1",
  "diagnostics.publish@1",
  "network.consent@1",
  "dataProviders@1",
  "bindings.provider@1",
  "objects.shared@1",
  "storage.blob@1",
  "clipboard@1",
  "text.caret@1",
  "document.readNative@1",
  "document.openNative@1",
  "documents.exportPaged@1",
  "documents.open@1",
  "viewport.pages@1",
  "viewport.revealText@1",
  "workers@1",
  "modules@1",
  "secrets@1",
];

/** What the SDK's headless harness answers by default: its in-memory
 *  stores, its documents backend and its recording overlay. */
const HEADLESS = [
  "overlay.multiPreview@1",
  "overlay.layers@1",
  "editContext.enterPoint@1",
  "document.onWillSave@1",
  "tools.settings@1",
  "assets.documentFont@2",
  "dataProviders@1",
  "bindings.provider@1",
  "objects.shared@1",
  "storage.blob@1",
  "clipboard@1",
  "documents.exportPaged@1",
  "documents.open@1",
  "secrets@1",
];

/** What the editor answers and the harness does not, each for a stated
 *  reason: no UI or browser headlessly (shell, widgets, the renderer,
 *  consent, workers, modules, the caret, page navigation), no engine
 *  channel the harness client carries (scene layers, image resources,
 *  the binary lanes, the native-document and asset backends), and the
 *  engine shaper, which the harness wires only with `engineShaper: true`
 *  (it measures with an estimate by default). A bundle tested headlessly
 *  probes these and takes their no-backend path. */
const EDITOR_ONLY = EDITOR.filter((f) => !HEADLESS.includes(f));

const featuresOf = (t: HostUnderTest) =>
  DYNAMIC.filter((f) => t.host.supports(f));

describe("host.supports()", () => {
  let editor: HostUnderTest;
  let headless: HostUnderTest;
  let bare: HostUnderTest;
  beforeAll(async () => {
    editor = await editorAdapter();
    headless = await headlessAdapter();
    bare = await bareAdapter();
  });
  afterAll(async () => {
    await editor.dispose();
    await headless.dispose();
    await bare.dispose();
  });

  test("every adapter answers the static set (what this SDK implements)", () => {
    for (const t of [editor, headless, bare])
      expect(HOST_FEATURES.filter((f) => !t.host.supports(f))).toEqual([]);
  });

  test("an unknown feature is false", () => {
    for (const t of [editor, headless, bare]) {
      expect(t.host.supports("no.such.door@1")).toBe(false);
      expect(t.host.supports("storage.blob@99")).toBe(false);
    }
  });

  test("the editor answers exactly the doors its options and its PagedEditor wire", () => {
    expect(featuresOf(editor)).toEqual(EDITOR);
  });

  test("the headless harness answers its in-memory doors", () => {
    expect(featuresOf(headless)).toEqual(HEADLESS);
  });

  test("the bare adapter answers only what the engine editor itself carries", () => {
    expect(featuresOf(bare)).toEqual([
      "overlay.multiPreview@1",
      "overlay.layers@1",
      "assets.documentFont@2",
    ]);
  });

  test("the harness answers nothing the editor does not (a bundle tested headlessly meets no door the editor lacks)", () => {
    expect(HEADLESS.filter((f) => !EDITOR.includes(f))).toEqual([]);
    expect(EDITOR_ONLY.length).toBe(EDITOR.length - HEADLESS.length);
  });
});
