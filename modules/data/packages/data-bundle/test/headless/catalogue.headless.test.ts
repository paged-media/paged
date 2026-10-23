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

// ADR 560 — catalogues on the real bundle, the real data engine, DuckDB and
// the real canvas engine: a one-page template with a text field and a
// visibility field, both bound to a query, repeated once per record; a
// value the template's constraints refuse; and the filler, who may change
// the product list only where the template's page policy opens the
// catalogue's pages.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  setDefaultTimeout,
} from "bun:test";

import { covers } from "@paged-media/test-kit";
import type { ElementId } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import { headlessEnv, readiness, type DataEnv } from "../conformance/env";
import { D, seed } from "../conformance/scenarios";
import type { CatalogueResult } from "../../src/catalogue";

type Env = DataEnv & { h: HeadlessHost };
const gate = readiness(true);
const PAGE = "usp";

const send = (env: Env, kind: string, payload?: unknown) =>
  (
    env.h.host.editor.client as unknown as {
      send(m: unknown): Promise<{
        kind: string;
        payload: { createdId?: { id: string } };
      }>;
    }
  ).send(payload === undefined ? { kind } : { kind, payload });

const role = async (env: Env, r: "author" | "filler") =>
  expect(
    (await send(env, "setSessionPolicy", { policy: { role: r } })).kind,
  ).toBe("sessionPolicyApplied");

/** An author writes a template policy label (an item's or a page's). */
async function policy(
  env: Env,
  target: { element: ElementId } | { page: string },
  data: unknown,
): Promise<void> {
  const value = JSON.stringify({ v: 1, data });
  const r = await send(
    env,
    "mutate",
    "page" in target
      ? {
          op: "setPageMetadata",
          args: { page: target.page, key: "x-paged:template", value },
        }
      : {
          op: "setPluginMetadata",
          args: { elementId: target.element, key: "x-paged:template", value },
        },
  );
  expect(r.kind).toBe("mutationApplied");
}

/** The template: a text frame `title` (at most `maxLength` characters) and
 *  the rectangle as the visibility field `badge`, bound to `name` and
 *  `shown` of the query `q`. */
async function template(env: Env, maxLength = 20): Promise<void> {
  await seed(env);
  await role(env, "author");
  const frame = await send(env, "mutate", {
    op: "insertTextFrame",
    args: { pageId: PAGE, bounds: [200, 10, 230, 200] },
  });
  const id = frame.payload.createdId!.id;
  const story = (
    await env.host.document.collection<{ selfId: string }>("stories")
  ).at(-1)!.selfId;
  await send(env, "mutate", {
    op: "insertText",
    args: { storyId: story, offset: 0, text: "Product" },
  });
  await policy(
    env,
    { element: { kind: "textFrame", id } },
    { field: { name: "title", kind: "text", constraints: { maxLength } } },
  );
  await policy(
    env,
    { element: { kind: "rectangle", id: "urect" } },
    { field: { name: "badge", kind: "visibility" } },
  );
  for (const b of [
    { field: "title", query: "q", expr: "name" },
    { field: "badge", query: "q", expr: "shown" },
  ]) {
    const r = (await env.objects.invoke(
      `${D}.bindTemplateField` as never,
      b,
    )) as { ok: boolean; reason?: string };
    expect(r.ok, r.reason).toBe(true);
  }
}

const run = (env: Env, args: unknown = {}) =>
  env.objects.invoke(
    `${D}.runCatalogue` as never,
    args,
  ) as Promise<CatalogueResult>;

interface FieldRow {
  field: { name: string };
  elementId: ElementId | null;
  value: { kind: string; text?: string; visible?: boolean } | null;
}

/** Per page, in document order: the title's text and the badge's
 *  visibility. */
async function pagesShown(
  env: Env,
): Promise<{ title: string; badge: boolean }[]> {
  const pages = (
    await env.host.document.collection<{ selfId: string }>("pages")
  ).map((p) => p.selfId);
  const rows = await env.host.document.collection<FieldRow>("templateFields");
  const geo = await env.host.document.elementGeometry(
    rows.map((r) => r.elementId!),
  );
  const pageOf = new Map(
    geo.map((g) => [(g.id as { id: string }).id, g.pageId]),
  );
  return pages.map((p) => {
    const on = rows.filter((r) => pageOf.get(r.elementId!.id as string) === p);
    const v = (name: string) => on.find((r) => r.field.name === name)?.value;
    return {
      title: v("title")?.text ?? "",
      badge: v("badge")?.visible ?? true,
    };
  });
}

describe.skipIf(!gate.ready && !gate.required)(
  `paged.data catalogues on the real engines${gate.ready ? "" : ` (unavailable: ${gate.missing})`}`,
  () => {
    setDefaultTimeout(60_000);
    let env: Env;
    beforeEach(async () => {
      env = (await headlessEnv()) as Env;
    });
    afterEach(() => env.dispose());

    it("templateFieldTargets lists the template's fields with their bindings", async () => {
      covers("command:media.paged.data.templateFieldTargets");
      await template(env);
      const targets = (await env.objects.invoke(
        `${D}.templateFieldTargets` as never,
        {},
      )) as { name: string; kind: string; page: string; binding: unknown }[];
      expect(
        targets.map((t) => [t.name, t.kind, t.page, t.binding !== null]),
      ).toEqual([
        ["badge", "visibility", PAGE, true],
        ["title", "text", PAGE, true],
      ]);
    });

    it("bindTemplateField refuses a field the template lacks and a column the query lacks", async () => {
      covers("command:media.paged.data.bindTemplateField");
      await template(env);
      const bind = (b: unknown) =>
        env.objects.invoke(`${D}.bindTemplateField` as never, b) as Promise<{
          ok: boolean;
          reason?: string;
        }>;
      expect(await bind({ field: "nope", query: "q", expr: "name" })).toEqual({
        ok: false,
        reason: 'The template has no field "nope".',
      });
      expect(
        await bind({ field: "title", query: "q", expr: "colour" }),
      ).toEqual({ ok: false, reason: "The query has no column colour." });
      expect(env.session.templateFieldBindings()).toEqual([
        { field: "title", query: "q", expr: "name" },
        { field: "badge", query: "q", expr: "shown" },
      ]);
    });

    it("runCatalogue makes one filled page per record, and a second run replaces the copies", async () => {
      covers("command:media.paged.data.runCatalogue");
      await template(env);
      const r = await run(env);
      expect(r.ok, r.message).toBe(true);
      expect([r.instances, r.records, r.pages.length, r.undoSteps]).toEqual([
        3, 3, 3, 2,
      ]);
      expect(r.pages[0]).toBe(PAGE);
      expect(await pagesShown(env)).toEqual([
        { title: "Alpha", badge: true },
        { title: "Beta", badge: false },
        { title: "Gamma", badge: true },
      ]);
      // Again, grouped: the copies of the first run are replaced, not added to.
      const g = await run(env, { mode: "perGroup", by: ["shown"] });
      expect(g.ok, g.message).toBe(true);
      expect(await pagesShown(env)).toEqual([
        { title: "Beta", badge: false },
        { title: "Alpha", badge: true },
      ]);
      // The run's choices are kept with the session.
      expect(env.session.catalogues()).toEqual([
        { page: PAGE, query: "q", mode: "perGroup", by: ["shown"] },
      ]);
      // Two undo steps take the run back: the fields, then the pages.
      await env.undo();
      await env.undo();
      expect((await pagesShown(env)).map((p) => p.title)).toEqual([
        "Alpha",
        "Beta",
        "Gamma",
      ]);
    });

    it("a value the template's constraints refuse refuses the whole catalogue, and nothing is written", async () => {
      await template(env, 4);
      const before = await pagesShown(env);
      const r = await run(env);
      expect(r.ok).toBe(false);
      expect(r.problems).toEqual([
        {
          instance: "1",
          field: "title",
          problem: "longer than 4 characters",
        },
        {
          instance: "3",
          field: "title",
          problem: "longer than 4 characters",
        },
      ]);
      expect(r.message).toBe(
        'The catalogue was not made: 1, field "title": longer than 4 characters.',
      );
      expect(await pagesShown(env)).toEqual(before);
    });

    it("a filler changes the product list where the page policy opens the catalogue's pages, and nowhere else", async () => {
      await template(env);
      // The author makes the catalogue once; its pages are closed to a filler.
      expect((await run(env)).ok).toBe(true);
      await role(env, "filler");
      env.session.addQuery(
        "q",
        `SELECT * FROM products WHERE sku <> 'B-2' ORDER BY sku`,
        "recordStream",
      );
      await env.session.refreshData();
      const closed = await run(env);
      expect(closed.ok).toBe(false);
      expect(closed.message).toMatch(
        /^The catalogue was not made: this template does not let a filler change item .+ \(document\.pages\)\.$/,
      );
      expect((await pagesShown(env)).length).toBe(3);

      // The author opens the template page (and so its copies) to a filler.
      await role(env, "author");
      await policy(env, { page: PAGE }, { allow: ["document.pages"] });
      env.session.addQuery(
        "q",
        "SELECT * FROM products ORDER BY sku",
        "recordStream",
      );
      await env.session.refreshData();
      expect((await run(env)).ok).toBe(true);
      await role(env, "filler");
      env.session.addQuery(
        "q",
        `SELECT * FROM products WHERE sku <> 'B-2' ORDER BY sku`,
        "recordStream",
      );
      await env.session.refreshData();
      const open = await run(env);
      expect(open.ok, open.message).toBe(true);
      expect(await pagesShown(env)).toEqual([
        { title: "Alpha", badge: true },
        { title: "Gamma", badge: true },
      ]);
      // Every other page stays closed: a filler cannot add one.
      const added = await env.host.document.mutate({
        op: "insertPage",
        args: { afterPageId: PAGE as never, masterId: null },
      });
      expect(added.applied).toBe(false);
    });
  },
);
