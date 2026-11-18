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

// A stall watchdog for the takes (ADR 224). A page that stops answering
// leaves a Playwright action waiting (`mouse.move` has no timeout of its
// own) until the take's timeout, with nothing to say what the page was
// doing. The watchdog probes the page's main thread on a timer and is told
// when an input action starts and ends; when either waits longer than
// `stallMs`, it writes `stall-<n>.json` into `dir` (again every `stallMs`
// while the stall lasts, up to `maxReports`):
//
//   · the main thread's JavaScript stack (`Debugger.pause`, which the
//     inspector delivers by interrupting running script), twice, or a
//     note that no script ran within a second;
//   · whether the main thread still answers (an input action can wait
//     while it does: the browser holds the event);
//   · what the page did in the last seconds: the iframes it loaded, the
//     long tasks it ran, and its long animation frames;
//   · a short browser trace (Chrome's own timeline, every process), which
//     shows the renderer's main thread even when no script runs.

import type { CDPSession, Page } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export interface WatchdogOptions {
  /** Directory the stall reports are written to. */
  dir: string;
  /** How often the main thread is probed, ms. */
  everyMs?: number;
  /** A probe or an input action unanswered this long is a stall, ms. */
  stallMs?: number;
  /** Length of the browser trace taken on a stall, ms (0: none). */
  traceMs?: number;
  /** Reports written at most (a stall that lasts writes one per
   *  `stallMs`, each with its trace). */
  maxReports?: number;
}

export interface Watchdog {
  /** Await `action` (an input action, aimed at `at` in CSS px when it is
   *  the mouse's) under the watchdog: a report is written if it takes
   *  longer than `stallMs`. The action is not cancelled. */
  guard<T>(label: string, action: Promise<T>, at?: Point): Promise<T>;
  /** Write a report now (a step failed), unless one was written in the
   *  last `stallMs` or `maxReports` are written. Resolves to the report's
   *  path, or null. */
  report(reason: string): Promise<string | null>;
  /** The reports written so far. */
  readonly reports: readonly string[];
  stop(): Promise<void>;
}

export interface Point {
  x: number;
  y: number;
}

interface CallFrameLike {
  functionName: string;
  url: string;
  location: { scriptId: string; lineNumber: number; columnNumber?: number };
}

interface StackTraceLike {
  description?: string;
  callFrames: {
    functionName: string;
    url: string;
    scriptId: string;
    lineNumber: number;
  }[];
  parent?: StackTraceLike;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** `p`, or `null` once `ms` pass. */
async function within<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((r) => {
    timer = setTimeout(() => r(null), ms);
  });
  try {
    return await Promise.race([p, late]);
  } finally {
    clearTimeout(timer);
  }
}

const frameLine = (f: {
  functionName: string;
  url: string;
  line: number;
  column?: number;
}) =>
  `${f.functionName || "(anonymous)"} ${f.url.replace(/^https?:\/\/[^/]+/, "")}:${f.line + 1}${f.column !== undefined ? `:${f.column + 1}` : ""}`;

/** Installed in the page (main world): what it did lately. */
const PAGE_LOG = () => {
  type Log = {
    loadCount: number;
    loads: { t: number; src: string }[];
    longTasks: { t: number; ms: number }[];
    frames: { t: number; ms: number; scripts: string[] }[];
  };
  // The top document only: the init script also reaches every iframe.
  if (window !== window.top) return;
  const w = globalThis as unknown as { __pagedWatchdog?: Log };
  if (w.__pagedWatchdog) return;
  const log: Log = { loadCount: 0, loads: [], longTasks: [], frames: [] };
  w.__pagedWatchdog = log;
  const keep = <T>(a: T[], n: number) => {
    if (a.length > n) a.splice(0, a.length - n);
  };
  document.addEventListener(
    "load",
    (e) => {
      const t = e.target as Element | null;
      if (t && t.tagName === "IFRAME") {
        log.loadCount += 1;
        log.loads.push({
          t: performance.now(),
          src: t.hasAttribute("srcdoc")
            ? "srcdoc"
            : (t.getAttribute("src") ?? ""),
        });
        keep(log.loads, 2000);
      }
    },
    true,
  );
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries())
        log.longTasks.push({ t: e.startTime, ms: e.duration });
      keep(log.longTasks, 500);
    }).observe({ type: "longtask", buffered: true });
  } catch {
    // No long-task timing in this browser: the report says so by omission.
  }
  // Long animation frames, passively: a requestAnimationFrame counter of
  // its own would keep the page rendering and change what it watches.
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const loaf = e as PerformanceEntry & {
          scripts?: {
            sourceFunctionName?: string;
            sourceURL?: string;
            duration: number;
          }[];
        };
        log.frames.push({
          t: e.startTime,
          ms: e.duration,
          scripts: (loaf.scripts ?? [])
            .filter((sc) => sc.duration > 5)
            .map(
              (sc) =>
                `${sc.sourceFunctionName || "(anonymous)"} ${(sc.sourceURL ?? "").replace(/^https?:\/\/[^/]+/, "")} ${Math.round(sc.duration)} ms`,
            ),
        });
      }
      keep(log.frames, 300);
    }).observe({ type: "long-animation-frame", buffered: true });
  } catch {
    // No long-animation-frame timing in this browser.
  }
};

export async function startWatchdog(
  page: Page,
  opts: WatchdogOptions,
): Promise<Watchdog> {
  const everyMs = opts.everyMs ?? 1000;
  const stallMs = opts.stallMs ?? 8000;
  const traceMs = opts.traceMs ?? 3000;
  const maxReports = opts.maxReports ?? 3;
  const cdp: CDPSession = await page.context().newCDPSession(page);
  // The debugger must be on BEFORE a stall: enabling it is a message the
  // busy thread would never get to, while a pause interrupts running
  // script.
  // A paused frame's `url` is empty for module scripts: the script id names
  // it, through the scripts the debugger reports.
  const scripts = new Map<string, string>();
  cdp.on("Debugger.scriptParsed", (e: { scriptId: string; url: string }) => {
    if (e.url) scripts.set(e.scriptId, e.url);
  });
  await cdp.send("Debugger.enable");
  await page.addInitScript(PAGE_LOG);
  await page.evaluate(PAGE_LOG).catch(() => {});

  const reports: string[] = [];
  const pending = new Map<
    number,
    { label: string; since: number; at?: Point }
  >();
  let nextAction = 0;
  let stopped = false;
  let dumping: Promise<string | null> | null = null;
  let lastReportAt = 0;
  let probeSince: number | null = null;

  // Every pause the watchdog did not ask for (a `debugger` statement, or
  // its own pause arriving after it stopped waiting) is resumed at once:
  // the watchdog must never be what stops the page.
  type Paused = {
    callFrames: CallFrameLike[];
    asyncStackTrace?: StackTraceLike;
  };
  let waiter: ((ev: Paused) => void) | null = null;
  cdp.on("Debugger.paused", (ev: Paused) => {
    const w = waiter;
    waiter = null;
    if (w) w(ev);
    else void cdp.send("Debugger.resume").catch(() => {});
  });

  /** The main thread's script stack, or why there is none. */
  const stack = async (): Promise<{ js: string[] | null; note: string }> => {
    const paused = new Promise<Paused>((resolve) => {
      waiter = resolve;
    });
    await within(
      cdp.send("Debugger.pause").catch(() => {}),
      1000,
    );
    const ev = await within(paused, 1000);
    if (!ev) {
      waiter = null;
      return {
        js: null,
        note: "no script ran within a second of the pause: the main thread is idle, or busy outside script (style, layout, paint, a native wait); the trace tells which",
      };
    }
    const js = ev.callFrames.map((f) =>
      frameLine({
        functionName: f.functionName,
        url: f.url || scripts.get(f.location.scriptId) || "",
        line: f.location.lineNumber,
        column: f.location.columnNumber,
      }),
    );
    for (let a = ev.asyncStackTrace; a; a = a.parent) {
      js.push(`-- ${a.description ?? "async"} --`);
      for (const f of a.callFrames)
        js.push(
          frameLine({
            functionName: f.functionName,
            url: f.url || scripts.get(f.scriptId) || "",
            line: f.lineNumber,
          }),
        );
    }
    await cdp.send("Debugger.resume").catch(() => {});
    return { js, note: "script was running: its stack" };
  };

  /** Chrome's own timeline for `traceMs`, every process. */
  const trace = async (file: string): Promise<string | null> => {
    if (traceMs <= 0) return null;
    const browser = page.context().browser();
    if (!browser) return null;
    const session = await browser.newBrowserCDPSession();
    const events: unknown[] = [];
    session.on("Tracing.dataCollected", (e: { value: unknown[] }) => {
      events.push(...e.value);
    });
    const done = new Promise<void>((r) =>
      session.once("Tracing.tracingComplete", () => r()),
    );
    try {
      await session.send("Tracing.start", {
        transferMode: "ReportEvents",
        traceConfig: {
          includedCategories: [
            "devtools.timeline",
            "disabled-by-default-devtools.timeline",
            "disabled-by-default-devtools.timeline.frame",
            "toplevel",
            "input",
            "benchmark",
            "blink.user_timing",
            "v8.execute",
            "loading",
            "navigation",
            "disabled-by-default-v8.cpu_profiler",
          ],
        },
      });
      await sleep(traceMs);
      await session.send("Tracing.end");
      await within(done, 15_000);
      writeFileSync(file, JSON.stringify({ traceEvents: events }));
      return file;
    } catch (err) {
      return `trace failed: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      await session.detach().catch(() => {});
    }
  };

  const write = async (reason: string): Promise<string | null> => {
    const n = reports.length + 1;
    const now = Date.now();
    const first = await stack();
    // A second sample a moment later: a loop shows the same frames twice,
    // a single long task does not.
    await sleep(300);
    const second = await stack();
    const recent = await within(
      page.evaluate(() => {
        const log = (
          globalThis as unknown as {
            __pagedWatchdog?: {
              loadCount: number;
              loads: { t: number; src: string }[];
              longTasks: { t: number; ms: number }[];
              frames: { t: number; ms: number; scripts: string[] }[];
            };
          }
        ).__pagedWatchdog;
        const now = performance.now();
        const since = (t: number) => now - t < 10_000;
        return log
          ? {
              iframeLoads10s: log.loads.filter((l) => since(l.t)).length,
              iframeLoadsTotal: log.loadCount,
              longTasks10s: log.longTasks
                .filter((l) => since(l.t))
                .map((l) => Math.round(l.ms)),
              longAnimationFrames10s: log.frames.filter((f) => since(f.t)),
            }
          : null;
      }),
      2000,
    );
    // A waiting mouse action: what is under the pointer, and whether the
    // browser still takes a mouse event there (a second move, from this
    // session, to the same point). One that answers says the waiting
    // action's event was lost, not that input as a whole stopped.
    const aimed = [...pending.values()].find((p) => p.at)?.at;
    const pointer = aimed
      ? {
          at: aimed,
          under: await within(
            page.evaluate(({ x, y }) => {
              const el = document.elementFromPoint(x, y);
              if (!el) return null;
              const data = Object.keys((el as HTMLElement).dataset ?? {});
              return `${el.tagName.toLowerCase()}${data.map((d) => `[data-${d.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}]`).join("")}`;
            }, aimed),
            2000,
          ),
          anotherMoveAnsweredMs: await (async () => {
            const t0 = Date.now();
            const ok = await within(
              cdp
                .send("Input.dispatchMouseEvent", {
                  type: "mouseMoved",
                  x: aimed.x,
                  y: aimed.y,
                })
                .then(() => true)
                .catch(() => false),
              3000,
            );
            return ok ? Date.now() - t0 : null;
          })(),
        }
      : null;
    const traceFile = await trace(join(opts.dir, `stall-${n}.trace.json`));
    const file = join(opts.dir, `stall-${n}.json`);
    writeFileSync(
      file,
      JSON.stringify(
        {
          reason,
          wall: now,
          pending: [...pending.values()].map((p) => ({
            label: p.label,
            waitingMs: now - p.since,
          })),
          pointer,
          probeWaitingMs: probeSince === null ? 0 : now - probeSince,
          stack: first,
          stackAgain: second,
          recent: recent ?? "the page did not answer within two seconds",
          trace: traceFile,
        },
        null,
        2,
      ),
    );
    reports.push(file);
    lastReportAt = Date.now();
    return file;
  };

  const report = (reason: string): Promise<string | null> => {
    if (dumping) return dumping;
    if (reports.length >= maxReports || Date.now() - lastReportAt < stallMs)
      return Promise.resolve(null);
    dumping = write(reason)
      .catch(() => null)
      .finally(() => {
        dumping = null;
      });
    return dumping;
  };

  // The probe: a trivial evaluation on the main thread, one at a time.
  const loop = async () => {
    while (!stopped) {
      probeSince = Date.now();
      const answered = cdp
        .send("Runtime.evaluate", { expression: "0", returnByValue: true })
        .then(() => true)
        .catch(() => true);
      while (!stopped && !(await within(answered, everyMs))) {
        if (probeSince !== null && Date.now() - probeSince > stallMs)
          await report(
            `the main thread did not answer a probe in ${stallMs} ms`,
          );
      }
      probeSince = null;
      const old = [...pending.values()].find(
        (p) => Date.now() - p.since > stallMs,
      );
      if (old)
        await report(`"${old.label}" has waited more than ${stallMs} ms`);
      await sleep(everyMs);
    }
  };
  void loop();

  return {
    async guard<T>(label: string, action: Promise<T>, at?: Point): Promise<T> {
      const id = nextAction++;
      pending.set(id, { label, since: Date.now(), at });
      try {
        return await action;
      } finally {
        pending.delete(id);
      }
    },
    report,
    get reports() {
      return reports;
    },
    async stop() {
      stopped = true;
      await (dumping ?? Promise.resolve());
      await cdp.send("Debugger.disable").catch(() => {});
      await cdp.detach().catch(() => {});
    },
  };
}
