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

// The two ways `bun test` drives a browser here, behind one interface
// (docs/migration/bun-webview.md, the T7 trial):
//
//   - `playwright`: the Playwright LIBRARY (playwright-core's
//     `chromium.launch`), not Playwright's test runner;
//   - `webview`: `Bun.WebView` on its Chrome backend (the DevTools protocol
//     over a pipe). Its default backend on macOS is WKWebView, which runs
//     JavaScriptCore; the point of these checks is V8, so it is never used.
//
// Both launch the SAME Chromium (PAGED_CHROMIUM, else the one playwright-core
// installs), headless, so the trial compares drivers and not browsers.

import { existsSync } from "node:fs";

export type DriverName = "playwright" | "webview";

/** The DevTools protocol's `Runtime.exceptionThrown`, the part read here. */
interface ExceptionThrown {
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}

/** The DevTools protocol's `Log.entryAdded`: what the BROWSER logs (a failed
 *  load, a CSP refusal), which `console` never sees. */
interface LogEntry {
  entry?: { level?: string; text?: string };
}

export interface BrowserDriver {
  readonly name: DriverName;
  /** Navigate the page and wait for its load. */
  open(url: string): Promise<void>;
  /** A JavaScript expression in the page; a promise is awaited, the value
   *  comes back through JSON. */
  evaluate<T>(expression: string): Promise<T>;
  /** Console errors and uncaught page errors seen so far. */
  readonly errors: string[];
  close(): Promise<void>;
}

/** The Chromium both drivers launch, or why there is none. */
export async function chromium(): Promise<{ path?: string; why?: string }> {
  const env = process.env.PAGED_CHROMIUM;
  if (env)
    return existsSync(env)
      ? { path: env }
      : { why: `PAGED_CHROMIUM=${env} does not exist` };
  try {
    const { chromium } = await import("playwright-core");
    const path = chromium.executablePath();
    if (path && existsSync(path)) return { path };
  } catch {
    // playwright-core's browser registry knows no Chromium for this platform
  }
  return {
    why: "no Chromium: `bunx playwright-core install chromium` (in tests/), or set PAGED_CHROMIUM",
  };
}

/** Subscribe to a DevTools-protocol event of a `Bun.WebView` (its Chrome
 *  backend delivers each as a MessageEvent whose `data` is the event's
 *  params). */
export function onCdpEvent<T>(
  view: Bun.WebView,
  type: string,
  listener: (params: T) => void,
): void {
  view.addEventListener(type, (e) =>
    listener((e as unknown as { data: T }).data),
  );
}

export async function openDriver(
  name: DriverName,
  executablePath: string,
): Promise<BrowserDriver> {
  return name === "webview"
    ? webviewDriver(executablePath)
    : playwrightDriver(executablePath);
}

async function playwrightDriver(
  executablePath: string,
): Promise<BrowserDriver> {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  return {
    name: "playwright",
    errors,
    open: async (url) => {
      await page.goto(url);
    },
    evaluate: <T>(expression: string) =>
      page.evaluate(expression) as Promise<T>,
    close: () => browser.close(),
  };
}

async function webviewDriver(path: string): Promise<BrowserDriver> {
  const errors: string[] = [];
  const view = new Bun.WebView({
    // `url: false`: always spawn, never attach to a Chrome the user runs.
    backend: { type: "chrome", url: false, path },
    console: (type, ...args) => {
      if (type === "error") errors.push(args.map(String).join(" "));
    },
  });
  let listening = false;
  return {
    name: "webview",
    errors,
    open: async (url) => {
      await view.navigate(url);
      if (!listening) {
        // Uncaught page errors and the browser's own log lines (a failed
        // load) are not console calls, which is all `console` sees. The
        // protocol has both; Playwright's `console` event includes the log.
        await view.cdp("Runtime.enable");
        await view.cdp("Log.enable");
        onCdpEvent<LogEntry>(view, "Log.entryAdded", (p) => {
          if (p.entry?.level === "error")
            errors.push(p.entry.text ?? "log error");
        });
        onCdpEvent<ExceptionThrown>(
          view,
          "Runtime.exceptionThrown",
          (p) =>
            void errors.push(
              p.exceptionDetails?.exception?.description ??
                p.exceptionDetails?.text ??
                "exception",
            ),
        );
        listening = true;
      }
    },
    evaluate: <T>(expression: string) => view.evaluate<T>(expression),
    close: async () => {
      view.close();
      Bun.WebView.closeAll();
    },
  };
}
