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

import { afterEach, describe, expect, it } from "bun:test";

import { isApprovedScript, trustedHtml, trustedScript } from "../src/index.ts";

// A stand-in Trusted Types factory: a policy wraps what its rule returns,
// so a test can tell a trusted value from a string.
class Trusted {
  constructor(
    readonly policy: string,
    readonly value: string,
  ) {}
}
const created: string[] = [];
function install(): void {
  (globalThis as { trustedTypes?: unknown }).trustedTypes = {
    createPolicy(
      name: string,
      rules: {
        createHTML?: (s: string) => string;
        createScript?: (s: string) => string;
      },
    ) {
      created.push(name);
      return {
        createHTML: (s: string) => new Trusted(name, rules.createHTML!(s)),
        createScript: (s: string) => new Trusted(name, rules.createScript!(s)),
      };
    },
  };
}

afterEach(() => {
  delete (globalThis as { trustedTypes?: unknown }).trustedTypes;
});

describe("trustedHtml / trustedScript", () => {
  it("without Trusted Types, the sanitized string itself", () => {
    expect(trustedHtml("t-a", (s) => s.toUpperCase(), "<b>x</b>")).toBe(
      "<B>X</B>",
    );
    expect(trustedScript("t-a", "1 + 1")).toBe("1 + 1");
  });

  it("with Trusted Types, the policy runs the call's own sanitizer and returns a trusted value", () => {
    install();
    const a = trustedHtml(
      "t-b",
      (s) => s.replace("<script>", ""),
      "<i>a</i><script>",
    ) as unknown as Trusted;
    const b = trustedHtml("t-b", (s) => `[${s}]`, "x") as unknown as Trusted;
    expect(a).toBeInstanceOf(Trusted);
    expect(a.value).toBe("<i>a</i>");
    // The second call's sanitizer, not the first's: one policy per name.
    expect(b.value).toBe("[x]");
    expect(created.filter((n) => n === "t-b")).toHaveLength(1);
    const s = trustedScript("t-c", "return 1") as unknown as Trusted;
    expect(s).toBeInstanceOf(Trusted);
    expect(s.value).toBe("return 1");
  });

  it("a Function source built from an approved body is approved, another is not", () => {
    trustedScript("t-d", "await paged.ping();");
    expect(isApprovedScript("(paged\n) {\nawait paged.ping();\n}")).toBe(true);
    expect(isApprovedScript("(x\n) {\nfetch('//evil')\n}")).toBe(false);
  });
});
