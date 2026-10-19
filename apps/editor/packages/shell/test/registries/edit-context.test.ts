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

// ADR 024 — "the surface follows what you are editing". The pure parts
// of edit-context and mode resolution:
//
//   · resolveDoubleClick: object type first, then an edit context by
//     kind, else group descent (null);
//   · panelBelongsHere: a panel another context claims is not offered
//     while a different context is active;
//   · the applicability vocabulary (here / elsewhere / absent) and how a
//     palette and a menu bar each render it;
//   · readEnvelope: the plugin metadata a matcher sees;
//   · the edit-context, object-type and mode registries.

import { describe, expect, test } from "bun:test";

import type {
  EditContextCandidate,
  EditContextContribution,
  ObjectTypeContribution,
} from "@paged-media/plugin-api";

import {
  ALWAYS_IN_PALETTE,
  applicabilityHint,
  applicabilityOf,
  applicabilityStyle,
} from "../../src/chrome/applicability";
import {
  createEditContextRegistry,
  createObjectTypeRegistry,
  resolveDoubleClick,
} from "../../src/registries/edit-context";
import { createModeRegistry } from "../../src/registries/mode";
import { panelBelongsHere } from "../../src/registries/types";
import { readEnvelope } from "../../src/state/use-edit-context-entry";

const candidate = (
  kind: string,
  extra: Partial<EditContextCandidate> = {},
): EditContextCandidate =>
  ({
    kind,
    id: "u1",
    groupAncestry: [],
    metadata: null,
    ...extra,
  }) as unknown as EditContextCandidate;

const context = (
  type: string,
  extra: Partial<EditContextContribution> = {},
): EditContextContribution =>
  ({ type, entry: "doubleClick", ...extra }) as EditContextContribution;

describe("resolveDoubleClick", () => {
  test("an object type that claims the element routes to its edit context, before any kind match", () => {
    const contexts = createEditContextRegistry();
    const objects = createObjectTypeRegistry();
    contexts.register(
      context("vectorGraphic", { matches: (c) => c.kind === "rectangle" }),
    );
    contexts.register(context("webSource"));
    const webFrame: ObjectTypeContribution = {
      type: "webFrame",
      editContextType: "webSource",
      matches: (c: EditContextCandidate) => c.metadata !== null,
    } as unknown as ObjectTypeContribution;
    objects.register(webFrame);

    const claimed = resolveDoubleClick(
      candidate("rectangle", { metadata: { v: 1, data: {} } } as never),
      contexts,
      objects,
    );
    expect(claimed?.contextType).toBe("webSource");
    expect(claimed?.objectType).toBe(webFrame);

    // Without the metadata the object type does not claim it: kind wins.
    const plain = resolveDoubleClick(candidate("rectangle"), contexts, objects);
    expect(plain?.contextType).toBe("vectorGraphic");
    expect(plain?.objectType).toBeUndefined();
  });

  test("nothing claims it: null, the caller descends into the group", () => {
    const contexts = createEditContextRegistry();
    const objects = createObjectTypeRegistry();
    contexts.register(
      context("vectorGraphic", { matches: (c) => c.kind === "polygon" }),
    );
    expect(
      resolveDoubleClick(candidate("textFrame"), contexts, objects),
    ).toBeNull();
  });

  test("an object type whose context is not registered falls through to the kind match", () => {
    const contexts = createEditContextRegistry();
    const objects = createObjectTypeRegistry();
    objects.register({
      type: "orphan",
      editContextType: "missing",
      matches: () => true,
    } as unknown as ObjectTypeContribution);
    objects.register({
      type: "noContext",
      matches: () => true,
    } as unknown as ObjectTypeContribution);
    contexts.register(context("sheet", { matches: () => true }));
    expect(
      resolveDoubleClick(candidate("rectangle"), contexts, objects)
        ?.contextType,
    ).toBe("sheet");
  });

  test("only doubleClick entries are entered by a double-click; a context without a matcher never is", () => {
    const contexts = createEditContextRegistry();
    const objects = createObjectTypeRegistry();
    contexts.register(
      context("programmatic", {
        entry: "programmatic" as never,
        matches: () => true,
      }),
    );
    contexts.register(context("noMatcher"));
    expect(
      resolveDoubleClick(candidate("rectangle"), contexts, objects),
    ).toBeNull();
  });

  test("the first registered match wins among kind-claimed contexts", () => {
    const contexts = createEditContextRegistry();
    const objects = createObjectTypeRegistry();
    contexts.register(context("first", { matches: () => true }));
    contexts.register(context("second", { matches: () => true }));
    expect(
      resolveDoubleClick(candidate("rectangle"), contexts, objects)
        ?.contextType,
    ).toBe("first");
  });
});

describe("panelBelongsHere (ADR 024)", () => {
  const editor = (activeType: string | null) => ({
    editContext: activeType ? { type: activeType } : null,
    registries: {
      editContexts: {
        list: () => [
          { type: "sheet", panelIds: ["sheet.workbook"] },
          { type: "vectorGraphic", panelIds: ["draw.stroke", "draw.shared"] },
          { type: "raster", panelIds: ["draw.shared"] },
        ],
      },
    },
  });

  test("a panel no context claims is offered everywhere", () => {
    for (const ctx of [null, "sheet", "vectorGraphic"]) {
      expect(panelBelongsHere(editor(ctx), "paged.layers")).toBe(true);
    }
  });

  test("a context's own panel is offered inside it and at the document root", () => {
    expect(panelBelongsHere(editor("sheet"), "sheet.workbook")).toBe(true);
    expect(panelBelongsHere(editor(null), "sheet.workbook")).toBe(true);
  });

  test("a panel another content type claims is not offered while editing a different one", () => {
    expect(panelBelongsHere(editor("sheet"), "draw.stroke")).toBe(false);
    expect(panelBelongsHere(editor("vectorGraphic"), "sheet.workbook")).toBe(
      false,
    );
  });

  test("a panel two contexts claim is offered inside the first claimant", () => {
    // `draw.shared` is claimed by vectorGraphic first, raster second.
    expect(panelBelongsHere(editor("vectorGraphic"), "draw.shared")).toBe(true);
    expect(panelBelongsHere(editor("sheet"), "draw.shared")).toBe(false);
  });

  // Finding SH-6 (latent: no two shipped contexts share a panel today).
  // The rule says the ACTIVE context's own panels stay offered, but the
  // loop decides at the FIRST claimant: inside the second claimant it
  // meets the first one's claim (not active) and hides the panel.
  test.failing(
    "SH-6: a panel two contexts claim is offered inside each of them",
    () => {
      expect(panelBelongsHere(editor("raster"), "draw.shared")).toBe(true);
    },
  );

  test("no registry to ask (a standalone mount, no editor): offered", () => {
    expect(panelBelongsHere(null, "draw.stroke")).toBe(true);
    expect(panelBelongsHere({}, "draw.stroke")).toBe(true);
  });
});

describe("the applicability vocabulary", () => {
  test("three states, two surfaces: hidden on a palette, greyed-but-clickable on a map", () => {
    expect(applicabilityStyle("here", "palette")).toEqual({
      visible: true,
      opacity: 1,
      interactive: true,
      attr: "here",
    });
    expect(applicabilityStyle("here", "map")).toEqual(
      applicabilityStyle("here", "palette"),
    );
    expect(applicabilityStyle("elsewhere", "palette")).toMatchObject({
      visible: false,
      interactive: false,
      attr: "elsewhere",
    });
    expect(applicabilityStyle("elsewhere", "map")).toEqual({
      visible: true,
      opacity: 0.35,
      interactive: true,
      attr: "elsewhere",
    });
    for (const surface of ["palette", "map"] as const) {
      expect(applicabilityStyle("absent", surface)).toEqual({
        visible: true,
        opacity: 0.45,
        interactive: false,
        attr: "absent",
      });
    }
  });

  test("absent beats everything; the navigation tools never leave a palette", () => {
    expect(applicabilityOf({ exists: false, appliesHere: true })).toBe(
      "absent",
    );
    expect(
      applicabilityOf({
        exists: false,
        appliesHere: false,
        id: "paged.tool.select",
      }),
    ).toBe("absent");
    for (const id of ALWAYS_IN_PALETTE) {
      expect(applicabilityOf({ exists: true, appliesHere: false, id })).toBe(
        "here",
      );
    }
    expect(
      applicabilityOf({
        exists: true,
        appliesHere: false,
        id: "paged.tool.pen",
      }),
    ).toBe("elsewhere");
    expect(applicabilityOf({ exists: true, appliesHere: true })).toBe("here");
    expect(ALWAYS_IN_PALETTE).toEqual([
      "paged.tool.select",
      "paged.tool.directSelect",
      "paged.tool.hand",
      "paged.tool.zoom",
    ]);
  });

  test("every surface explains the state with the same words", () => {
    expect(applicabilityHint("here")).toBe("");
    expect(applicabilityHint("elsewhere")).toBe(" — leaves this context");
    expect(applicabilityHint("absent")).toBe(" — coming soon");
  });
});

describe("readEnvelope: the plugin metadata a matcher sees", () => {
  const entry = (key: string, value: unknown) => ({
    value: { type: "pluginMetadata", value: { key, value } },
  });

  test("the envelope under the plugin's own key, parsed", () => {
    const entries = [
      { value: { type: "number", value: 3 } },
      entry(
        "x-paged:media.paged.web",
        JSON.stringify({ v: 1, data: { a: 1 } }),
      ),
    ];
    expect(readEnvelope(entries, "x-paged:media.paged.web")).toEqual({
      v: 1,
      data: { a: 1 },
    });
  });

  test("another plugin's key, a missing key, or unparseable JSON: null", () => {
    const entries = [
      entry("x-paged:media.paged.sheet", JSON.stringify({ v: 1, data: {} })),
      entry("x-paged:media.paged.broken", "{not json"),
      entry("x-paged:media.paged.number", 42),
    ];
    expect(readEnvelope(entries, "x-paged:media.paged.web")).toBeNull();
    expect(readEnvelope(entries, "x-paged:media.paged.broken")).toBeNull();
    expect(readEnvelope(entries, "x-paged:media.paged.number")).toBeNull();
    expect(readEnvelope([], "x-paged:media.paged.web")).toBeNull();
  });
});

describe("the edit-context, object-type and mode registries", () => {
  test("a content type registers once; dispose and unregister report once", () => {
    for (const make of [createEditContextRegistry, createObjectTypeRegistry]) {
      const r = make();
      const events: string[] = [];
      r.onChange((e) =>
        events.push(
          e.kind === "registered" ? `+${e.contribution.type}` : `-${e.type}`,
        ),
      );
      const h = r.register({ type: "sheet", matches: () => true } as never);
      expect(() =>
        r.register({ type: "sheet", matches: () => true } as never),
      ).toThrow(/already registered/);
      expect(r.get("sheet")?.type).toBe("sheet");
      h.dispose();
      h.dispose();
      r.register({ type: "web", matches: () => true } as never);
      r.unregister("web");
      r.unregister("web");
      expect(events).toEqual(["+sheet", "-sheet", "+web", "-web"]);
      expect(r.list()).toEqual([]);
    }
  });

  test("modes list by order, refuse a duplicate id, report changes", () => {
    const r = createModeRegistry();
    const events: string[] = [];
    r.onChange((e) =>
      events.push(
        e.kind === "registered" ? `+${e.contribution.id}` : `-${e.id}`,
      ),
    );
    r.register({ id: "review", title: "Review", icon: "i", order: 50 });
    const design = r.register({
      id: "design",
      title: "Design",
      icon: "i",
      order: 10,
    });
    r.register({ id: "content", title: "Content", icon: "i", order: 20 });
    expect(r.list().map((m) => m.id)).toEqual(["design", "content", "review"]);
    expect(() =>
      r.register({ id: "design", title: "Again", icon: "i", order: 1 }),
    ).toThrow(/already registered/);
    design.dispose();
    r.unregister("content");
    expect(r.list().map((m) => m.id)).toEqual(["review"]);
    expect(r.get("design")).toBeUndefined();
    expect(events).toEqual([
      "+review",
      "+design",
      "+content",
      "-design",
      "-content",
    ]);
  });
});
