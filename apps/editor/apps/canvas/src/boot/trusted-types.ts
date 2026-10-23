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

// Trusted Types (ADR 240, enforced since ADR 273). The deployed site and the
// dev server send the policy below as an enforced Content-Security-Policy; the app installs the default policy for script URLs before
// anything starts a worker. Pure and dependency-free like network-policy.ts:
// vite.config.ts builds the dev header from it, the shipped `_headers`
// carries the same value (scripts/trusted-types.test.mjs keeps them in
// lock-step).
//
// What it holds:
//   - `require-trusted-types-for 'script'`: a string reaching an HTML,
//     script or script-URL sink (innerHTML, an iframe's srcdoc,
//     `new Function`, `new Worker`) is refused unless it went through a
//     policy. The HTML and script the editor makes on purpose go through
//     named policies (@paged-media/helpers `trustedHtml` / `trustedScript`);
//     a worker's script URL through the default policy below.
//   - enforced, and reported: a refused sink is reported to `REPORT_PATH`
//     (the Pages Function functions/api/csp-report.ts; the dev server's own
//     route). It was report-only until the test suites reported none.

import { MODULE_HOST_ORIGIN } from "./network-policy";

/** Where the browser posts a violation report. */
export const REPORT_PATH = "/api/csp-report";

/** The Trusted Types policy, as the value of a CSP header. */
export const TRUSTED_TYPES_POLICY = `require-trusted-types-for 'script'; report-uri ${REPORT_PATH}`;

/** Whether `url` (as a worker's script URL) is one the editor serves: its
 *  own origin, a blob it made, or the module host. */
export function allowedScriptUrl(url: string, base: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url, base);
  } catch {
    return false;
  }
  const own = new URL(base).origin;
  if (parsed.protocol === "blob:") return parsed.origin === own;
  return parsed.origin === own || parsed.origin === MODULE_HOST_ORIGIN;
}

interface DefaultPolicyFactory {
  createPolicy(
    name: "default",
    rules: {
      createScriptURL: (url: string) => string | null;
      createScript: (source: string) => string | null;
    },
  ): unknown;
  defaultPolicy?: unknown;
}

/**
 * The Trusted Types policy names the editor creates, for a host page that
 * enforces Trusted Types with a `trusted-types` directive (the embedding
 * docs cite this list): the host's directive must allow each of them.
 *
 *   - `default` — installed by the editor once per page, unless the page
 *     already has a default policy (the host's then decides; the editor's
 *     worker and script URLs are the page's origin, a blob it made, or the
 *     module host). Without it, the host's own policy must admit them.
 *   - `paged-code-highlight`, `paged-plugin-glyph`, `paged-demo-script`,
 *     `paged-sheet-grid`, `paged-web-preview` — the named policies of the
 *     places that make markup or script on purpose
 *     (`@paged-media/helpers` trustedHtml / trustedScript), each created
 *     once per page on first use.
 */
export const TRUSTED_TYPES_POLICY_NAMES = [
  "default",
  "paged-code-highlight",
  "paged-plugin-glyph",
  "paged-demo-script",
  "paged-sheet-grid",
  "paged-web-preview",
] as const;

/** The default policy: a worker or a script element given a plain string
 *  (Vite's `new Worker(new URL(…, import.meta.url))`, a module's kernel)
 *  is allowed when the URL is the editor's own; a `new Function` when its
 *  source was built from a body a named policy approved (the playground's,
 *  `isApprovedScript`: the browser hands the default policy the assembled
 *  source, not the trusted arguments). Anything else is refused (and
 *  reported). No HTML passes through it: markup
 *  has named policies. Idempotent. */
export function installDefaultPolicy(
  isApprovedScript: (source: string) => boolean,
): void {
  const tt = (globalThis as { trustedTypes?: DefaultPolicyFactory })
    .trustedTypes;
  // Once per page: a page that already has a default policy (the host's,
  // or a second editor's) keeps it.
  if (!tt || tt.defaultPolicy) return;
  try {
    tt.createPolicy("default", {
      createScriptURL: (url) =>
        allowedScriptUrl(url, globalThis.location.href) ? url : null,
      createScript: (source) => (isApprovedScript(source) ? source : null),
    });
  } catch (err) {
    // The host's `trusted-types` directive does not allow `default`: its
    // own policy decides the editor's script URLs then.
    console.warn(
      "paged editor: the page's Trusted Types do not allow the editor's " +
        "default policy; the host's policy must admit its worker URLs.",
      err,
    );
  }
}
