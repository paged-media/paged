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

// The browser file chooser behind every "pick a file" in the editor (Place,
// Open, a plugin's `host.shell.pickFile`, swatch libraries, ICC profiles).
//
// THE INPUT IS ATTACHED while the chooser is open, and held by `pending`.
// A fresh `<input type="file">` that is never attached and that nothing
// references can be garbage-collected after `click()` and before the
// browser has reported the chooser and its answer. Then the automation
// layer, which resolves a chooser through its element, saw no chooser at
// all, and a file the user did pick never fired `change`. It happened
// intermittently, more often under load, and more often from a menu than
// from ⌘D only because closing a menu allocates more in the same moment
// (editor ADR 270). Attached, hidden and out of the tab order and the
// accessibility tree; removed once the chooser settles.

/** What the chooser offers. */
export interface FileChooserOptions {
  /** Extensions (leading dot) and/or MIME types, joined into `accept`. */
  accept?: readonly string[];
  /** Allow choosing more than one file. Default false. */
  multiple?: boolean;
}

/** The inputs of the choosers open now: a strong reference, so none is
 *  collected while its chooser is up. */
const pending = new Set<HTMLInputElement>();

/** How many choosers are open now (tests). */
export function openFileChooserCount(): number {
  return pending.size;
}

/**
 * Open the browser's file chooser. Resolves to the chosen files, or `[]`
 * when the user cancels. Call it synchronously from the user's gesture
 * (a click or a key): the browser shows a chooser only with user
 * activation.
 */
export function chooseFiles(
  options?: FileChooserOptions,
): Promise<readonly File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    if (options?.accept && options.accept.length > 0) {
      input.accept = options.accept.join(",");
    }
    if (options?.multiple) input.multiple = true;
    input.hidden = true;
    input.tabIndex = -1;
    input.setAttribute("aria-hidden", "true");
    input.setAttribute("data-paged-file-chooser", "");
    pending.add(input);
    document.body.append(input);

    let settled = false;
    const finish = (files: readonly File[]) => {
      if (settled) return;
      settled = true;
      pending.delete(input);
      input.remove();
      resolve(files);
    };
    input.onchange = () => finish(input.files ? Array.from(input.files) : []);
    // Browsers fire `cancel` when the dialog is dismissed; one that does
    // not leaves the hidden input until the next answer, which is harmless.
    input.oncancel = () => finish([]);
    input.click();
  });
}
