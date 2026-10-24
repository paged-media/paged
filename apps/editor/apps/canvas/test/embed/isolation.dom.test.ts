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

// No degraded mode (docs/composable-editor.md §12, decision 1 of
// 2026-10-24): on a page that is not cross-origin isolated, createEditor
// mounts nothing and rejects with an EditorError whose code a host branches
// on and whose message names the iframe path and the headers.

import { afterEach, describe, expect, test } from "bun:test";

import { createEditor } from "../../src/embed/create-editor";
import {
  assertEmbeddable,
  editorError,
  isEditorError,
  notCrossOriginIsolated,
} from "../../src/embed/errors";

const g = globalThis as { crossOriginIsolated?: unknown };
const before = Object.getOwnPropertyDescriptor(
  globalThis,
  "crossOriginIsolated",
);

afterEach(() => {
  if (before) Object.defineProperty(globalThis, "crossOriginIsolated", before);
  else delete g.crossOriginIsolated;
});

describe("createEditor without cross-origin isolation", () => {
  test("rejects with notCrossOriginIsolated and mounts nothing", async () => {
    Object.defineProperty(globalThis, "crossOriginIsolated", {
      value: false,
      configurable: true,
      writable: true,
    });
    const element = document.createElement("div");
    document.body.append(element);
    let caught: unknown;
    try {
      await createEditor(element, { profile: "template-fill" });
    } catch (error) {
      caught = error;
    }
    expect(isEditorError(caught)).toBe(true);
    const error = caught as Error & { code: string };
    expect(error.name).toBe("EditorError");
    expect(error.code).toBe("notCrossOriginIsolated");
    for (const words of [
      "connectEditor",
      "embed.html",
      "Cross-Origin-Opener-Policy: same-origin",
      "Cross-Origin-Embedder-Policy: credentialless",
      "cross-origin-isolated",
    ])
      expect(error.message).toContain(words);
    expect(element.childElementCount).toBe(0);
    element.remove();
  });

  test("an isolated page passes; anything but true refuses", () => {
    expect(() => assertEmbeddable(true)).not.toThrow();
    for (const value of [false, undefined, "true"])
      expect(() => assertEmbeddable(value)).toThrow(
        expect.objectContaining({ code: "notCrossOriginIsolated" }),
      );
  });

  test("the frame's refusal says the host page decides", () => {
    expect(notCrossOriginIsolated("frame").message).toContain(
      "a frame is isolated only when its host page is",
    );
  });

  test("isEditorError is structural and knows its codes", () => {
    expect(isEditorError(editorError("notCrossOriginIsolated", "x"))).toBe(
      true,
    );
    const foreign = Object.assign(new Error("x"), {
      name: "EditorError",
      code: "notCrossOriginIsolated",
    });
    expect(isEditorError(foreign)).toBe(true);
    expect(
      isEditorError(Object.assign(new Error("x"), { code: "other" })),
    ).toBe(false);
    expect(isEditorError({ name: "EditorError" })).toBe(false);
  });
});
