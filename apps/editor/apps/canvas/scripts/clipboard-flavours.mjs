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

// What a browser can read off, and write onto, the system clipboard — the
// evidence behind the vector clipboard's flavours (ADR 289).
//
//   node scripts/clipboard-flavours.mjs [--headed] [--write]
//
// READ (default): put something on the clipboard first (Illustrator's
// Edit > Copy: modules/draw/scripts/illustrator/run-clipboard-probe.sh
// records what it puts there), then run this. It prints, for Chromium as
// Playwright ships it: the types `navigator.clipboard.read()` exposes,
// each one's size and first bytes, and the types a real paste event's
// `clipboardData` carries.
//
// WRITE (--write): writes text/plain + text/html + image/svg+xml through
// `navigator.clipboard.write` and prints which types
// `ClipboardItem.supports` admits; read the pasteboard afterwards (macOS:
// `osascript -l JavaScript` over NSPasteboard) to see what landed.
//
// The clipboard is the user's: this REPLACES it with --write and reads it
// otherwise. Maintainer-only; CI never runs it.
import { chromium } from "@playwright/test";

const headed = process.argv.includes("--headed");
const write = process.argv.includes("--write");
const browser = await chromium.launch({ headless: !headed });
const context = await browser.newContext({
  permissions: ["clipboard-read", "clipboard-write"],
});
const page = await context.newPage();
// A secure origin: the async clipboard exists only there.
await page.route("http://localhost/clip", (route) =>
  route.fulfill({
    contentType: "text/html",
    body: "<!doctype html><title>clip</title><div id=t contenteditable>x</div>",
  }),
);
await page.goto("http://localhost/clip");
await page.bringToFront();
await page.click("#t");

const report = { browser: `chromium ${browser.version()}`, headed };
report.supports = await page.evaluate(() =>
  Object.fromEntries(
    [
      "text/plain",
      "text/html",
      "image/png",
      "image/svg+xml",
      "application/pdf",
      "web application/pdf",
      "web image/svg+xml",
    ].map((t) => [
      t,
      typeof ClipboardItem.supports === "function"
        ? ClipboardItem.supports(t)
        : "unknown",
    ]),
  ),
);
if (write) {
  report.write = await page.evaluate(async () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>';
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob(["probe"], { type: "text/plain" }),
          "text/html": new Blob(["<b>probe</b>"], { type: "text/html" }),
          "image/svg+xml": new Blob([svg], { type: "image/svg+xml" }),
        }),
      ]);
      return "ok";
    } catch (e) {
      return String(e);
    }
  });
} else {
  report.read = await page.evaluate(async () => {
    try {
      const items = await navigator.clipboard.read();
      const out = [];
      for (const item of items) {
        for (const type of item.types) {
          const blob = await item.getType(type);
          const head = new TextDecoder("latin1")
            .decode(new Uint8Array(await blob.slice(0, 48).arrayBuffer()))
            .replace(/[^\x20-\x7e]/g, ".");
          out.push({ type, bytes: blob.size, head });
        }
      }
      return out;
    } catch (e) {
      return String(e);
    }
  });
  await page.evaluate(() => {
    window.__paste = new Promise((resolve) => {
      const timer = setTimeout(() => resolve("no paste event"), 3000);
      document.addEventListener(
        "paste",
        (e) => {
          clearTimeout(timer);
          e.preventDefault();
          const d = e.clipboardData;
          resolve({
            types: [...d.types],
            files: [...d.files].map((f) => `${f.type} ${f.size}`),
            svgText: d.getData("image/svg+xml").length,
            plainHead: d.getData("text/plain").slice(0, 40),
          });
        },
        { once: true },
      );
    });
  });
  await page.keyboard.press("Meta+V");
  report.pasteEvent = await page.evaluate(() => window.__paste);
}
console.log(JSON.stringify(report, null, 2));
await browser.close();
