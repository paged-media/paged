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

// The structure options panels of object-options-panels.tsx: Text
// Variables, Condition Options, Master Options, Text Fields, Numbering &
// Section Options and Guides. Each is a picker over the document's
// objects of one kind and schema-driven fields on the picked address;
// some carry typed core-command buttons (New…, Delete, Rename…). Each
// control: the exact message sent, the model reading it back, the panel
// showing it. (Swatch, gradient, colour group and numbering list options
// from the same file: object-options-colour.dom.test.tsx.)

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";
import type { ComponentType } from "react";

import { CoreCommandDialog } from "../../src/core-command-dialog";
import {
  ConditionOptionsPanel,
  FieldOptionsPanel,
  GuidesPanel,
  MasterOptionsPanel,
  SectionOptionsPanel,
  TextVariablesPanel,
} from "../../src/panels/object-options-panels";
import { richScene, type RichScene } from "./fixtures";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";
import { conditionsIdml, fieldScene } from "./support/options";

afterEach(unmountAll);

const set = (address: string, path: string, value: unknown) => ({
  op: "set",
  args: { address, path, value },
});

/** A panel with the typed-command form the app mounts beside the dock
 *  (main.tsx), so New… and Rename… open where a user would see them. */
const withDialog = (Panel: ComponentType) =>
  function PanelAndDialog() {
    return (
      <>
        <Panel />
        <CoreCommandDialog />
      </>
    );
  };

/** The value a field shows: a switch's state, its input's text or its
 *  select's value. */
function shown(h: PanelHarness<unknown>, path: string): string | null {
  const f = h.field(path);
  const sw = f.querySelector('[role="switch"]');
  if (sw) return sw.getAttribute("aria-checked");
  const input = f.querySelector("input");
  if (input) return input.value;
  const select = f.querySelector("select");
  return select ? select.value : null;
}

const picker = (h: PanelHarness<unknown>, kind: string) =>
  h.root.querySelector<HTMLSelectElement>(`[data-options-picker="${kind}"]`);

const pickerLabels = (h: PanelHarness<unknown>, kind: string) =>
  [...(picker(h, kind)?.options ?? [])].map((o) => o.textContent ?? "");

const empty = (h: PanelHarness<unknown>) =>
  h.root.querySelector("[data-options-empty]")?.textContent ?? null;

const action = (h: PanelHarness<unknown>, id: string) =>
  h.root.querySelector<HTMLButtonElement>(`[data-cockpit-action="${id}"]`)!;

/** The open typed-command form, once its command's schema has loaded. */
async function dialog(h: PanelHarness<unknown>, op: string) {
  await h.settle();
  const el = h.root.ownerDocument.querySelector<HTMLElement>(
    `[data-core-command-dialog="${op}"]`,
  );
  if (!el) throw new Error(`no ${op} form open`);
  expect(el.getAttribute("data-ready")).toBe("true");
  return el;
}

const arg = (form: HTMLElement, name: string) =>
  form.querySelector<HTMLInputElement>(`[data-core-command-arg="${name}"]`)!;

// ------------------------------------------------------- text variables

describe("Text Variables (paged.text-variables)", () => {
  const mount = () =>
    mountPanel<RichScene>(withDialog(TextVariablesPanel), {
      id: "paged.text-variables",
      scene: richScene,
    });
  const tv = "textVariable:dTextVariablenClient";

  test("a document without variables: says so; New… offered, Delete not", async () => {
    covers("panel:paged.text-variables");
    const h = await mountPanel(TextVariablesPanel, {
      id: "paged.text-variables",
      document: "blank",
    });
    expect(empty(h)).toContain("No text variables");
    expect(action(h, "text-variable-new").disabled).toBe(false);
    expect(action(h, "text-variable-delete").disabled).toBe(true);
    expect(h.hasField("textVariableName")).toBe(false);
  });

  test("the document's variable, picked: its definition read from the model", async () => {
    covers("panel:paged.text-variables");
    const h = await mount();
    expect(picker(h, "textVariable")!.value).toBe(tv);
    expect(shown(h, "textVariableName")).toBe("Client");
    expect(shown(h, "textVariableType")).toBe("CustomTextType");
    expect(shown(h, "textVariableContents")).toBe("ACME");
    expect(action(h, "text-variable-delete").disabled).toBe(false);
  });

  test("Text: typing Globex sets the variable's contents", async () => {
    covers("panel:paged.text-variables");
    const h = await mount();
    const from = h.mark();
    await h.typeInto("textVariableContents", "Globex");
    expect(h.mutations(from)).toEqual([
      set(tv, "textVariableContents", { type: "text", value: "Globex" }),
    ] as never);
    expect(await h.get(tv, "textVariableContents")).toEqual({
      type: "text",
      value: "Globex",
    });
    expect(shown(h, "textVariableContents")).toBe("Globex");
  });

  test("Text before / after: each is its own write", async () => {
    covers("panel:paged.text-variables");
    const h = await mount();
    let from = h.mark();
    await h.typeInto("textVariableTextBefore", "<");
    expect(h.mutations(from)).toEqual([
      set(tv, "textVariableTextBefore", { type: "text", value: "<" }),
    ] as never);
    from = h.mark();
    await h.typeInto("textVariableTextAfter", ">");
    expect(h.mutations(from)).toEqual([
      set(tv, "textVariableTextAfter", { type: "text", value: ">" }),
    ] as never);
    expect(await h.get(tv, "textVariableTextAfter")).toEqual({
      type: "text",
      value: ">",
    });
  });

  test("Delete removes the picked variable; the panel says there are none", async () => {
    covers(
      "panel:paged.text-variables",
      "command:paged.core.deleteTextVariable",
    );
    const h = await mount();
    const from = h.mark();
    await h.click(action(h, "text-variable-delete"));
    const ops = h.mutations(from).map((m) => (m as { op: string }).op);
    expect(ops).toEqual(["deleteTextVariable"]);
    expect(empty(h)).toContain("No text variables");
    expect(
      action(h, "text-variable-delete").getAttribute("data-command-error"),
    ).toBe(null);
  });

  test("New… opens the typed form prefilled; running it creates the variable", async () => {
    covers(
      "panel:paged.text-variables",
      "command:paged.core.createTextVariable",
    );
    const h = await mount();
    await h.click(action(h, "text-variable-new"));
    const form = await dialog(h, "createTextVariable");
    expect(arg(form, "name").value).toBe("New variable");
    const from = h.mark();
    await h.click(form.querySelector("[data-core-command-run]")!);
    const sent = h.mutations(from) as unknown as Array<{
      op: string;
      args: { name: string };
    }>;
    expect(sent.map((m) => m.op)).toEqual(["createTextVariable"]);
    expect(sent[0].args.name).toBe("New variable");
    expect(pickerLabels(h, "textVariable")).toHaveLength(2);
  });

  // UX audit F-22: internal identifiers shown to users. The picker asks
  // each address for `name`; a text variable's name path is
  // `textVariableName`, so it falls back to the id.
  test.failing(
    "PN-205 (UX F-22): the variable picker names it Client, not by its id",
    async () => {
      covers("panel:paged.text-variables");
      const h = await mount();
      expect(pickerLabels(h, "textVariable")).toEqual(["Client"]);
    },
  );
});

// ------------------------------------------------------ condition options

describe("Condition Options (paged.condition-options)", () => {
  const mount = () =>
    mountPanel(ConditionOptionsPanel, {
      id: "paged.condition-options",
      document: conditionsIdml(),
    });

  test("a document without conditions: says so, no fields", async () => {
    covers("panel:paged.condition-options");
    const h = await mountPanel(ConditionOptionsPanel, {
      id: "paged.condition-options",
      document: "blank",
    });
    expect(empty(h)).toBe("This document has no conditions.");
    expect(h.hasField("visible")).toBe(false);
  });

  test("both conditions listed; the first's visibility read from the model", async () => {
    covers("panel:paged.condition-options");
    const h = await mount();
    expect([...picker(h, "condition")!.options].map((o) => o.value)).toEqual([
      "condition:Condition/Draft",
      "condition:Condition/Print",
    ]);
    expect(shown(h, "visible")).toBe("true");
    await h.choose(picker(h, "condition")!, "condition:Condition/Print");
    expect(shown(h, "visible")).toBe("false");
  });

  test("Visible: the switch hides the condition", async () => {
    covers("panel:paged.condition-options");
    const h = await mount();
    const from = h.mark();
    await h.click(h.field("visible").querySelector('[role="switch"]')!);
    expect(h.mutations(from)).toEqual([
      set("condition:Condition/Draft", "visible", {
        type: "bool",
        value: false,
      }),
    ] as never);
    const conditions = (await h.client.collection("conditions")) as Array<{
      selfId: string;
      visible: boolean;
    }>;
    expect(
      conditions.find((c) => c.selfId === "Condition/Draft")!.visible,
    ).toBe(false);
    expect(shown(h, "visible")).toBe("false");
  });

  test.failing(
    "PN-206 (UX F-22): the condition picker names them Draft and Print-only",
    async () => {
      covers("panel:paged.condition-options");
      const h = await mount();
      expect(pickerLabels(h, "condition")).toEqual(["Draft", "Print-only"]);
    },
  );
});

// --------------------------------------------------------- master options

describe("Master Options (paged.master-options)", () => {
  const mount = () =>
    mountPanel<RichScene>(withDialog(MasterOptionsPanel), {
      id: "paged.master-options",
      scene: richScene,
    });

  test("the document's master, by name; Rename… and Delete offered", async () => {
    covers("panel:paged.master-options");
    const h = await mount();
    expect(pickerLabels(h, "master")).toEqual(["A"]);
    expect(shown(h, "name")).toBe("A");
    expect(action(h, "master-rename").disabled).toBe(false);
    expect(action(h, "master-delete").disabled).toBe(false);
  });

  test("Name: typing Body renames the master", async () => {
    covers("panel:paged.master-options");
    const h = await mount();
    const from = h.mark();
    await h.typeInto("name", "Body");
    expect(h.mutations(from)).toEqual([
      set("master:um", "name", { type: "text", value: "Body" }),
    ] as never);
    expect(await h.get("master:um", "name")).toEqual({
      type: "text",
      value: "Body",
    });
    expect(shown(h, "name")).toBe("Body");
  });

  // The picker's labels are fetched once per LIST of addresses
  // (useObjectNames keys on the list), so a rename that keeps the list
  // leaves the old name in the picker.
  test.failing(
    "PN-208: after a rename the picker shows the new name",
    async () => {
      covers("panel:paged.master-options");
      const h = await mount();
      await h.typeInto("name", "Body");
      expect(pickerLabels(h, "master")).toEqual(["Body"]);
    },
  );

  test("New… opens the form sized to the page; running it adds a master", async () => {
    covers("panel:paged.master-options", "command:paged.core.createMaster");
    const h = await mount();
    await h.click(action(h, "master-new"));
    const form = await dialog(h, "createMaster");
    expect(arg(form, "name").value).toBe("B-Master");
    expect(arg(form, "widthPt").value).toBe("612");
    expect(arg(form, "heightPt").value).toBe("792");
    const from = h.mark();
    await h.click(form.querySelector("[data-core-command-run]")!);
    expect(h.mutations(from).map((m) => (m as { op: string }).op)).toEqual([
      "createMaster",
    ]);
    const masters = (await h.client.collection("masterPages")) as unknown[];
    expect(masters).toHaveLength(2);
    expect(pickerLabels(h, "master")).toHaveLength(2);
  });

  test("Rename… opens the form on the picked master", async () => {
    covers("panel:paged.master-options", "command:paged.core.renameMaster");
    const h = await mount();
    await h.click(action(h, "master-rename"));
    const form = await dialog(h, "renameMaster");
    expect(arg(form, "master").value).toBe("master:um");
  });

  test("Delete sends deleteMaster for the picked master", async () => {
    covers("panel:paged.master-options", "command:paged.core.deleteMaster");
    const h = await mount();
    await h.mutate({
      op: "createMaster",
      args: { master: "ub2", name: "B-Master", widthPt: 612, heightPt: 792 },
    } as never);
    await h.choose(picker(h, "master")!, "master:ub2");
    const from = h.mark();
    await h.click(action(h, "master-delete"));
    expect(h.mutations(from).map((m) => (m as { op: string }).op)).toEqual([
      "deleteMaster",
    ]);
    expect(
      (
        (await h.client.collection("masterPages")) as Array<{ selfId: string }>
      ).map((m) => m.selfId),
    ).toEqual(["um"]);
  });
});

// ------------------------------------------------------------ text fields

describe("Text Fields (paged.text-fields)", () => {
  test("no field: says how to add one; Insert… offered, Set value… not", async () => {
    covers("panel:paged.text-fields");
    const h = await mountPanel(FieldOptionsPanel, {
      id: "paged.text-fields",
      document: "blank",
    });
    expect(empty(h)).toContain("Insert ▸ Field");
    expect(action(h, "field-insert").disabled).toBe(false);
    expect(action(h, "field-set-value").disabled).toBe(true);
  });

  test("a placeholder field: its value read; typing sets it", async () => {
    covers("panel:paged.text-fields");
    const h = await mountPanel(FieldOptionsPanel, {
      id: "paged.text-fields",
      scene: fieldScene,
    });
    const address = picker(h, "field")!.value;
    expect(address).toBe(`field:${h.scene.storyId}@0`);
    expect(shown(h, "value")).toBe("ACME");
    expect(action(h, "field-set-value").disabled).toBe(false);
    const from = h.mark();
    await h.typeInto("value", "Globex");
    expect(h.mutations(from)).toEqual([
      set(address, "value", { type: "text", value: "Globex" }),
    ] as never);
    expect(await h.get(address, "value")).toEqual({
      type: "text",
      value: "Globex",
    });
  });

  test("Insert… opens the typed form with a paged.data placeholder", async () => {
    covers("panel:paged.text-fields", "command:paged.core.insertField");
    const h = await mountPanel(withDialog(FieldOptionsPanel), {
      id: "paged.text-fields",
      document: "blank",
    });
    await h.click(action(h, "field-insert"));
    const form = await dialog(h, "insertField");
    expect(arg(form, "field").value).toContain("media.paged.data");
  });

  test("Set value… opens the form on the field's story and offset", async () => {
    covers("panel:paged.text-fields", "command:paged.core.setFieldValue");
    const h = await mountPanel(withDialog(FieldOptionsPanel), {
      id: "paged.text-fields",
      scene: fieldScene,
    });
    await h.click(action(h, "field-set-value"));
    const form = await dialog(h, "setFieldValue");
    expect(arg(form, "offset").value).toBe("0");
    expect(arg(form, "storyId").value).toBe(`story:${h.scene.storyId}`);
  });
});

// -------------------------------------------------------- section options

describe("Numbering & Section Options (paged.section-options)", () => {
  const mount = () =>
    mountPanel(SectionOptionsPanel, {
      id: "paged.section-options",
      scene: richScene,
    });

  test("a document without sections: says so", async () => {
    covers("panel:paged.section-options");
    const h = await mountPanel(SectionOptionsPanel, {
      id: "paged.section-options",
      document: "blank",
    });
    expect(empty(h)).toBe("This document has no numbering sections.");
  });

  test("the section, by number and prefix; its numbering read", async () => {
    covers("panel:paged.section-options");
    const h = await mount();
    expect(pickerLabels(h, "section")).toEqual(["1. B-"]);
    expect(shown(h, "prefix")).toBe("B-");
    expect(shown(h, "numberingStyle")).toBe("Arabic");
  });

  test("Prefix, style and start: each writes the section", async () => {
    covers("panel:paged.section-options");
    const h = await mount();
    const address = `section:${h.scene.section}`;
    let from = h.mark();
    await h.typeInto("prefix", "C-");
    expect(h.mutations(from)).toEqual([
      set(address, "prefix", { type: "text", value: "C-" }),
    ] as never);
    from = h.mark();
    await h.choose("numberingStyle", "UpperRoman");
    expect(h.mutations(from)).toEqual([
      set(address, "numberingStyle", { type: "text", value: "UpperRoman" }),
    ] as never);
    from = h.mark();
    await h.typeInto("startAt", "5");
    const start = h.mutations(from) as unknown as Array<{
      args: { path: string; value: { value: number } };
    }>;
    expect(start).toHaveLength(1);
    expect(start[0].args.path).toBe("startAt");
    expect(start[0].args.value.value).toBe(5);
    const sections = (await h.client.collection("sections")) as Array<{
      prefix: string;
      labelStyle: string;
    }>;
    expect(sections[0].prefix).toBe("C-");
    expect(pickerLabels(h, "section")).toEqual(["1. C-"]);
  });

  test("Delete section removes it", async () => {
    covers("panel:paged.section-options", "command:paged.core.deleteSection");
    const h = await mount();
    const from = h.mark();
    await h.click(action(h, "section-delete"));
    expect(h.mutations(from).map((m) => (m as { op: string }).op)).toEqual([
      "deleteSection",
    ]);
    expect(await h.client.collection("sections")).toEqual([]);
    expect(empty(h)).toBe("This document has no numbering sections.");
  });
});

// ----------------------------------------------------------------- guides

describe("Guides (paged.guides)", () => {
  const mount = () =>
    mountPanel(GuidesPanel, { id: "paged.guides", scene: richScene });
  const guide = "guide:Guide/us/0";

  test("a document without guides: says so", async () => {
    covers("panel:paged.guides");
    const h = await mountPanel(GuidesPanel, {
      id: "paged.guides",
      document: "blank",
    });
    expect(empty(h)).toContain("No ruler guides");
  });

  test("Position: the guide's place read, and typing 150 moves it", async () => {
    covers("panel:paged.guides");
    const h = await mount();
    expect(picker(h, "guide")!.value).toBe(guide);
    expect(shown(h, "position")).toBe("100 pt");
    const from = h.mark();
    await h.typeInto("position", "150");
    expect(h.mutations(from)).toEqual([
      set(guide, "position", { type: "length", value: 150 }),
    ] as never);
    const spreads = (await h.client.collection("spreads")) as Array<{
      guides: Array<{ position: number }>;
    }>;
    expect(spreads[0].guides[0].position).toBe(150);
    expect(shown(h, "position")).toBe("150 pt");
  });

  test.failing(
    "PN-207 (UX F-22): the guide picker describes the guide, not its id",
    async () => {
      covers("panel:paged.guides");
      const h = await mount();
      expect(pickerLabels(h, "guide").join()).not.toContain("Guide/");
    },
  );
});
