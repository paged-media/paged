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

// react-optional — the ONE place plugin-sdk touches React. Internal:
// deliberately NOT re-exported from index.ts (the barrel exports the two
// consumers, `FALLBACK_WIDGETS` and `makeSchemaPanelComponent`; how they
// get `createElement` is not contract surface).
//
// Two breakages shaped this module, and both must stay fixed:
//
// 1. React is an OPTIONAL peer (`peerDependenciesMeta`) and has to be
//    optional at RUNTIME, not just in the manifest. index.ts re-exports
//    host-impl, which imports BOTH React-touching modules
//    (widgets-fallback for the fallback widget catalog, schema-panel for
//    the synthesized panel component). So a STATIC `import … from
//    "react"` anywhere down here makes `import { loadBundle }` — the
//    React-free loader path — fail with ERR_MODULE_NOT_FOUND wherever
//    React is not installed. That is what silently broke all 22 of
//    plugin-draw's test files against the published canary (a
//    host-agnostic repo that has no business installing React).
//
// 2. The first fix for (1) resolved React with a TOP-LEVEL
//    `await import("react")`. The bundler emits that verbatim, and Vite's
//    dep-optimizer compiles pre-bundled dependencies down to its ES2020
//    floor ("chrome87", "edge88", "es2020", "firefox78", "safari14"),
//    where top-level await does not exist — so pre-bundling the
//    published package fails the consuming dev server outright
//    ("Top-level await is not available in the configured target
//    environment"). The editor had to carry an `optimizeDeps.exclude`
//    entry just to boot. Found during ADR-023 phase C.
//
// The shape that keeps BOTH properties: kick the dynamic import off at
// module scope but DO NOT await it. Module evaluation stays synchronous
// — no async module, no top-level await in the emitted bundle — and the
// render paths read the resolved value SYNCHRONOUSLY from this cache.
//
// Why that is enough, stated rather than assumed: the only code that
// needs `createElement` is a React component body, reached only inside a
// React host, where the app imported React long before it loaded a
// plugin. `import()` of an already-instantiated module settles on a
// microtask queued at CALL time — i.e. during this module's evaluation,
// before any continuation of the code that imported the barrel, and many
// turns before React renders a plugin panel. If a render somehow does
// beat it, `requireCreateElement` throws a NAMED seam saying exactly
// that (the brand-honesty rule: a visible seam, never fake UI, never a
// half-real element hand-built from React's internal symbols).
//
// The declaration build compiles at `"module": "ES2020"` (the same floor
// Vite's dep-optimizer uses; tsconfig.build.json), where TypeScript refuses
// a top-level await (TS1378), so a future one fails OUR build loudly
// instead of a consumer's dev server silently. Do not raise it without
// reading this.

export type CreateElement = typeof import("react").createElement;

let createElement: CreateElement | null = null;
let state: "pending" | "ready" | "absent" = "pending";

// Deliberately floating — awaiting it here is exactly breakage (2).
void import("react").then(
  (react) => {
    createElement = react.createElement;
    state = "ready";
  },
  () => {
    // React-free consumer (headless tests, Node-side conformance, a
    // host-agnostic plugin repo's unit-test run). The render paths that
    // call `requireCreateElement` are never reached there.
    state = "absent";
  },
);

/**
 * React's `createElement` for a render path that cannot proceed without
 * it. `absent` is the message for the real case — React is not installed
 * — and carries the caller's own remedy; the pending case appends why it
 * failed instead of pretending it is the same thing.
 */
export function requireCreateElement(absent: string): CreateElement {
  if (createElement) return createElement;
  throw new Error(
    state === "pending"
      ? `${absent} (React had not finished resolving when this rendered.)`
      : absent,
  );
}
