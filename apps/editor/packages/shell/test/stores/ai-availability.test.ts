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

// The AI service probe behind the ask affordances (UX audit F-25,
// findings PN-352 and PN-355): 503 or no proxy at all is "unavailable",
// any other answer is a proxy that serves the editor.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  getAiAvailability,
  probeAiService,
  resetAiAvailability,
  setAiAvailability,
} from "../../src/ai/availability";

const realFetch = globalThis.fetch;
const realWindow = (globalThis as { window?: unknown }).window;

function answer(respond: (url: string) => Promise<Response>): string[] {
  const urls: string[] = [];
  globalThis.fetch = ((url: string) => {
    urls.push(String(url));
    return respond(String(url));
  }) as typeof fetch;
  return urls;
}

beforeEach(() => {
  (globalThis as { window?: unknown }).window = {
    location: { origin: "https://editor.example" },
  };
  resetAiAvailability();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  (globalThis as { window?: unknown }).window = realWindow;
  resetAiAvailability();
});

describe("probeAiService", () => {
  test("a 503 from the proxy is no AI service", async () => {
    const urls = answer(async () => new Response("", { status: 503 }));
    expect(await probeAiService()).toBe("unavailable");
    expect(getAiAvailability()).toBe("unavailable");
    expect(urls).toEqual(["https://editor.example/api/ai/v1/messages"]);
  });

  test("no proxy at all (the fetch fails) is no AI service", async () => {
    answer(async () => {
      throw new TypeError("connection refused");
    });
    expect(await probeAiService()).toBe("unavailable");
  });

  test("any other answer (a bare GET refused as not same-origin) is a proxy", async () => {
    answer(async () => new Response("", { status: 403 }));
    expect(await probeAiService()).toBe("available");
  });

  test("one probe per session; a host's answer stands", async () => {
    const urls = answer(async () => new Response("", { status: 503 }));
    await probeAiService();
    await probeAiService();
    expect(urls).toHaveLength(1);
    setAiAvailability("available");
    expect(await probeAiService()).toBe("available");
    expect(urls).toHaveLength(1);
  });
});
