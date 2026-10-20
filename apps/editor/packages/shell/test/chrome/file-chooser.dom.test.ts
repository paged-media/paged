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

// The shell's file chooser (lib/file-chooser.ts, editor ADR 270): the
// input behind it is attached and referenced until the chooser settles.
// A detached input nothing held could be collected after `click()` and
// before the browser reported the chooser, so File ▸ Place… sometimes
// opened nothing and a picked file sometimes never arrived.

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";

import { chooseFiles, openFileChooserCount } from "../../src/lib/file-chooser";

const inputs = () =>
  Array.from(
    document.querySelectorAll<HTMLInputElement>(
      "input[data-paged-file-chooser]",
    ),
  );

/** Answer the next `click()` on a file input with `answer`. */
function answerClick(answer: (input: HTMLInputElement) => void): () => void {
  const proto = HTMLInputElement.prototype;
  const click = proto.click;
  proto.click = function (this: HTMLInputElement) {
    proto.click = click;
    answer(this);
  };
  return () => {
    proto.click = click;
  };
}

afterEach(() => {
  for (const i of inputs()) i.remove();
});

describe("chooseFiles", () => {
  test("the input is in the document, hidden, while the chooser is open, and gone once a file is chosen", async () => {
    covers("command:paged.insert.placeImage");
    covers("command:paged.file.openIdml");
    let seen: { attached: boolean; hidden: boolean; accept: string } | null =
      null;
    let open: HTMLInputElement | null = null;
    const restore = answerClick((input) => {
      seen = {
        attached: input.isConnected,
        hidden: input.hidden === true,
        accept: input.accept,
      };
      open = input;
    });
    const chosen = chooseFiles({ accept: [".png", "image/*"] });
    restore();
    // `click()` ran synchronously, inside the caller's gesture.
    expect(seen).toEqual({
      attached: true,
      hidden: true,
      accept: ".png,image/*",
    });
    expect(openFileChooserCount()).toBe(1);
    expect(inputs()).toHaveLength(1);
    expect(inputs()[0]!.getAttribute("aria-hidden")).toBe("true");

    const file = new File([new Uint8Array([1, 2, 3])], "a.png", {
      type: "image/png",
    });
    Object.defineProperty(open!, "files", { value: [file] });
    open!.dispatchEvent(new Event("change"));
    const files = await chosen;
    expect(files.map((f) => f.name)).toEqual(["a.png"]);
    expect(openFileChooserCount()).toBe(0);
    expect(inputs()).toHaveLength(0);
  });

  test("a cancelled chooser answers nothing and leaves no input behind", async () => {
    covers("command:paged.insert.placeImage");
    let open: HTMLInputElement | null = null;
    const restore = answerClick((input) => {
      open = input;
    });
    const chosen = chooseFiles();
    restore();
    open!.dispatchEvent(new Event("cancel"));
    expect(await chosen).toEqual([]);
    expect(openFileChooserCount()).toBe(0);
    expect(inputs()).toHaveLength(0);
  });

  test("two choosers open at once are each held until they settle", async () => {
    covers("command:paged.insert.placeImage");
    const opened: HTMLInputElement[] = [];
    let restore = answerClick((i) => void opened.push(i));
    const a = chooseFiles();
    restore();
    restore = answerClick((i) => void opened.push(i));
    const b = chooseFiles({ multiple: true });
    restore();
    expect(openFileChooserCount()).toBe(2);
    expect(opened[1]!.multiple).toBe(true);
    opened[0]!.dispatchEvent(new Event("cancel"));
    expect(await a).toEqual([]);
    expect(openFileChooserCount()).toBe(1);
    opened[1]!.dispatchEvent(new Event("cancel"));
    expect(await b).toEqual([]);
    expect(inputs()).toHaveLength(0);
  });
});
