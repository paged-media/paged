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

// Keybinding → command, in the running editor, registry-driven:
//
//   · INVENTORY — the host bindings registered are exactly this list;
//   · DISPATCH — each binding, pressed on the page, runs its command
//     (recorded); a real key press wherever the US layout reports the
//     registered key, a synthetic keydown for the shifted-bracket combos
//     the layout reports as `{` / `}` (their twins are pressed for real);
//   · QUIET — the guarded keys stay text while a caret is in a story,
//     and a focused field keeps its keys;
//   · the tool-shortcut family, member by member from the live registry:
//     each arms its tool where it applies (at the document root, or
//     inside the edit context that claims it).

import { expect, test, type Page } from "@playwright/test";

import { covers } from "@paged-media/test-kit";

import {
  SHELL,
  activeEditContext,
  blurAll,
  engageCanvas,
  enterVectorGraphic,
  isPluginCommand,
  liveKeybindings,
  openShell,
  recordCommands,
  select,
  setCaret,
} from "./harness/shell-surface";

const HOST_KEYS = [
  "x→paged.fillStroke.swap",
  "d→paged.fillStroke.default",
  "j→paged.fillStroke.toggleAffects",
  "cmd+=→paged.view.zoomIn",
  "ctrl+=→paged.view.zoomIn",
  "cmd+-→paged.view.zoomOut",
  "ctrl+-→paged.view.zoomOut",
  "cmd+s→paged.file.savePaged",
  "ctrl+s→paged.file.savePaged",
  "cmd+shift+s→paged.file.saveAsIdml",
  "ctrl+shift+s→paged.file.saveAsIdml",
  "cmd+a→paged.edit.selectAll",
  "ctrl+a→paged.edit.selectAll",
  "cmd+shift+]→paged.object.bringToFront",
  "ctrl+shift+]→paged.object.bringToFront",
  "cmd+shift+}→paged.object.bringToFront",
  "ctrl+shift+}→paged.object.bringToFront",
  "cmd+]→paged.object.bringForward",
  "ctrl+]→paged.object.bringForward",
  "cmd+[→paged.object.sendBackward",
  "ctrl+[→paged.object.sendBackward",
  "cmd+shift+[→paged.object.sendToBack",
  "ctrl+shift+[→paged.object.sendToBack",
  "cmd+shift+{→paged.object.sendToBack",
  "ctrl+shift+{→paged.object.sendToBack",
  "cmd+g→paged.object.group",
  "ctrl+g→paged.object.group",
  "cmd+shift+g→paged.object.ungroup",
  "ctrl+shift+g→paged.object.ungroup",
  "backspace→paged.object.delete",
  "delete→paged.object.delete",
  "arrowleft→paged.object.nudgeLeft",
  "arrowright→paged.object.nudgeRight",
  "arrowup→paged.object.nudgeUp",
  "arrowdown→paged.object.nudgeDown",
  "shift+arrowleft→paged.object.nudgeLeftLarge",
  "shift+arrowright→paged.object.nudgeRightLarge",
  "shift+arrowup→paged.object.nudgeUpLarge",
  "shift+arrowdown→paged.object.nudgeDownLarge",
  "cmd+d→paged.insert.placeImage",
  "ctrl+d→paged.insert.placeImage",
  // Find & Replace (editor ADR 303).
  "cmd+f→paged.edit.find",
  "ctrl+f→paged.edit.find",
  "cmd+alt+f→paged.edit.replace",
  "ctrl+h→paged.edit.replace",
  "cmd+j→paged.edit.goTo",
  "tab→paged.chrome.toggleAll",
  "shift+tab→paged.chrome.togglePanels",
  "cmd+\\→paged.chrome.toggleAll",
  "ctrl+\\→paged.chrome.toggleAll",
  "w→paged.view.toggleScreenPreview",
  "cmd+k→paged.palette.toggle",
  "ctrl+k→paged.palette.toggle",
  "cmd+0→paged.view.fitPage",
  "ctrl+0→paged.view.fitPage",
  "alt+cmd+0→paged.view.fitSpread",
  "alt+ctrl+0→paged.view.fitSpread",
  "alt+cmd+=→paged.view.fitSelection",
  "alt+ctrl+=→paged.view.fitSelection",
  "alt+shift+cmd+0→paged.view.zoomFit",
  "alt+shift+ctrl+0→paged.view.zoomFit",
  "home→paged.view.firstPage",
  "pageup→paged.view.previousPage",
  "pagedown→paged.view.nextPage",
  "end→paged.view.lastPage",
  "cmd+1→paged.view.zoom100",
  "ctrl+1→paged.view.zoom100",
  "cmd+c→paged.edit.copy",
  "ctrl+c→paged.edit.copy",
  "cmd+x→paged.edit.cut",
  "ctrl+x→paged.edit.cut",
  "cmd+v→paged.edit.paste",
  "ctrl+v→paged.edit.paste",
  "cmd+alt+shift+v→paged.edit.pasteInPlace",
  "ctrl+alt+shift+v→paged.edit.pasteInPlace",
  "cmd+alt+shift+d→paged.edit.duplicate",
  "ctrl+alt+shift+d→paged.edit.duplicate",
  "cmd+l→paged.object.lock",
  "ctrl+l→paged.object.lock",
  "shift+f10→paged.edit.contextMenu",
  "contextmenu→paged.edit.contextMenu",
] as const;

const split = (sig: string) => {
  const [key, command] = sig.split("→");
  return { key, command };
};

const hostSignatures = async (page: Page) =>
  (await liveKeybindings(page))
    .filter(
      (k) =>
        // A scoped binding is a plugin's (editor ADR 299), even when it
        // names a host command (paged.doc's Word keys for Find, ADR 303).
        !k.scoped &&
        !isPluginCommand(k.command) &&
        !k.command.startsWith("paged.tool.activate."),
    )
    .map((k) => `${k.key}→${k.command}`);

/** Playwright's name for a registered key, or null when the US layout
 *  cannot report it with these modifiers (Shift+] reports `}`). */
function pressable(combo: string): string | null {
  const parts = combo.split("+");
  const key = parts.pop()!;
  const shift = parts.includes("shift");
  if (shift && ["[", "]", "=", "-", "\\"].includes(key)) return null;
  const MODS: Record<string, string> = {
    cmd: "Meta",
    ctrl: "Control",
    alt: "Alt",
    shift: "Shift",
  };
  const NAMED: Record<string, string> = {
    "=": "Equal",
    "-": "Minus",
    "[": "BracketLeft",
    "]": "BracketRight",
    "{": "BracketLeft",
    "}": "BracketRight",
    "\\": "Backslash",
    arrowleft: "ArrowLeft",
    arrowright: "ArrowRight",
    arrowup: "ArrowUp",
    arrowdown: "ArrowDown",
    backspace: "Backspace",
    delete: "Delete",
    tab: "Tab",
    home: "Home",
    end: "End",
    pageup: "PageUp",
    pagedown: "PageDown",
    f10: "F10",
    contextmenu: "ContextMenu",
  };
  // `{` / `}` are Shift+bracket on the US layout.
  const name =
    NAMED[key] ?? (/^[a-z]$/.test(key) ? `Key${key.toUpperCase()}` : key);
  return [...parts.map((m) => MODS[m] ?? m), name].join("+");
}

/** Press a registered combo: for real when the layout can, else a
 *  keydown carrying exactly the registered key on the page's body. */
async function pressCombo(page: Page, combo: string): Promise<void> {
  const real = pressable(combo);
  if (real) {
    await page.keyboard.press(real);
    return;
  }
  await page.evaluate((c) => {
    const parts = c.split("+");
    const key = parts.pop()!;
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        metaKey: parts.includes("cmd"),
        ctrlKey: parts.includes("ctrl"),
        altKey: parts.includes("alt"),
        shiftKey: parts.includes("shift"),
        bubbles: true,
        cancelable: true,
      }),
    );
  }, combo);
}

test.describe("host keybindings", () => {
  test("inventory: the host bindings registered are exactly this spec's list", async ({
    page,
  }) => {
    await openShell(page, { doc: true });
    expect((await hostSignatures(page)).sort()).toEqual([...HOST_KEYS].sort());
  });

  test("each binding, pressed on the page, runs its command", async ({
    page,
  }) => {
    covers(
      "keybinding:x→paged.fillStroke.swap",
      "keybinding:d→paged.fillStroke.default",
      "keybinding:j→paged.fillStroke.toggleAffects",
      "keybinding:cmd+=→paged.view.zoomIn",
      "keybinding:ctrl+=→paged.view.zoomIn",
      "keybinding:cmd+-→paged.view.zoomOut",
      "keybinding:ctrl+-→paged.view.zoomOut",
      "keybinding:cmd+s→paged.file.savePaged",
      "keybinding:ctrl+s→paged.file.savePaged",
      "keybinding:cmd+shift+s→paged.file.saveAsIdml",
      "keybinding:ctrl+shift+s→paged.file.saveAsIdml",
      "keybinding:cmd+a→paged.edit.selectAll",
      "keybinding:ctrl+a→paged.edit.selectAll",
      "keybinding:cmd+shift+]→paged.object.bringToFront",
      "keybinding:ctrl+shift+]→paged.object.bringToFront",
      "keybinding:cmd+shift+}→paged.object.bringToFront",
      "keybinding:ctrl+shift+}→paged.object.bringToFront",
      "keybinding:cmd+]→paged.object.bringForward",
      "keybinding:ctrl+]→paged.object.bringForward",
      "keybinding:cmd+[→paged.object.sendBackward",
      "keybinding:ctrl+[→paged.object.sendBackward",
      "keybinding:cmd+shift+[→paged.object.sendToBack",
      "keybinding:ctrl+shift+[→paged.object.sendToBack",
      "keybinding:cmd+shift+{→paged.object.sendToBack",
      "keybinding:ctrl+shift+{→paged.object.sendToBack",
      "keybinding:cmd+g→paged.object.group",
      "keybinding:ctrl+g→paged.object.group",
      "keybinding:cmd+shift+g→paged.object.ungroup",
      "keybinding:ctrl+shift+g→paged.object.ungroup",
      "keybinding:backspace→paged.object.delete",
      "keybinding:delete→paged.object.delete",
      "keybinding:arrowleft→paged.object.nudgeLeft",
      "keybinding:arrowright→paged.object.nudgeRight",
      "keybinding:arrowup→paged.object.nudgeUp",
      "keybinding:arrowdown→paged.object.nudgeDown",
      "keybinding:shift+arrowleft→paged.object.nudgeLeftLarge",
      "keybinding:shift+arrowright→paged.object.nudgeRightLarge",
      "keybinding:shift+arrowup→paged.object.nudgeUpLarge",
      "keybinding:shift+arrowdown→paged.object.nudgeDownLarge",
      "keybinding:cmd+d→paged.insert.placeImage",
      "keybinding:ctrl+d→paged.insert.placeImage",
      "keybinding:tab→paged.chrome.toggleAll",
      "keybinding:shift+tab→paged.chrome.togglePanels",
      "keybinding:cmd+\\→paged.chrome.toggleAll",
      "keybinding:ctrl+\\→paged.chrome.toggleAll",
      "keybinding:w→paged.view.toggleScreenPreview",
      "keybinding:cmd+k→paged.palette.toggle",
      "keybinding:ctrl+k→paged.palette.toggle",
      "keybinding:cmd+0→paged.view.fitPage",
      "keybinding:ctrl+0→paged.view.fitPage",
      "keybinding:alt+cmd+0→paged.view.fitSpread",
      "keybinding:alt+ctrl+0→paged.view.fitSpread",
      "keybinding:alt+cmd+=→paged.view.fitSelection",
      "keybinding:alt+ctrl+=→paged.view.fitSelection",
      "keybinding:alt+shift+cmd+0→paged.view.zoomFit",
      "keybinding:alt+shift+ctrl+0→paged.view.zoomFit",
      "keybinding:home→paged.view.firstPage",
      "keybinding:pageup→paged.view.previousPage",
      "keybinding:pagedown→paged.view.nextPage",
      "keybinding:end→paged.view.lastPage",
      "keybinding:cmd+1→paged.view.zoom100",
      "keybinding:ctrl+1→paged.view.zoom100",
      "keybinding:cmd+c→paged.edit.copy",
      "keybinding:ctrl+c→paged.edit.copy",
      "keybinding:cmd+x→paged.edit.cut",
      "keybinding:ctrl+x→paged.edit.cut",
      "keybinding:cmd+v→paged.edit.paste",
      "keybinding:ctrl+v→paged.edit.paste",
      "keybinding:cmd+alt+shift+v→paged.edit.pasteInPlace",
      "keybinding:ctrl+alt+shift+v→paged.edit.pasteInPlace",
      "keybinding:cmd+alt+shift+d→paged.edit.duplicate",
      "keybinding:ctrl+alt+shift+d→paged.edit.duplicate",
      "keybinding:cmd+l→paged.object.lock",
      "keybinding:ctrl+l→paged.object.lock",
      "keybinding:shift+f10→paged.edit.contextMenu",
      "keybinding:contextmenu→paged.edit.contextMenu",
    );
    await openShell(page, { doc: true });
    // One context every binding applies in: a document, a frame selected,
    // no caret, the page focused.
    await select(page, [SHELL.frame]);
    await blurAll(page);
    const recorder = await recordCommands(page, [
      ...new Set(HOST_KEYS.map((s) => split(s).command)),
    ]);
    const wrong: string[] = [];
    for (const sig of HOST_KEYS) {
      const { key, command } = split(sig);
      // Tab is the chrome toggle on the canvas the user clicked into.
      if (key === "tab" || key === "shift+tab") await engageCanvas(page);
      await pressCombo(page, key);
      const got = await expect
        .poll(() => recorder.take().then((c) => c.join(",")), {
          timeout: 5_000,
        })
        .toBe(command)
        .then(
          () => null,
          (e: Error) => e.message.split("\n")[0],
        );
      if (got) wrong.push(`${sig}: ${got}`);
    }
    await recorder.restore();
    expect(wrong).toEqual([]);
  });

  test("with a caret in a story, the single keys, Delete and the arrows are the text's", async ({
    page,
  }) => {
    covers(
      "keybinding:x→paged.fillStroke.swap",
      "keybinding:d→paged.fillStroke.default",
      "keybinding:j→paged.fillStroke.toggleAffects",
      "keybinding:w→paged.view.toggleScreenPreview",
      "keybinding:backspace→paged.object.delete",
      "keybinding:delete→paged.object.delete",
      "keybinding:arrowleft→paged.object.nudgeLeft",
      "keybinding:shift+arrowright→paged.object.nudgeRightLarge",
      "keybinding:tab→paged.chrome.toggleAll",
      "keybinding:cmd+a→paged.edit.selectAll",
    );
    await openShell(page, { doc: true });
    await select(page, [SHELL.text]);
    await setCaret(page, 3);
    await blurAll(page);
    const quiet = [
      "x→paged.fillStroke.swap",
      "d→paged.fillStroke.default",
      "j→paged.fillStroke.toggleAffects",
      "w→paged.view.toggleScreenPreview",
      "backspace→paged.object.delete",
      "delete→paged.object.delete",
      "arrowleft→paged.object.nudgeLeft",
      "shift+arrowright→paged.object.nudgeRightLarge",
      "tab→paged.chrome.toggleAll",
    ];
    const recorder = await recordCommands(page, [
      ...new Set(quiet.map((s) => split(s).command)),
    ]);
    for (const sig of quiet) await pressCombo(page, split(sig).key);
    expect(await recorder.take()).toEqual([]);
    await recorder.restore();
  });

  test("a focused field keeps its keys; Cmd+K still opens the palette from it", async ({
    page,
  }) => {
    covers(
      "keybinding:x→paged.fillStroke.swap",
      "keybinding:backspace→paged.object.delete",
      "keybinding:arrowleft→paged.object.nudgeLeft",
      "keybinding:cmd+a→paged.edit.selectAll",
      "keybinding:cmd+k→paged.palette.toggle",
    );
    await openShell(page, { doc: true });
    await select(page, [SHELL.frame]);
    // A field of the page's own chrome: a scratch input in the document.
    await page.evaluate(() => {
      const input = document.createElement("input");
      input.type = "text";
      input.id = "shell-test-field";
      document.body.appendChild(input);
      input.focus();
    });
    const recorder = await recordCommands(page, [
      "paged.fillStroke.swap",
      "paged.object.delete",
      "paged.object.nudgeLeft",
      "paged.edit.selectAll",
      "paged.palette.toggle",
    ]);
    for (const key of ["KeyX", "Backspace", "ArrowLeft", "Meta+KeyA"])
      await page.keyboard.press(key);
    expect(await recorder.take()).toEqual([]);
    await page.keyboard.press("Meta+KeyK");
    await expect
      .poll(() => recorder.take().then((c) => c.join(",")))
      .toBe("paged.palette.toggle");
    await recorder.restore();
  });
});

test.describe("the tool-shortcut family", () => {
  test("every live tool shortcut arms its tool where it applies", async ({
    page,
  }) => {
    covers("keybinding:*→paged.tool.activate.*");
    await openShell(page, { doc: true });
    await select(page, []);
    await blurAll(page);
    const members = await page.evaluate(() => {
      const r = (
        globalThis as unknown as {
          __canvas: {
            registries: {
              keybindings: { list(): Array<{ key: string; command: string }> };
              editContexts: {
                list(): Array<{ type: string; toolIds?: string[] }>;
              };
            };
          };
        }
      ).__canvas.registries;
      const contexts = r.editContexts.list();
      return r.keybindings
        .list()
        .filter((k) => k.command.startsWith("paged.tool.activate."))
        .map((k) => {
          const tool = k.command.slice("paged.tool.activate.".length);
          return {
            key: k.key,
            command: k.command,
            tool,
            claimedBy: contexts
              .filter((c) => c.toolIds?.includes(tool))
              .map((c) => ({ type: c.type, toolIds: c.toolIds ?? [] })),
          };
        });
    });
    // Host and bundle tools: a floor, so an empty registry cannot pass.
    expect(members.length).toBeGreaterThan(40);

    // 1. Resolution, every member: the registry's own dispatch rule, with
    //    no caret, at the document root for an unclaimed tool and inside
    //    each claiming context for a frame tool.
    const unresolved = await page.evaluate((list) => {
      const r = (
        globalThis as unknown as {
          __canvas: {
            registries: {
              keybindings: {
                resolve(
                  e: unknown,
                  state?: unknown,
                ): { command: string } | null;
              };
            };
          };
        }
      ).__canvas.registries;
      const event = (combo: string) => {
        const parts = combo.toLowerCase().split("+");
        const key = parts.pop()!;
        return {
          key,
          metaKey: parts.includes("cmd"),
          ctrlKey: parts.includes("ctrl"),
          altKey: parts.includes("alt"),
          shiftKey: parts.includes("shift"),
        };
      };
      const out: string[] = [];
      for (const m of list) {
        const states = m.claimedBy.length
          ? m.claimedBy.map((c) => ({
              contentSelection: { contentSelection: null },
              editContext: c,
            }))
          : [
              {
                contentSelection: { contentSelection: null },
                editContext: null,
              },
            ];
        for (const state of states) {
          const won = r.keybindings.resolve(event(m.key), state);
          if (won?.command !== m.command)
            out.push(
              `${m.key}→${m.command} in ${state.editContext?.type ?? "root"}: ${won?.command ?? "nothing"}`,
            );
        }
        // A caret silences every tool shortcut.
        const typing = r.keybindings.resolve(event(m.key), {
          contentSelection: { contentSelection: { offset: 0 } },
          editContext: m.claimedBy[0] ?? null,
        });
        if (typing?.command === m.command)
          out.push(`${m.key}→${m.command} fires with a caret`);
      }
      return out;
    }, members);
    expect(unresolved).toEqual([]);

    // 2. The real key, every member that applies at the document root:
    //    the rail's tool changes.
    const baseTool = () =>
      page.evaluate(
        () =>
          (
            globalThis as unknown as {
              __canvas: {
                debugContext(): { tools: { base: string | null } } | null;
              };
            }
          ).__canvas.debugContext()?.tools.base ?? null,
      );
    const atRoot = members.filter((m) => m.claimedBy.length === 0);
    const misses: string[] = [];
    for (const m of atRoot) {
      await pressCombo(page, m.key);
      const ok = await expect
        .poll(baseTool, { timeout: 5_000 })
        .toBe(m.tool)
        .then(
          () => true,
          () => false,
        );
      if (!ok) misses.push(`${m.key}→${m.tool}: base ${await baseTool()}`);
    }
    expect(misses).toEqual([]);

    // 3. The real key inside a frame: the vectorGraphic context's tools.
    await enterVectorGraphic(page);
    const inVector = members.filter((m) =>
      m.claimedBy.some((c) => c.type === "vectorGraphic"),
    );
    expect(inVector.length).toBeGreaterThan(0);
    for (const m of inVector) {
      await pressCombo(page, m.key);
      const ok = await expect
        .poll(baseTool, { timeout: 5_000 })
        .toBe(m.tool)
        .then(
          () => true,
          () => false,
        );
      if (!ok) misses.push(`${m.key}→${m.tool} in vectorGraphic`);
    }
    expect(misses).toEqual([]);
    expect(await activeEditContext(page)).toBe("vectorGraphic");
  });
});
