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

// Trusted Types (apps/editor ADR 240). The editor's deployed site requires
// them for script (`require-trusted-types-for 'script'`): a string reaching
// an HTML, script or script-URL sink (innerHTML, an iframe's srcdoc,
// `new Function`, `new Worker`) is refused unless it went through a
// policy. These are the editor's policies, one per place that makes markup
// or script on purpose, each with the function that makes it safe.
//
// What a policy returns is a TrustedHTML / TrustedScript object where the
// browser has Trusted Types and the string itself where it does not. Hand
// it straight to the sink (React 19.3 passes it to `innerHTML` and to
// attributes intact); concatenating it makes a plain, untrusted string
// again.

interface Policy {
  createHTML?(input: string): unknown;
  createScript?(input: string): unknown;
}

interface Factory {
  createPolicy(
    name: string,
    rules: {
      createHTML?: (input: string) => string;
      createScript?: (input: string) => string;
    },
  ): Policy;
}

function factory(): Factory | null {
  const tt = (globalThis as { trustedTypes?: Factory }).trustedTypes;
  return tt && typeof tt.createPolicy === "function" ? tt : null;
}

interface Slot {
  policy: Policy;
  /** The transform of the call in progress: a policy's rules are fixed at
   *  creation, the sanitizer of a call (a highlighter for one language,
   *  say) is not. */
  run: ((input: string) => string) | null;
}

const slots = new Map<string, Slot>();

function slotOf(name: string): Slot | null {
  const tt = factory();
  if (!tt) return null;
  let slot = slots.get(name);
  if (!slot) {
    const created: Slot = { policy: {}, run: null };
    const through = (input: string): string => {
      if (!created.run) throw new TypeError(`${name}: no transform`);
      return created.run(input);
    };
    created.policy = tt.createPolicy(name, {
      createHTML: through,
      createScript: through,
    });
    slot = created;
    slots.set(name, slot);
  }
  return slot;
}

function through<T>(
  name: string,
  transform: (input: string) => string,
  input: string,
  make: (policy: Policy, input: string) => unknown,
): T {
  const slot = slotOf(name);
  if (!slot) return transform(input) as T;
  slot.run = transform;
  try {
    return make(slot.policy, input) as T;
  } finally {
    slot.run = null;
  }
}

/** `markup` as trusted HTML of the policy `name`, which runs `sanitize` on
 *  it: the one place this markup is made safe. Typed as a string so it
 *  fits every sink's type; it is an opaque TrustedHTML where the browser
 *  has Trusted Types. */
export function trustedHtml(
  name: string,
  sanitize: (markup: string) => string,
  markup: string,
): string {
  return through<string>(name, sanitize, markup, (p, m) => p.createHTML?.(m));
}

/** Script bodies a policy made trusted, for the default policy to admit
 *  when the browser hands it the whole source of a `new Function` (it does
 *  not take TrustedScript arguments as trusted: the Function constructor
 *  assembles a new string from them). */
const approvedScripts = new Set<string>();

/** `source` as a trusted script of the policy `name`: for code the user or
 *  the app runs on purpose (a playground script). Opaque, like
 *  `trustedHtml`'s result. The source is also remembered for
 *  `isApprovedScript`. */
export function trustedScript(name: string, source: string): string {
  approvedScripts.add(source);
  return through<string>(
    name,
    (s) => s,
    source,
    (p, s) => p.createScript?.(s),
  );
}

/** Whether `assembled` (the source a `new Function` compiles: its
 *  parameters and body) was built from a body `trustedScript` approved. */
export function isApprovedScript(assembled: string): boolean {
  for (const body of approvedScripts) {
    if (body.length > 0 && assembled.includes(body)) return true;
  }
  return false;
}
