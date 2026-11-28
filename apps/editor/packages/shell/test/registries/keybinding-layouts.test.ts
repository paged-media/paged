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

// Keyboard layouts (the rule at "Which key a press names" in
// registries/keybinding.ts). Each row is a press as a browser reports it
// on that layout (`key`: the character typed, `code`: the physical key,
// named after the US layout), against the editor's default bindings.
//
//   · a letter follows the layout: Z and Y on a German keyboard, A and Q on
//     a French one;
//   · a digit or punctuation binding fires from its US position when the
//     typed character names no binding (Cmd+1 on the "&" key);
//   · a typed character that names a binding is that binding, whatever key
//     it sits on ("-" on the US "=" key of a French Mac keyboard zooms OUT).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { stubGlobal, unstubAllGlobals } from "@paged-media/test-kit";

import { createCommandRegistry } from "../../src/registries/command";
import {
  createKeybindingRegistry,
  createKeyboardLayout,
  resolveBinding,
  type KeyboardLayout,
  type KeybindingContribution,
  type KeyEventLike,
} from "../../src/registries/keybinding";

/** The default bindings a layout decides (the Mac chords and one PC twin
 *  of each family; the app registers `cmd+…` and `ctrl+…` for all). */
const DEFAULTS: KeybindingContribution[] = [
  { key: "cmd+=", command: "zoomIn" },
  { key: "cmd+plus", command: "zoomIn" },
  { key: "ctrl+=", command: "zoomIn" },
  { key: "ctrl+plus", command: "zoomIn" },
  { key: "cmd+-", command: "zoomOut" },
  { key: "ctrl+-", command: "zoomOut" },
  { key: "cmd+0", command: "fitPage" },
  { key: "alt+cmd+0", command: "fitSpread" },
  { key: "alt+cmd+=", command: "fitSelection" },
  { key: "cmd+1", command: "zoom100" },
  { key: "ctrl+1", command: "zoom100" },
  { key: "shift+cmd+1", command: "resetRotation" },
  { key: "cmd+]", command: "bringForward" },
  { key: "cmd+[", command: "sendBackward" },
  { key: "cmd+shift+]", command: "bringToFront" },
  { key: "cmd+shift+[", command: "sendToBack" },
  { key: "cmd+alt+]", command: "selectAbove" },
  { key: "cmd+alt+[", command: "selectBelow" },
  { key: "cmd+'", command: "showGrid" },
  { key: "shift+cmd+'", command: "snapToGrid" },
  { key: "cmd+\\", command: "toggleChrome" },
  { key: "shift+cmd+=", command: "superscript" },
  { key: "cmd+a", command: "selectAll" },
  { key: "cmd+z", command: "undo" },
  { key: "cmd+shift+z", command: "redo" },
  { key: "cmd+y", command: "outline" },
  { key: "alt+cmd+y", command: "pixelPreview" },
  { key: "cmd+m", command: "minimize" },
  { key: "cmd+alt+shift+v", command: "pasteInPlace" },
  { key: "v", command: "selectionTool" },
];

type Mods = "cmd" | "ctrl" | "alt" | "shift";
const ev = (key: string, code: string, ...mods: Mods[]): KeyEventLike => ({
  key,
  code,
  metaKey: mods.includes("cmd"),
  ctrlKey: mods.includes("ctrl"),
  altKey: mods.includes("alt"),
  shiftKey: mods.includes("shift"),
});

type Row = [what: string, event: KeyEventLike, command: string | null];

function check(rows: Row[], layout?: KeyboardLayout) {
  for (const [what, event, command] of rows) {
    const got =
      resolveBinding(DEFAULTS, event, undefined, layout)?.command ?? null;
    expect(`${what} → ${got}`).toBe(`${what} → ${command}`);
  }
}

describe("a German keyboard (QWERTZ, macOS)", () => {
  // Unmodified: ß on Minus, ´ on Equal, ü on BracketLeft, + on BracketRight,
  // ö on Semicolon, ä on Quote, # on Backslash, - on Slash; Z on KeyY and
  // Y on KeyZ; "=" is Shift+0.
  const rows: Row[] = [
    ["Cmd and the + key", ev("+", "BracketRight", "cmd"), "zoomIn"],
    ["Cmd and the - key", ev("-", "Slash", "cmd"), "zoomOut"],
    ["Cmd+0", ev("0", "Digit0", "cmd"), "fitPage"],
    ["Cmd+1", ev("1", "Digit1", "cmd"), "zoom100"],
    [
      "Shift+Cmd+1 (types !)",
      ev("!", "Digit1", "cmd", "shift"),
      "resetRotation",
    ],
    ["Cmd+ü, the US [ key", ev("ü", "BracketLeft", "cmd"), "sendBackward"],
    ["Shift+Cmd+ü", ev("Ü", "BracketLeft", "cmd", "shift"), "sendToBack"],
    [
      "Option+Cmd+ü (types •)",
      ev("•", "BracketLeft", "cmd", "alt"),
      "selectBelow",
    ],
    [
      "Option+Cmd and the + key (types ±)",
      ev("±", "BracketRight", "cmd", "alt"),
      "selectAbove",
    ],
    ["Cmd+ä, the US ' key", ev("ä", "Quote", "cmd"), "showGrid"],
    ["Shift+Cmd+ä", ev("Ä", "Quote", "cmd", "shift"), "snapToGrid"],
    ["Cmd+#, the US \\ key", ev("#", "Backslash", "cmd"), "toggleChrome"],
    ["Cmd+´, the US = key", ev("Dead", "Equal", "cmd"), "zoomIn"],
    ["Option+Cmd+´", ev("Dead", "Equal", "cmd", "alt"), "fitSelection"],
    ["Cmd+ß, the US - key", ev("ß", "Minus", "cmd"), "zoomOut"],
    // "=" is typed with Shift+0: the typed character names Shift+Cmd+=.
    ["Shift+Cmd+0 (types =)", ev("=", "Digit0", "cmd", "shift"), "superscript"],
    // Letters follow the layout, never the US position.
    ["Cmd and the key labelled Z", ev("z", "KeyY", "cmd"), "undo"],
    [
      "Shift+Cmd and the key labelled Z",
      ev("Z", "KeyY", "cmd", "shift"),
      "redo",
    ],
    ["Cmd and the key labelled Y", ev("y", "KeyZ", "cmd"), "outline"],
    ["Cmd+A", ev("a", "KeyA", "cmd"), "selectAll"],
    [
      "Option+Shift+Cmd+V (types ◊)",
      ev("◊", "KeyV", "cmd", "alt", "shift"),
      "pasteInPlace",
    ],
    ["V", ev("v", "KeyV"), "selectionTool"],
  ];

  test("the default bindings fire from the keys a German keyboard has", () => {
    check(rows);
  });

  test("with Option, a letter is the layout's once the layout is known", () => {
    // Option changes the character (Option+Y types ¥, Option+Z types Ω),
    // so the press says nothing about the letter; the layout does.
    const layout = createKeyboardLayout([
      ["KeyY", "z"],
      ["KeyZ", "y"],
    ]);
    check(
      [
        [
          "Option+Cmd and the key labelled Y",
          ev("¥", "KeyZ", "cmd", "alt"),
          "pixelPreview",
        ],
        [
          "Option+Cmd and the key labelled Z",
          ev("Ω", "KeyY", "cmd", "alt"),
          null,
        ],
      ],
      layout,
    );
    check(rows, layout);
  });

  test("the layout is learned from the presses the registry sees", () => {
    const layout = createKeyboardLayout();
    layout.learn(ev("z", "KeyY"));
    layout.learn(ev("Y", "KeyZ", "shift"));
    // A shifted symbol and an Option character say nothing of the key.
    layout.learn(ev("!", "Digit1", "shift"));
    layout.learn(ev("Ω", "KeyY", "alt"));
    expect(layout.base("KeyY")).toBe("z");
    expect(layout.base("KeyZ")).toBe("y");
    expect(layout.base("Digit1")).toBeNull();
  });
});

describe("a French keyboard (AZERTY)", () => {
  // macOS, unmodified: & é " ' ( § è ! ç à on the digit row (digits with
  // Shift), ) on Minus, - on Equal, ^ (dead) on BracketLeft, $ on
  // BracketRight, m on Semicolon, ù on Quote, = on Slash (+ with Shift);
  // A on KeyQ, Q on KeyA, Z on KeyW, W on KeyZ, "," on KeyM.
  const mac: Row[] = [
    ["Cmd and the & key, the US 1", ev("&", "Digit1", "cmd"), "zoom100"],
    ["Cmd and the à key, the US 0", ev("à", "Digit0", "cmd"), "fitPage"],
    [
      "Option+Cmd and the à key (types ø)",
      ev("ø", "Digit0", "cmd", "alt"),
      "fitSpread",
    ],
    [
      "Shift+Cmd+1 (types 1)",
      ev("1", "Digit1", "cmd", "shift"),
      "resetRotation",
    ],
    // The typed character decides: "-" sits on the US "=" key.
    ["Cmd and the - key", ev("-", "Equal", "cmd"), "zoomOut"],
    ["Cmd and the = key", ev("=", "Slash", "cmd"), "zoomIn"],
    [
      "Shift+Cmd and the = key (types +)",
      ev("+", "Slash", "cmd", "shift"),
      "zoomIn",
    ],
    ["Cmd+), the US - key", ev(")", "Minus", "cmd"), "zoomOut"],
    ["Cmd+$, the US ] key", ev("$", "BracketRight", "cmd"), "bringForward"],
    ["Cmd+^, the US [ key", ev("Dead", "BracketLeft", "cmd"), "sendBackward"],
    [
      "Shift+Cmd+$ (types *)",
      ev("*", "BracketRight", "cmd", "shift"),
      "bringToFront",
    ],
    ["Cmd+ù, the US ' key", ev("ù", "Quote", "cmd"), "showGrid"],
    ["Shift+Cmd+ù (types %)", ev("%", "Quote", "cmd", "shift"), "snapToGrid"],
    // Letters follow the layout.
    ["Cmd and the key labelled A", ev("a", "KeyQ", "cmd"), "selectAll"],
    ["Cmd and the key labelled Q", ev("q", "KeyA", "cmd"), null],
    ["Cmd and the key labelled Z", ev("z", "KeyW", "cmd"), "undo"],
    ["Cmd and the key labelled W", ev("w", "KeyZ", "cmd"), null],
    ["Cmd and the key labelled M", ev("m", "Semicolon", "cmd"), "minimize"],
    // "," sits on the US M key: it is a comma, not Cmd+M.
    ["Cmd and the , key", ev(",", "KeyM", "cmd"), null],
  ];
  // Windows, where it differs: - on Digit6, = on Equal (+ with Shift).
  const windows: Row[] = [
    ["Ctrl and the - key, the US 6", ev("-", "Digit6", "ctrl"), "zoomOut"],
    ["Ctrl and the = key", ev("=", "Equal", "ctrl"), "zoomIn"],
    ["Ctrl and the & key, the US 1", ev("&", "Digit1", "ctrl"), "zoom100"],
    ["Ctrl+), the US - key", ev(")", "Minus", "ctrl"), "zoomOut"],
  ];

  test("the default bindings fire from the keys a French keyboard has", () => {
    check(mac);
    check(windows);
  });

  test("with Option, a letter is the layout's once the layout is known", () => {
    const layout = createKeyboardLayout([
      ["KeyQ", "a"],
      ["KeyA", "q"],
      ["KeyW", "z"],
      ["KeyZ", "w"],
      ["KeyM", ","],
      ["Semicolon", "m"],
    ]);
    const bindings: KeybindingContribution[] = [
      { key: "cmd+alt+a", command: "a" },
      { key: "cmd+alt+q", command: "q" },
      { key: "cmd+alt+m", command: "m" },
    ];
    const fires = (e: KeyEventLike) =>
      resolveBinding(bindings, e, undefined, layout)?.command ?? null;
    expect(fires(ev("æ", "KeyQ", "cmd", "alt"))).toBe("a");
    expect(fires(ev("‡", "KeyA", "cmd", "alt"))).toBe("q");
    expect(fires(ev("µ", "Semicolon", "cmd", "alt"))).toBe("m");
    // The comma key is not M.
    expect(fires(ev("∞", "KeyM", "cmd", "alt"))).toBeNull();
    check(mac, layout);
  });
});

describe("other layouts", () => {
  test("a US keyboard: Shift+Cmd+= is its own binding, and the plus key's when there is none", () => {
    check([
      ["Cmd+=", ev("=", "Equal", "cmd"), "zoomIn"],
      [
        "Shift+Cmd+= (types +)",
        ev("+", "Equal", "cmd", "shift"),
        "superscript",
      ],
      ["Cmd+[", ev("[", "BracketLeft", "cmd"), "sendBackward"],
      [
        "Shift+Cmd+[ (types {)",
        ev("{", "BracketLeft", "cmd", "shift"),
        "sendToBack",
      ],
      [
        "Option+Cmd+= (types ≠)",
        ev("≠", "Equal", "cmd", "alt"),
        "fitSelection",
      ],
      ["Cmd and the numeric keypad's +", ev("+", "NumpadAdd", "cmd"), "zoomIn"],
    ]);
    const withoutSuperscript = DEFAULTS.filter(
      (b) => b.command !== "superscript",
    );
    expect(
      resolveBinding(withoutSuperscript, ev("+", "Equal", "cmd", "shift"))
        ?.command,
    ).toBe("zoomIn");
  });

  test("a layout without Latin letters fires a letter binding from its US position", () => {
    check([
      ["Cmd+я (Russian, the US Z key)", ev("я", "KeyZ", "cmd"), "undo"],
      ["Cmd+ф (the US A key)", ev("ф", "KeyA", "cmd"), "selectAll"],
      ["м (the US V key)", ev("м", "KeyV"), "selectionTool"],
    ]);
  });

  test("a disabled binding on the typed character does not hand the press to another key's binding", () => {
    const bindings: KeybindingContribution[] = [
      { key: "cmd+-", command: "zoomOut", when: () => false },
      { key: "cmd+=", command: "zoomIn" },
    ];
    // French macOS: "-" on the US "=" key.
    expect(resolveBinding(bindings, ev("-", "Equal", "cmd"))).toBeNull();
  });
});

describe("the plus key in a combo", () => {
  let registry: ReturnType<typeof createKeybindingRegistry>;
  beforeEach(() => {
    stubGlobal("window", new EventTarget());
    registry = createKeybindingRegistry(createCommandRegistry(() => null));
  });
  afterEach(() => {
    registry.dispose();
    unstubAllGlobals();
  });

  test("`cmd+plus`, `cmd++` and a bare `+` name it", () => {
    registry.register({ key: "cmd+plus", command: "a" });
    registry.register({ key: "ctrl++", command: "b" });
    registry.register({ key: "+", command: "c" });
    expect(registry.resolve(ev("+", "BracketRight", "cmd"))?.command).toBe("a");
    expect(registry.resolve(ev("+", "BracketRight", "ctrl"))?.command).toBe(
      "b",
    );
    expect(registry.resolve(ev("+", "BracketRight"))?.command).toBe("c");
    // On a US keyboard the plus is Shift+=.
    expect(registry.resolve(ev("+", "Equal", "shift"))?.command).toBe("c");
    expect(() => registry.register({ key: "cmd+", command: "x" })).toThrow();
  });
});
