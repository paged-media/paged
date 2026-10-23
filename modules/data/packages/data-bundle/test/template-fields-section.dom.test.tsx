/*
 * This file is part of paged (https://paged.media).
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

// The Bindings panel's "Template fields" section (ADR 560) as a component
// (happy-dom, `bun run test:dom`), over a session that records what it is
// asked: the template's fields are listed, a field is bound to the picked
// query's expression, and the catalogue is made per group.

import { afterEach, describe, expect, it } from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createElement } from "react";

import type {
  CatalogueRunOptions,
  TemplateFieldBinding,
  TemplateFieldTarget,
} from "../src/catalogue";
import { TemplateFieldsSection } from "../src/panels/template-fields-section";
import type { DataSourceSession } from "../src/session";

function stub(targets: TemplateFieldTarget[]) {
  const bound: TemplateFieldBinding[] = [];
  const runs: CatalogueRunOptions[] = [];
  const session = {
    templateFieldTargets: async () => targets,
    bindTemplateField: async (b: TemplateFieldBinding) => {
      bound.push(b);
      return { ok: true as const };
    },
    unbindTemplateField: () => true,
    runCatalogue: async (o: CatalogueRunOptions) => {
      runs.push(o);
      return {
        ok: true,
        pages: ["p1", "p2"],
        instances: 2,
        records: 3,
        undoSteps: 2,
        problems: [],
        message: "Catalogue: 2 page(s) from 3 record(s).",
      };
    },
  } as unknown as DataSourceSession;
  return { session, bound, runs };
}

const title: TemplateFieldTarget = {
  name: "title",
  kind: "text",
  required: false,
  maxLength: null,
  page: "p1",
  binding: null,
};
const badge: TemplateFieldTarget = {
  name: "badge",
  kind: "visibility",
  required: false,
  maxLength: null,
  page: "p1",
  binding: { field: "badge", query: "q", expr: "shown" },
};

describe("the Template fields section", () => {
  afterEach(() => cleanup());

  it("says so when the document has no template fields", async () => {
    const { session } = stub([]);
    const { container } = render(
      createElement(TemplateFieldsSection, {
        session,
        pickQuery: () => "q",
        version: 0,
      }),
    );
    await act(async () => {});
    expect(container.textContent).toContain(
      "This document has no text, picture or visibility fields",
    );
  });

  it("binds a field to the picked query and makes the catalogue per group", async () => {
    const { session, bound, runs } = stub([badge, title]);
    const { container } = render(
      createElement(TemplateFieldsSection, {
        session,
        pickQuery: () => "q",
        version: 0,
      }),
    );
    await act(async () => {});
    const titleRow = container.querySelector('[data-template-field="title"]')!;
    // The bound field shows its expression and can be unbound.
    const badgeRow = container.querySelector('[data-template-field="badge"]')!;
    expect(
      (badgeRow.querySelector("[data-template-field-expr]") as HTMLInputElement)
        .value,
    ).toBe("shown");
    expect(
      badgeRow.querySelector("[data-template-field-unbind]"),
    ).not.toBeNull();
    expect(titleRow.querySelector("[data-template-field-unbind]")).toBeNull();

    fireEvent.change(titleRow.querySelector("[data-template-field-expr]")!, {
      target: { value: "UPPER(name)" },
    });
    await act(async () => {
      fireEvent.click(titleRow.querySelector("[data-template-field-bind]")!);
    });
    expect(bound).toEqual([
      { field: "title", query: "q", expr: "UPPER(name)" },
    ]);

    fireEvent.change(container.querySelector("[data-catalogue-mode]")!, {
      target: { value: "perGroup" },
    });
    fireEvent.change(container.querySelector("[data-catalogue-by]")!, {
      target: { value: "cat, brand" },
    });
    await act(async () => {
      fireEvent.click(container.querySelector("[data-catalogue-run]")!);
    });
    expect(runs).toEqual([
      { query: "q", mode: "perGroup", by: ["cat", "brand"] },
    ]);
    expect(container.querySelector("[data-catalogue-msg]")?.textContent).toBe(
      "Catalogue: 2 page(s) from 3 record(s).",
    );
  });
});
