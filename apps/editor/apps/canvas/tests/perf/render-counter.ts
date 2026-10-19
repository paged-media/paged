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

// The render counter of the React Compiler measurements (ADR 228,
// docs/migration/react-compiler.md). It stands in for React DevTools: it
// installs `__REACT_DEVTOOLS_GLOBAL_HOOK__` before React loads, and React
// DOM (development AND production builds) reports every commit to it. For
// each commit it walks what was rendered the way DevTools does
// (`PerformedWork` on the components a commit actually called; a subtree
// whose child pointer did not change was skipped), and it records:
//
//   - commits, and component renders (function, class, forwardRef, memo);
//   - per component name (minified in a production build);
//   - how many of the mounted function components carry a compiler cache
//     (`updateQueue.memoCache`, the "Memo ✨" badge DevTools draws).
//
// `installRenderCounter` is self-contained (no imports, no closure over this
// module), so Playwright can ship it as an init script; the DOM lane's
// preload calls it directly.

export interface RenderCounts {
  commits: number;
  /** Component renders, everywhere. */
  renders: number;
  /** Component renders inside the scope (`setScope`), or all of them. */
  scoped: number;
  /** `performance.now()` of each commit since the last reset. */
  commitTimes: number[];
  byName: Record<string, number>;
}

export interface MemoCensus {
  /** Mounted function components (incl. forwardRef and memo). */
  functionComponents: number;
  /** Of those, the ones with a React Compiler cache. */
  compiled: number;
  /** Compiled share per component name. */
  byName: Record<string, { mounted: number; compiled: number }>;
}

export interface RenderCounter {
  reset(): void;
  /** Count `scoped` renders only inside components of these types (the
   *  panel under test), so the shell's own churn stays out. */
  setScope(types: readonly unknown[] | null): void;
  counts(): RenderCounts;
  census(): MemoCensus;
}

export function installRenderCounter(target: object): void {
  const g = target as {
    __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown;
    __pagedRenderCounter?: unknown;
  };
  if (g.__pagedRenderCounter) return;
  // Fiber tags (react-reconciler/src/ReactWorkTags) and flags.
  const FUNCTION = 0;
  const CLASS = 1;
  const FORWARD_REF = 11;
  const MEMO = 14;
  const SIMPLE_MEMO = 15;
  const PERFORMED_WORK = 1;
  const COMPONENT_TAGS = new Set([
    FUNCTION,
    CLASS,
    FORWARD_REF,
    MEMO,
    SIMPLE_MEMO,
  ]);
  const FUNCTION_TAGS = new Set([FUNCTION, FORWARD_REF, SIMPLE_MEMO]);

  type Fiber = {
    tag: number;
    type: unknown;
    elementType: unknown;
    flags: number;
    child: Fiber | null;
    sibling: Fiber | null;
    alternate: Fiber | null;
    updateQueue: { memoCache?: unknown } | null;
  };

  let commits = 0;
  let renders = 0;
  let scoped = 0;
  let scope: Set<unknown> | null = null;
  let byName: Record<string, number> = {};
  let commitTimes: number[] = [];
  const roots = new Set<{ current: Fiber }>();

  const nameOf = (fiber: Fiber): string => {
    let t = fiber.type as
      | {
          displayName?: string;
          name?: string;
          render?: unknown;
          type?: unknown;
        }
      | string
      | null;
    if (fiber.tag === FORWARD_REF && t && typeof t === "object") {
      t = (t.render ?? t) as typeof t;
    }
    if (fiber.tag === MEMO && t && typeof t === "object") {
      t = (t.type ?? t) as typeof t;
    }
    if (typeof t === "function" || (t && typeof t === "object")) {
      const named = t as { displayName?: string; name?: string };
      return named.displayName || named.name || "(anonymous)";
    }
    return String(t);
  };

  const inScope = (fiber: Fiber, outer: boolean) =>
    outer ||
    scope === null ||
    scope.has(fiber.type) ||
    scope.has(fiber.elementType);

  const count = (fiber: Fiber, within: boolean) => {
    renders += 1;
    if (within) scoped += 1;
    const name = nameOf(fiber);
    byName[name] = (byName[name] ?? 0) + 1;
  };

  const mount = (fiber: Fiber | null, outer: boolean) => {
    for (let f = fiber; f; f = f.sibling) {
      const within = inScope(f, outer);
      if (COMPONENT_TAGS.has(f.tag)) count(f, within);
      mount(f.child, within);
    }
  };

  const update = (next: Fiber, prev: Fiber, outer: boolean) => {
    const within = inScope(next, outer);
    if (COMPONENT_TAGS.has(next.tag) && (next.flags & PERFORMED_WORK) !== 0) {
      count(next, within);
    }
    if (next.child === prev.child) return; // the subtree bailed out
    for (let c = next.child; c; c = c.sibling) {
      if (c.alternate) update(c, c.alternate, within);
      else {
        const cw = inScope(c, within);
        if (COMPONENT_TAGS.has(c.tag)) count(c, cw);
        mount(c.child, cw);
      }
    }
  };

  let nextId = 1;
  const hook = {
    supportsFiber: true,
    renderers: new Map<number, unknown>(),
    inject(renderer: unknown) {
      const id = nextId++;
      hook.renderers.set(id, renderer);
      return id;
    },
    checkDCE() {},
    onScheduleFiberRoot() {},
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    onCommitFiberRoot(_id: number, root: { current: Fiber }) {
      roots.add(root);
      commits += 1;
      commitTimes.push(performance.now());
      const current = root.current;
      const prev = current.alternate;
      if (prev) update(current, prev, false);
      else mount(current.child, false);
    },
  };
  g.__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook;

  const census = () => {
    let functionComponents = 0;
    let compiled = 0;
    const perName: Record<string, { mounted: number; compiled: number }> = {};
    const walk = (fiber: Fiber | null) => {
      for (let f = fiber; f; f = f.sibling) {
        if (FUNCTION_TAGS.has(f.tag)) {
          functionComponents += 1;
          const has = f.updateQueue != null && f.updateQueue.memoCache != null;
          if (has) compiled += 1;
          const name = nameOf(f);
          const entry = (perName[name] ??= { mounted: 0, compiled: 0 });
          entry.mounted += 1;
          if (has) entry.compiled += 1;
        }
        walk(f.child);
      }
    };
    for (const root of roots) walk(root.current.child);
    return { functionComponents, compiled, byName: perName };
  };

  g.__pagedRenderCounter = {
    reset() {
      commits = 0;
      renders = 0;
      scoped = 0;
      byName = {};
      commitTimes = [];
    },
    setScope(types) {
      scope = types ? new Set(types) : null;
    },
    counts() {
      return {
        commits,
        renders,
        scoped,
        commitTimes: [...commitTimes],
        byName: { ...byName },
      };
    },
    census,
  } satisfies RenderCounter;
}
