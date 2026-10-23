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

// Template field outlines (plan task D3): over the real engine, a filler
// sees every field outlined with its label, and a picture field carries a
// Replace button; an editor sees none of it.

import { afterEach, describe, expect, test } from "bun:test";
import type { ReactElement } from "react";

import { SessionPolicyProvider, useDocument } from "@paged-media/shell";
import { covers } from "@paged-media/test-kit";

import { templateFieldsContribution } from "../../src/overlays/template-fields";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";

afterEach(unmountAll);

function overlayAs(role: "filler" | "editor" | "author") {
  const Render = templateFieldsContribution.render;
  return function Overlay(): ReactElement {
    // Every page of the document at the origin, as the viewport would
    // hand the overlay host its page rectangles.
    const { handle } = useDocument();
    const pageRects = new Map(
      (handle?.pageIds ?? []).map((id) => [id, { x: 0, y: 0, w: 612, h: 792 }]),
    );
    return (
      <SessionPolicyProvider policy={{ role, overrides: [] }}>
        <svg>
          <Render
            paged={null}
            camera={{ scale: 2, tx: 0, ty: 0 }}
            pageRects={pageRects as never}
          />
        </svg>
      </SessionPolicyProvider>
    );
  };
}

async function makeFields(h: PanelHarness<unknown>) {
  await h.client.setSessionPolicy({ role: "author", overrides: [] });
  const make = async (
    op: string,
    name: string,
    kind: string,
    bounds: number[],
  ) => {
    const reply = await h.mutate({
      op,
      args: { pageId: h.handle!.pageIds[0], bounds },
    } as never);
    const elementId = (reply as { payload: { createdId: unknown } }).payload
      .createdId;
    await h.mutate({
      op: "setPluginMetadata",
      args: {
        elementId,
        key: "x-paged:template",
        value: JSON.stringify({
          v: 1,
          data: { field: { name, kind, label: name } },
        }),
      },
    } as never);
  };
  await make("insertTextFrame", "headline", "text", [100, 40, 160, 300]);
  await make("insertFrame", "photo", "image", [200, 40, 300, 200]);
}

describe("template field outlines", () => {
  test("a filler sees each field outlined, and a picture's Replace button", async () => {
    covers("panel:paged.template.form");
    const h = await mountPanel(overlayAs("filler"), {
      id: "paged.template.form",
      document: "blank",
    });
    await makeFields(h);
    await h.settle();
    await h.settle();
    const outlines = [
      ...h.root.querySelectorAll("[data-template-field-outline]"),
    ].map((e) => e.getAttribute("data-template-field-outline"));
    expect(outlines.sort()).toEqual(["headline", "photo"]);
    expect(
      h.root.querySelector('[data-template-field-replace="photo"]'),
    ).not.toBeNull();
    expect(
      h.root.querySelector('[data-template-field-replace="headline"]'),
    ).toBeNull();
  });

  test("an editor sees the document as it prints", async () => {
    covers("panel:paged.template.form");
    const h = await mountPanel(overlayAs("editor"), {
      id: "paged.template.form",
      document: "blank",
    });
    await makeFields(h);
    await h.settle();
    expect(h.root.querySelector("[data-template-field-outline]")).toBeNull();
  });

  test("an author sees which fields have a problem (plan F4)", async () => {
    covers("panel:paged.template.form");
    const h = await mountPanel(overlayAs("author"), {
      id: "paged.template.form",
      document: "blank",
    });
    await makeFields(h);
    // A picture field on a text frame: the preflight's error.
    await h
      .mutate({
        op: "insertTextFrame",
        args: { pageId: h.handle!.pageIds[0], bounds: [400, 40, 460, 300] },
      } as never)
      .then((reply) =>
        h.mutate({
          op: "setPluginMetadata",
          args: {
            elementId: (reply as { payload: { createdId: unknown } }).payload
              .createdId,
            key: "x-paged:template",
            value: JSON.stringify({
              v: 1,
              data: { field: { name: "logo", kind: "image" } },
            }),
          },
        } as never),
      );
    await h.settle();
    await h.settle();
    const findings = await h.client.templateFindings();
    expect(findings.map((f) => [f.code, f.field])).toContainEqual([
      "imageNotReplaceable",
      "logo",
    ]);
    expect(
      h.root.querySelector('[data-template-field-problem="logo"]'),
    ).not.toBeNull();
    expect(
      h.root.querySelector('[data-template-field-problem="headline"]'),
    ).toBeNull();
  });
});
