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

// The shared mount for the React-panel specs.
//
// WHAT A PANEL NEEDS, read off `src/activate.ts`: nothing but a host. A
// panel is `host.contribute.panel({ id, icon, ...makeXPanel(host) })`; the
// factory closes over the `BundleHost`, and the component it returns
// ignores its `PanelProps` (`paged` + `api`) entirely — there is no
// context provider and no host renderer in between. So a spec can mount
// EITHER the component the bundle really contributed (`mountContributed`,
// which proves the activate wiring) OR a fresh one built over a counting
// host (`mountPanel`, which is what a budget needs: a bundle activated
// through `h.loadBundle` holds the UNWRAPPED host, so the contributed
// component's reads are invisible to `countingHost`).
//
// THE ENVIRONMENT. Every `.spec.tsx` in this folder carries the docblock
// `@vitest-environment jsdom` right under its license header — per file,
// no vitest config. The engine wasm boots inside that environment
// unchanged (measured, protocol 64): the test still runs in Node, with
// Node's own `fs`, `WebAssembly` and typed arrays beside the DOM globals
// jsdom installs, and the headless harness reads the wasm off disk
// rather than fetching it. No workaround was needed, so there is none
// here — `openHost()` is called in a plain `beforeAll`. The two
// binding-driver specs (`*.spec.ts`) render nothing and stay in the
// default Node environment.
//
// THE CLOCK. The headless engine answers synchronously, so a reload is a
// chain of MICROTASKS: one macrotask turn drains every reload in flight,
// however many overlap. `settle()` does not trust that (`quiesce` waits
// for the counted work to stop moving), and it runs inside React's `act`
// so the state the reloads set is on screen when it returns. A panel on
// the shared scheduler (`src/panels/reload.ts`) STARTS its reload one
// macrotask after the request, which the same wait covers.
//
// THREE COUNTERS, and they measure different things:
//   · `work`    — `countingHost`: door calls the PANEL made.
//   · `events`  — how many times the host DELIVERED a selection / document
//     event to the panel's host. Before the scheduler every panel's
//     listener was `() => void reload()`, so a delivery WAS a reload and
//     this number was reported as one. It no longer is: twenty deliveries
//     are one reload now, and the two are reported side by side.
//   · `reloads` — the reloads the panel STARTED, counted at the journal
//     door (`usePanelReload` records one entry per started reload).
//     Exact, and it includes the mount's own reload and a button's, which
//     the event count never did. Reported only for a panel that is on the
//     scheduler — an unconverted one records nothing, and "0 reloads"
//     would be a false statement about it.
// Everything a spec does to the document goes through the RAW `h.host`,
// so only the panel's own work is counted.

import type {
  BundleHost,
  Disposable,
  DocumentChangeEvent,
  ElementId,
  PanelProps,
} from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type * as React from "react";

import { countingHost, type WorkLog } from "../perf/counting-host";
import {
  documentChanges,
  plainChange,
  quiesce,
  selectionChanges,
} from "./panel-document";

export * from "./panel-document";

// --------------------------------------------------------------- the events

export interface EventLog {
  /** `selection.onDidChange` deliveries to the panel. */
  selection: number;
  /** `document.onDidChange` deliveries to the panel. */
  document: number;
}

/** Replace one member of a facade without copying the rest (a spread
 *  would snapshot getters and unbind `this`). */
function override<T extends object>(target: T, key: string, value: unknown): T {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      return prop === key ? value : (Reflect.get(obj, prop, receiver) as unknown);
    },
  });
}

/** Count the events the host DELIVERS to whoever subscribes through the
 *  returned host. The subscription itself is untouched. */
export function tapEvents(host: BundleHost): {
  host: BundleHost;
  events: EventLog;
} {
  const events: EventLog = { selection: 0, document: 0 };
  const selection = override(
    host.selection,
    "onDidChange",
    (listener: (ids: ElementId[]) => void): Disposable =>
      host.selection.onDidChange((ids) => {
        events.selection += 1;
        listener(ids);
      }),
  );
  const document = override(
    host.document,
    "onDidChange",
    (listener: (e: DocumentChangeEvent) => void): Disposable =>
      host.document.onDidChange((e) => {
        events.document += 1;
        listener(e);
      }),
  );
  return {
    host: override(override(host, "selection", selection), "document", document),
    events,
  };
}

/**
 * A view of `host` whose RECIPE WRITES take a task to land — the ordering
 * the editor has and the headless engine does not. There, every door is a
 * worker round trip, so the reload a command's batch requested starts
 * (and reads the recipe part) while the command's own `parts.write` is
 * still out. Here the engine answers synchronously and the whole command
 * finishes first, which hides exactly the bug a late recipe write causes.
 * Hand this to the COMMAND under test; the panel stays on its own host.
 */
export function slowRecipeWrites(host: BundleHost): BundleHost {
  const parts = override(
    host.parts,
    "write",
    async (path: string, bytes: Uint8Array): Promise<void> => {
      await new Promise((r) => setTimeout(r, 0));
      await host.parts.write(path, bytes);
    },
  );
  return override(host, "parts", parts);
}

// ----------------------------------------------------------------- the clock

/** Let every reload in flight land, and put what it set on screen. */
export async function settle(work?: WorkLog): Promise<void> {
  await act(async () => {
    await quiesce(work);
  });
}

/** Run `fn` — anything that changes the document or the selection through
 *  the RAW host — inside `act`, then settle. */
export async function drive(
  fn: () => Promise<unknown> | unknown,
  work?: WorkLog,
): Promise<void> {
  await act(async () => {
    await fn();
  });
  await settle(work);
}

// ----------------------------------------------------------------- the mount

/** What every `make*Panel` factory returns. */
export type PanelFactory = (host: BundleHost) => {
  title: string;
  component: React.ComponentType<PanelProps>;
  defaultDock: "right";
};

/** What one stretch of panel work cost, counted at the host doors. */
export interface ReloadCost {
  /** Selection + document events the host DELIVERED to the panel's host.
   *  What the panel was told, not what it did about it. */
  events: number;
  /** Reloads the panel STARTED (journal entries — see the header). The
   *  mount's own reload is one of them. Absent for a panel that is not
   *  on the shared scheduler yet. */
  reloads?: number;
  /** `document.tree()` calls. A walk is one of these plus one read per
   *  leaf, so this is how many times the panel walked the document. */
  walks: number;
  /** Engine round trips spent READING the document (`WorkLog.reads()`). */
  reads: number;
  /** `.paged` container-part reads. Not a `document.*` door, so not in
   *  `reads` — but each is an engine round trip all the same. */
  partReads: number;
}

export interface MountedPanel {
  /** The element the panel rendered into. */
  container: HTMLElement;
  /** Door calls the PANEL made (its own host, nothing else). */
  work: WorkLog;
  /** Host events delivered to the panel. */
  events: EventLog;
  /** Forget every count (the panel keeps its state). */
  reset(): void;
  /** The counts as they stand since the mount or the last `reset()`. */
  cost(): ReloadCost;
  /** Reset, run `fn` against the raw host, settle, and report what the
   *  panel did in response. */
  costOf(fn: () => Promise<unknown> | unknown): Promise<ReloadCost>;
  /** The first element matching `selector`; throws when there is none. */
  get<T extends HTMLElement = HTMLElement>(selector: string): T;
  /** Every element matching `selector`. */
  all(selector: string): HTMLElement[];
  /** How many elements match `selector` (a number fails cheaply; a list
   *  of elements makes vitest pretty-print the DOM). */
  count(selector: string): number;
  /** One attribute of the first element matching `selector`. */
  attr(selector: string, name: string): string | null;
  /** Whether the button matching `selector` is disabled. */
  disabled(selector: string): boolean;
  /** Click the first element matching `selector`, then settle. */
  click(selector: string): Promise<void>;
  /** Set a form control's value (an `<input>` or a `<select>`). */
  change(selector: string, value: string): void;
  /** The panel's text, whitespace collapsed. */
  text(): string;
  unmount(): void;
}

function mounted(
  Component: React.ComponentType<PanelProps>,
  id: string,
  work: WorkLog,
  events: EventLog,
): MountedPanel {
  // The props the host passes (`PanelProps`). No panel in this bundle
  // reads either — `paged` is the editor handle a panel is meant to leave
  // alone in favour of its `BundleHost` — so `null` is the honest value.
  const view = render(<Component paged={null} api={{ id }} />);
  const get = <T extends HTMLElement = HTMLElement>(selector: string): T => {
    const el = view.container.querySelector<T>(selector);
    if (!el) throw new Error(`panel ${id}: nothing matches ${selector}`);
    return el;
  };
  /** Is this panel on the shared scheduler? Every panel reloads when it
   *  mounts, and the scheduler journals every reload it starts — so one
   *  entry, ever, answers it. Looked at before each reset, so the mount
   *  reload is seen whatever the spec does first. */
  let journals = false;
  const started = (): number => {
    const count = work.count("journal.record");
    if (count > 0) journals = true;
    return count;
  };
  const reset = (): void => {
    started();
    work.reset();
    events.selection = 0;
    events.document = 0;
  };
  const cost = (): ReloadCost => {
    const reloads = started();
    return {
      events: events.selection + events.document,
      ...(journals ? { reloads } : {}),
      walks: work.count("document.tree"),
      reads: work.reads(),
      partReads: work.count("parts.read"),
    };
  };
  return {
    container: view.container,
    work,
    events,
    reset,
    cost,
    costOf: async (fn) => {
      reset();
      await drive(fn, work);
      return cost();
    },
    get,
    all: (selector) =>
      Array.from(view.container.querySelectorAll<HTMLElement>(selector)),
    count: (selector) => view.container.querySelectorAll(selector).length,
    attr: (selector, name) => get(selector).getAttribute(name),
    disabled: (selector) => get<HTMLButtonElement>(selector).disabled,
    click: async (selector) => {
      const el = get<HTMLButtonElement>(selector);
      if (el.disabled) throw new Error(`panel ${id}: ${selector} is disabled`);
      act(() => {
        fireEvent.click(el);
      });
      await settle(work);
    },
    change: (selector, value) => {
      const el = get(selector);
      act(() => {
        fireEvent.change(el, { target: { value } });
      });
    },
    text: () => (view.container.textContent ?? "").replace(/\s+/g, " ").trim(),
    unmount: () => view.unmount(),
  };
}

/**
 * Mount a FRESH panel over a counting, event-tapped view of the real
 * headless host, and wait for its mount reload to land. `work` then
 * holds that first reload; `reset()` / `costOf()` measure something else.
 */
export async function mountPanel(
  h: HeadlessHost,
  make: PanelFactory,
  id = "panel-under-test",
): Promise<MountedPanel> {
  const tapped = tapEvents(h.host);
  const counted = countingHost(tapped.host);
  const panel = mounted(
    make(counted.host).component,
    id,
    counted.work,
    tapped.events,
  );
  await settle(counted.work);
  return panel;
}

/**
 * Mount the component the BUNDLE contributed under `id` — the one the
 * editor would mount. Its host is the bundle's own, so nothing is
 * counted (`work` stays empty): use it to prove the wiring, not a budget.
 */
export async function mountContributed(
  h: HeadlessHost,
  id: string,
): Promise<MountedPanel> {
  const contributed = h.panelsContributed().find((p) => p.id === id);
  if (!contributed) throw new Error(`the bundle contributed no panel ${id}`);
  const idle = countingHost(h.host);
  const panel = mounted(contributed.component, id, idle.work, {
    selection: 0,
    document: 0,
  });
  await settle();
  return panel;
}

/** Unmount whatever is mounted. The suite runs without vitest globals,
 *  so Testing Library's automatic cleanup never registers itself. */
export function unmountAll(): void {
  cleanup();
}

/**
 * The `afterEach` of every describe that mounts a panel: unmount, THEN
 * clear the selection — in that order, so the clear starts no reload in
 * a panel that is about to go away, and the next test starts from
 * "nothing selected" whatever this one left behind.
 */
export async function teardownPanels(h: HeadlessHost | undefined): Promise<void> {
  cleanup();
  await h?.host.selection.set([]);
}

// ---------------------------------------------------------------- the bursts

/** What the panel does in response to BURST back-to-back document
 *  changes that touch no record. */
export function documentBurst(
  h: HeadlessHost,
  panel: MountedPanel,
): Promise<ReloadCost> {
  return panel.costOf(() => documentChanges(h));
}

/** What the panel does in response to BURST back-to-back selection
 *  changes, each to a different plain leaf. */
export function selectionBurst(
  h: HeadlessHost,
  panel: MountedPanel,
): Promise<ReloadCost> {
  return panel.costOf(() => selectionChanges(h));
}

/**
 * The out-of-order pair: start a reload with NOTHING selected, let it
 * get as far as its first document walk (it has read the selection by
 * then), and only then select `ids` — which starts a second reload while
 * the first is still walking.
 *
 * HOW THE WINDOW IS MADE. The engine answers synchronously, so a reload
 * is one unbroken chain of microtasks and nothing a spec does from
 * outside can land "inside the walk". The walk's own `document.tree()`
 * read is therefore held open: the FIRST one after the change selects
 * `ids` and then yields a macrotask before it answers — long enough for
 * a reload the selection requested to start (a panel on the shared
 * scheduler starts one a task later; an unscheduled one starts it inside
 * the event). In the editor the same window is the walk's wall-clock
 * duration. The read is put back whatever happens.
 */
export async function selectDuringWalk(
  h: HeadlessHost,
  panel: MountedPanel,
  ids: ElementId[],
): Promise<void> {
  panel.reset();
  const document = h.host.document as {
    tree: HeadlessHost["host"]["document"]["tree"];
  };
  const tree = document.tree;
  let walked = false;
  document.tree = async function heldOpen(this: unknown) {
    const roots = await tree.call(this);
    if (!walked) {
      walked = true;
      await h.host.selection.set(ids);
      await new Promise((r) => setTimeout(r, 0));
    }
    return roots;
  };
  try {
    await drive(() => plainChange(h, 1), panel.work);
  } finally {
    document.tree = tree;
  }
  if (!walked) throw new Error("the first reload never reached its walk");
}
