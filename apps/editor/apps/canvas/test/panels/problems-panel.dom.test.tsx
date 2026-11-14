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

// Problems (paged.problems): every loaded bundle's host.diagnostics, from
// the one store the editor injects into each bundle host
// (problems-store.ts). The tests publish through that sink, as a bundle's
// `host.diagnostics.set` does.

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";

import { ProblemsPanel } from "../../src/panels/problems-panel";
import { problemsOf } from "../../src/panels/problems-store";
import { operationFeedbackOf } from "@paged-media/shell";
import { richScene } from "./fixtures";
import { structureIdml } from "./support/structure";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";

afterEach(() => {
  unmountAll();
});

const mount = () =>
  mountPanel(ProblemsPanel, { id: "paged.problems", scene: richScene });

const rows = (h: PanelHarness<unknown>) =>
  [...h.root.querySelectorAll<HTMLElement>("[data-problem]")].map((r) => ({
    severity: r.getAttribute("data-problem-severity"),
    bundle: r.getAttribute("data-problem-bundle"),
    message: r.querySelector("[data-problem-message]")?.textContent,
    location: r.querySelector("[data-problem-location]")?.textContent,
  }));

describe("Problems panel", () => {
  test("nothing published: says so", async () => {
    covers("panel:paged.problems");
    const h = await mount();
    expect(h.root.querySelector("[data-problems-empty]")?.textContent).toBe(
      "No problems detected.",
    );
    expect(rows(h)).toEqual([]);
  });

  test("published diagnostics: counted, errors first, with their location", async () => {
    covers("panel:paged.problems");
    const h = await mount();
    await h.act(() => {
      problemsOf(h.scope).publish("media.paged.web", "html", [
        {
          severity: "warning",
          message: "Unknown attribute",
          source: "html",
          line: 9,
        },
        { severity: "error", message: "Unclosed tag", source: "html", line: 3 },
      ]);
      problemsOf(h.scope).publish("media.paged.sheet", "formulas", [
        { severity: "info", message: "Circular reference resolved" },
      ]);
    });
    expect(h.root.querySelector("[data-problems-summary]")?.textContent).toBe(
      "1 error, 1 warning",
    );
    expect(rows(h)).toEqual([
      {
        severity: "error",
        bundle: "media.paged.web",
        message: "Unclosed tag",
        location: "html:3",
      },
      {
        severity: "warning",
        bundle: "media.paged.web",
        message: "Unknown attribute",
        location: "html:9",
      },
      {
        severity: "info",
        bundle: "media.paged.sheet",
        message: "Circular reference resolved",
        location: "formulas",
      },
    ]);
  });

  test("a bundle clearing its key removes its rows; clearing the bundle removes all of them", async () => {
    covers("panel:paged.problems");
    const h = await mount();
    await h.act(() => {
      problemsOf(h.scope).publish("media.paged.web", "html", [
        { severity: "error", message: "A" },
      ]);
      problemsOf(h.scope).publish("media.paged.web", "css", [
        { severity: "error", message: "B" },
      ]);
    });
    expect(rows(h)).toHaveLength(2);
    await h.act(() => problemsOf(h.scope).clear("media.paged.web", "html"));
    expect(rows(h).map((r) => r.message)).toEqual(["B"]);
    await h.act(() => problemsOf(h.scope).clear("media.paged.web"));
    expect(h.root.querySelector("[data-problems-empty]")).not.toBeNull();
  });

  test("clicking a problem opens the reporting bundle's panel", async () => {
    covers("panel:paged.problems");
    const h = await mount();
    h.registerPanel({
      id: "media.paged.web.panel.html",
      title: "HTML",
      component: () => null,
    });
    await h.act(() =>
      problemsOf(h.scope).publish("media.paged.web", "html", [
        { severity: "error", message: "Unclosed tag" },
      ]),
    );
    await h.click(h.root.querySelector("[data-problem]")!);
    expect(h.dock()).toMatchObject({ active: "media.paged.web.panel.html" });
  });

  // UX audit F-09 (fixed): in a document with missing links, Publication
  // health counted them while Problems said "No problems detected". The
  // document's own findings (missing links, missing fonts) are listed now.
  test("PN-350 (UX F-09): a missing link in the document is listed as a problem", async () => {
    covers("panel:paged.problems");
    // The structure fixture places an image whose file is not there.
    const h = await mountPanel(ProblemsPanel, {
      id: "paged.problems",
      document: structureIdml(),
    });
    const links = (await h.client.collection("links")) as Array<{
      status?: string;
    }>;
    expect(links.some((l) => l.status === "missing")).toBe(true);
    expect(h.root.querySelector("[data-problems-empty]")).toBeNull();
    const listed = [...h.root.querySelectorAll("[data-problem-message]")].map(
      (m) => m.textContent ?? "",
    );
    expect(listed.some((m) => m.startsWith("Missing link: "))).toBe(true);
    // A click opens the panel that fixes it.
    h.registerPanel({
      id: "paged.links",
      title: "Links",
      component: () => null,
    } as never);
    const row = [
      ...h.root.querySelectorAll<HTMLElement>("[data-problem]"),
    ].find((r) => r.textContent?.includes("Missing link"))!;
    await h.click(row);
    expect(h.dock()).toMatchObject({ active: "paged.links" });
  });

  // Editor ADR 1219 — UX audit F-02: an operation that failed and left an
  // issue is listed until it is resolved or dismissed.
  test("F-02: a failed open is listed with what changed; Dismiss takes it out", async () => {
    covers("panel:paged.problems");
    const h = await mount();
    await h.act(() =>
      operationFeedbackOf(h.scope).report({
        action: "open broken.idml",
        outcome: "recoverable-failure",
        reason: "the file is damaged",
        document: "unchanged",
        key: "paged.open|broken.idml",
        source: "paged.open",
        channel: "problem",
      }),
    );
    expect(rows(h)[0]).toMatchObject({
      severity: "warning",
      bundle: "paged.open",
      message:
        "Could not open broken.idml: the file is damaged. Nothing changed.",
    });
    await h.click(h.root.querySelector<HTMLElement>("[data-problem-dismiss]")!);
    expect(rows(h)).toEqual([]);
  });

  // Editor ADR 1222 — a bundle's loss rows are one row that opens the
  // compatibility report, where each is explained.
  test("loss rows are one row: N differences, opening the compatibility report", async () => {
    covers("panel:paged.problems");
    const h = await mount();
    await h.act(() =>
      problemsOf(h.scope).publish(
        "media.paged.slide",
        "media.paged.slide/import",
        [
          {
            severity: "warning",
            message: "a",
            loss: { code: "pptx.effect.unsupported", count: 2 },
          },
          {
            severity: "warning",
            message: "b",
            loss: { code: "dml.3d.camera", count: 1 },
          },
          { severity: "info", message: "opened from a template" },
        ],
      ),
    );
    expect(rows(h).map((r) => r.message)).toEqual([
      "3 differences from the source file: see the compatibility report",
      "opened from a template",
    ]);
  });
});
