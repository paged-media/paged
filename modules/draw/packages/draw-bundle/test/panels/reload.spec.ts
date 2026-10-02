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

// `createReloader` — the scheduler every panel and both binding drivers
// share (`src/panels/reload.ts`), on its own: no engine, no React.
//
// The render specs beside this one prove the panels END on the right
// state. They cannot prove WHY: the headless engine answers
// synchronously, every reload does the same reads through one shared
// index, and so two overlapping reloads land in the order they started
// whether or not anything enforces it. Here the reloads are promises the
// spec resolves by hand, in the order that used to go wrong.

import { describe, expect, it } from "vitest";

import type { BundleHost, ElementId } from "@paged-media/plugin-api";

import { createReloader, type ReloadContext } from "../../src/panels/reload";

const turn = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const id = (name: string): ElementId =>
  ({ kind: "polygon", id: name }) as ElementId;

/** The two doors the scheduler touches. */
function fakeHost(selection: ElementId[] = []) {
  const warnings: string[] = [];
  let reads = 0;
  const host = {
    selection: {
      get: () => {
        reads += 1;
        return selection;
      },
    },
    log: { warn: (message: string) => void warnings.push(message) },
  } as unknown as Pick<BundleHost, "selection" | "log">;
  return { host, warnings, selectionReads: () => reads };
}

/** A reload the spec finishes by hand. */
function manual() {
  const runs: {
    context: ReloadContext;
    finish(): void;
  }[] = [];
  const shown: string[] = [];
  const reload = (context: ReloadContext): Promise<void> =>
    new Promise<void>((resolve) => {
      const label = `run ${runs.length + 1}`;
      runs.push({
        context,
        finish: () => {
          // What every panel does: ask, then show.
          if (context.live()) shown.push(label);
          resolve();
        },
      });
    });
  return { reload, runs, shown };
}

describe("createReloader — when a panel reloads", () => {
  it("COALESCES: any number of requests before the next task are one reload", async () => {
    const { host } = fakeHost();
    const { reload, runs } = manual();
    const reloader = createReloader(host, "spec", reload);

    for (let i = 0; i < 20; i++) reloader.request();
    // Nothing has started yet: the reload is the NEXT task's.
    expect(runs).toHaveLength(0);
    await turn();
    expect(runs).toHaveLength(1);

    // A request made across microtasks — awaited work in between, as a
    // burst of awaited mutations is — is still the same reload.
    for (let i = 0; i < 20; i++) {
      reloader.request();
      await Promise.resolve();
    }
    await turn();
    expect(runs).toHaveLength(2);
    reloader.dispose();
  });

  it("a request in a LATER task is a new reload", async () => {
    const { host } = fakeHost();
    const { reload, runs } = manual();
    const reloader = createReloader(host, "spec", reload);
    reloader.request();
    await turn();
    reloader.request();
    await turn();
    reloader.request();
    await turn();
    expect(runs).toHaveLength(3);
    reloader.dispose();
  });

  it("THE LAST RELOAD TO START WINS, whichever finishes last", async () => {
    const { host } = fakeHost();
    const { reload, runs, shown } = manual();
    const reloader = createReloader(host, "spec", reload);

    reloader.request();
    await turn();
    reloader.request();
    await turn();
    expect(runs).toHaveLength(2);
    // Both are in flight; only the newer one is live.
    expect(runs[0]!.context.live()).toBe(false);
    expect(runs[1]!.context.live()).toBe(true);

    // The NEWER one finishes first and the OLDER one after it — the
    // order that used to leave the older answer on screen.
    runs[1]!.finish();
    runs[0]!.finish();
    await turn();
    expect(shown).toEqual(["run 2"]);
    reloader.dispose();
  });

  it("an older reload that finishes FIRST shows nothing either", async () => {
    const { host } = fakeHost();
    const { reload, runs, shown } = manual();
    const reloader = createReloader(host, "spec", reload);
    reloader.request();
    await turn();
    reloader.request();
    await turn();
    runs[0]!.finish();
    expect(shown).toEqual([]);
    runs[1]!.finish();
    expect(shown).toEqual(["run 2"]);
    reloader.dispose();
  });

  it("hands the reload the selection the EVENT carried, not a re-read", async () => {
    const stale = [id("stale")];
    const { host, selectionReads } = fakeHost(stale);
    const { reload, runs } = manual();
    const reloader = createReloader(host, "spec", reload);

    // Before any event the host is the only source.
    reloader.request();
    await turn();
    expect(runs[0]!.context.selection).toEqual(stale);
    expect(selectionReads()).toBe(1);

    // A selection event hands its ids over; `selection.get()` still
    // answers the previous selection at that moment (the SDK adapter
    // stores the new one AFTER its subscribers ran), and is not asked.
    reloader.request([id("a")]);
    reloader.request([id("b")]);
    await turn();
    expect(runs[1]!.context.selection).toEqual([id("b")]);
    expect(selectionReads()).toBe(1);

    // A request with no selection of its own (a document change) keeps
    // the last one handed over.
    reloader.request();
    await turn();
    expect(runs[2]!.context.selection).toEqual([id("b")]);
    expect(selectionReads()).toBe(1);
    reloader.dispose();
  });

  it("now() runs at once, and takes the place of a pending request", async () => {
    const { host } = fakeHost();
    const { reload, runs } = manual();
    const reloader = createReloader(host, "spec", reload);
    reloader.request();
    reloader.now();
    expect(runs).toHaveLength(1);
    await turn();
    expect(runs).toHaveLength(1);
    reloader.dispose();
  });

  it("dispose: a pending reload never starts, and one in flight stops being live", async () => {
    const { host } = fakeHost();
    const { reload, runs, shown } = manual();
    const reloader = createReloader(host, "spec", reload);
    reloader.request();
    await turn();
    reloader.request();
    reloader.dispose();
    await turn();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.context.live()).toBe(false);
    runs[0]!.finish();
    expect(shown).toEqual([]);
    // …and it stays stopped.
    reloader.request();
    await turn();
    expect(runs).toHaveLength(1);
  });

  it("a reload that throws is logged and does not stop the next one", async () => {
    const { host, warnings } = fakeHost();
    let calls = 0;
    const reloader = createReloader(host, "spec", async () => {
      calls += 1;
      if (calls === 1) throw new Error("boom");
    });
    reloader.request();
    await turn();
    expect(warnings).toEqual(["spec: reload failed (Error: boom)"]);
    reloader.request();
    await turn();
    expect(calls).toBe(2);
    reloader.dispose();
  });
});
