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

// ADR 225 — the Library panel against a running paged.server: sign in through
// the real popup flow (server → identity provider → server → the editor's
// callback page), push, edit and push again, pull.
//
// Needs, all local: `npx wrangler dev --port 8791` in editor-server's
// server/crates/paged-server (its .dev.vars admits http://127.0.0.1:5291 and
// names the provider below), and this run started with
// PAGED_SERVER_URL=http://127.0.0.1:8791 IDML_CANVAS_TEST_PORT=5291. The test
// plays the OpenID provider on 127.0.0.1:8792. Skipped without PAGED_SERVER_URL.

import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { dirname, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

import { openCanvas, openPanel } from "../fidelity/canvas-driver";

const SERVER = process.env.PAGED_SERVER_URL;
const REPO_ROOT = pathResolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const FIXTURE = `${REPO_ROOT}/corpus/idml/generated/text.idml`;
const IDP = "127.0.0.1:8792";

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** A provider that signs in "alice" at once and checks PKCE on the token call. */
function fakeIdp(): Server {
  const codes = new Map<string, { nonce: string; challenge: string }>();
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${IDP}`);
    const json = (v: unknown, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(v));
    };
    if (url.pathname === "/.well-known/openid-configuration") {
      return json({
        issuer: `http://${IDP}`,
        authorization_endpoint: `http://${IDP}/authorize`,
        token_endpoint: `http://${IDP}/token`,
      });
    }
    if (url.pathname === "/authorize") {
      const code = `idp-${codes.size}`;
      codes.set(code, { nonce: url.searchParams.get("nonce")!, challenge: url.searchParams.get("code_challenge")! });
      res.writeHead(302, {
        location: `${url.searchParams.get("redirect_uri")}?code=${code}&state=${url.searchParams.get("state")}`,
      });
      return res.end();
    }
    if (url.pathname === "/token") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const f = new URLSearchParams(body);
        const entry = codes.get(f.get("code") ?? "");
        const pkce = entry && b64url(createHash("sha256").update(f.get("code_verifier") ?? "").digest()) === entry.challenge;
        if (!entry || !pkce || f.get("client_secret") !== "fake-idp-secret") return json({ error: "invalid_grant" }, 400);
        const claims = { iss: `http://${IDP}`, aud: f.get("client_id"), sub: "alice", exp: 4_000_000_000, nonce: entry.nonce };
        json({ id_token: `e30.${b64url(JSON.stringify(claims))}.unsigned`, token_type: "Bearer" });
      });
      return;
    }
    res.writeHead(404).end();
  });
}

async function edit(page: Page, text: string): Promise<void> {
  await page.evaluate(async (t) => {
    const c = (globalThis as unknown as { __canvas: { client: { send: (m: unknown) => Promise<unknown> } } }).__canvas;
    const bytes = Array.from(new TextEncoder().encode(t));
    await c.client.send({ kind: "writePagedPart", payload: { path: "paged/media.paged.test/probe.json", bytes } });
  }, text);
}

async function save(page: Page): Promise<void> {
  const download = page.waitForEvent("download");
  await page.evaluate(() =>
    (globalThis as unknown as { __canvas: { registries: { commands: { invoke: (id: string) => Promise<unknown> } } } }).__canvas.registries.commands.invoke(
      "paged.file.savePaged",
    ),
  );
  await download;
}

test.describe("library panel with a server @feat:editor-shell.panels.library", () => {
  test.skip(!SERVER, "needs PAGED_SERVER_URL and a running paged.server");
  let idp: Server;
  test.beforeAll(async () => {
    idp = fakeIdp();
    await new Promise<void>((r) => idp.listen(8792, "127.0.0.1", r));
  });
  test.afterAll(async () => {
    await new Promise((r) => idp.close(r));
  });

  test("sign in, push, edit, push the difference, pull @level:happy", async ({ page, context }) => {
    await openCanvas(page);
    await page.evaluate(async () => {
      localStorage.clear();
      const root = await navigator.storage.getDirectory();
      await root.removeEntry("paged-library", { recursive: true }).catch(() => undefined);
    });
    await page.reload();
    await openCanvas(page);
    await page.setInputFiles('input[type="file"]', FIXTURE);
    await expect
      .poll(() => page.evaluate(() => (globalThis as unknown as { __canvas: { ready: boolean } }).__canvas.ready))
      .toBe(true);
    await openPanel(page, "paged.library");
    const panel = page.locator("[data-library-panel]");
    await expect(panel.locator("[data-library-version]")).toHaveCount(1);

    // The real popup: server authorize → provider → server callback → our callback page.
    const popup = context.waitForEvent("page");
    await panel.locator("[data-library-signin]").click();
    await (await popup).waitForEvent("close");
    await expect(panel.locator("[data-library-who]")).toContainText("user:alice@127.0.0.1");

    await panel.locator("[data-library-push]").click();
    await expect(panel.locator("[data-library-sync-note]")).toContainText("Pushed");

    // The first save is the first .paged projection (the opened version was the
    // .idml), so it adds the model part and the manifest.
    await edit(page, '{"v":1}');
    await save(page);
    await expect(panel.locator("[data-library-version]")).toHaveCount(2);
    await panel.locator("[data-library-push]").click();
    await expect(panel.locator("[data-library-sync-note]")).toContainText("Pushed");

    // A later edit to one part: that part, the manifest, the tree and the commit travel.
    await edit(page, '{"v":2}');
    await save(page);
    await expect(panel.locator("[data-library-version]")).toHaveCount(3);
    await panel.locator("[data-library-push]").click();
    await expect(panel.locator("[data-library-sync-note]")).toContainText(/Pushed [1-4] objects? \([0-9,]+ bytes\)/);

    await panel.locator("[data-library-pull]").click();
    await expect(panel.locator("[data-library-sync-note]")).toHaveText("Up to date");
    await expect(panel.locator("[data-library-error]")).toHaveCount(0);
  });
});
