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

// A viewer is canvas-only and quiet, whatever its role (editor ADR 274,
// amendment of 2026-11-18): the viewer preset mounted as the docs' scripting
// lab mounts it (editor ADR 212, amendment 1), over the real engine with the
// app's canvas. Its rail shows Hand and Zoom and the Hand is in hand; there
// is no modifier-hint strip and there are no fill and stroke wells, with the
// viewer's own role and with the editing role a script needs to write. A
// host turns the page thumbnails off through the profile's canvas furniture.
// The full editor is the control: Selection in hand, its hints, its wells.

import { afterEach, describe, expect, test } from "bun:test";

import { gestureFixture } from "@paged-media/test-kit";
import {
  createEditorScope,
  HAND_TOOL_ID,
  memoryStorage,
  resolveProfile,
  SELECT_TOOL_ID,
  setEditorStorage,
  ZOOM_TOOL_ID,
} from "@paged-media/shell";

import { profileOf, type EditorConfig } from "../../src/embed/create-editor";
import { PRESETS } from "../../src/profiles/presets";
import { mountCanvas, type MountedCanvas } from "../tools/canvas-dom";

let c: MountedCanvas | null = null;
afterEach(() => {
  c?.dispose();
  c = null;
});

/** An editor mounted with a host's `profile` and `role`, its settings in
 *  memory (so no earlier test has used a tool up). */
async function mount(config: Pick<EditorConfig, "profile" | "role">) {
  const { profile, problems } = resolveProfile(profileOf(config), PRESETS);
  expect(problems).toEqual([]);
  const scope = createEditorScope();
  setEditorStorage(scope, memoryStorage());
  c = await mountCanvas(gestureFixture("targets"), { profile, scope });
  return { editor: c, profile };
}

const railTools = (root: Element) =>
  [...root.querySelectorAll("[data-tool-slot]")]
    .map((el) => el.getAttribute("data-tool"))
    .sort();

const HINTS = "[data-modifier-hints]";
const WELLS = "[data-fill-stroke-cluster]";
const THUMBNAILS = "[data-thumbnail-rail]";

describe("a viewer is canvas-only and quiet", () => {
  test("the docs lab's editor (the viewer with role editor): Hand in hand, no hints, no wells", async () => {
    const { editor, profile } = await mount({
      profile: "viewer",
      role: "editor",
    });
    expect(profile.role).toBe("editor");
    expect(editor.state.paged.tool.effectiveTool).toBe(HAND_TOOL_ID);
    const root = editor.root();
    expect(railTools(root)).toEqual([HAND_TOOL_ID, ZOOM_TOOL_ID].sort());
    expect(root.querySelector(HINTS)).toBeNull();
    expect(root.querySelector(WELLS)).toBeNull();
    // The preset keeps its page thumbnails.
    expect(root.querySelector(THUMBNAILS)).not.toBeNull();
  });

  test("the viewer with its own role is as quiet", async () => {
    const { editor, profile } = await mount({ profile: "viewer" });
    expect(profile.role).toBe("viewer");
    expect(editor.state.paged.tool.effectiveTool).toBe(HAND_TOOL_ID);
    const root = editor.root();
    expect(railTools(root)).toEqual([HAND_TOOL_ID, ZOOM_TOOL_ID].sort());
    expect(root.querySelector(HINTS)).toBeNull();
    expect(root.querySelector(WELLS)).toBeNull();
  });

  test("a host turns the thumbnails off through the profile's canvas furniture", async () => {
    const { editor, profile } = await mount({
      profile: { extends: "viewer", canvas: { thumbnails: false } },
      role: "editor",
    });
    expect(profile.canvas.thumbnails).toBe(false);
    const root = editor.root();
    expect(root.querySelector(THUMBNAILS)).toBeNull();
    expect(root.querySelector(HINTS)).toBeNull();
    expect(root.querySelector(WELLS)).toBeNull();
    expect(root.querySelector("[data-paged-viewport]")).not.toBeNull();
  });

  test("the full editor is unchanged: Selection in hand, its hints and the wells", async () => {
    const { editor } = await mount({});
    expect(editor.state.paged.tool.effectiveTool).toBe(SELECT_TOOL_ID);
    const root = editor.root();
    expect(railTools(root)).toContain(SELECT_TOOL_ID);
    expect(
      root.querySelector(`[data-modifier-hints="${SELECT_TOOL_ID}"]`),
    ).not.toBeNull();
    expect(root.querySelector(WELLS)).not.toBeNull();
    expect(root.querySelector(THUMBNAILS)).not.toBeNull();
  });
});
