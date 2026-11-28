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

// The CLI presents paged-ml-host's access token (apps/ml-host): from the
// environment or the host's token file, and only to the host itself.

import { describe, expect, it } from "bun:test";

import { mlHostFetch, mlHostToken, mlHostTokenFile } from "../src/ml";

const TOKEN = "t".repeat(64);

describe("paged-node and the ML host's access token", () => {
  it("reads the token from the environment or the token file", async () => {
    const never = async () => {
      throw new Error("not read");
    };
    expect(await mlHostToken({ PAGED_ML_HOST_TOKEN: TOKEN }, never)).toBe(
      TOKEN,
    );
    expect(
      await mlHostToken({ PAGED_ML_HOST_TOKEN: "short" }, never),
    ).toBeNull();
    const read: string[] = [];
    expect(
      await mlHostToken({ PAGED_ML_HOST_TOKEN_FILE: "/run/ml.token" }, (p) => {
        read.push(p);
        return Promise.resolve(`${TOKEN}\n`);
      }),
    ).toBe(TOKEN);
    expect(read).toEqual(["/run/ml.token"]);
    expect(
      await mlHostToken({ PAGED_ML_HOST_TOKEN_FILE: "/run/ml.token" }, never),
    ).toBeNull();
    expect(
      await mlHostToken({ PAGED_ML_HOST_TOKEN_FILE: "/run/ml.token" }, () =>
        Promise.resolve("not a token\r\nx-other: 1"),
      ),
    ).toBeNull();
  });

  it("finds the token file beside the host's config", () => {
    expect(
      mlHostTokenFile({ PAGED_ML_HOST_CONFIG: "/etc/p/ml-host.json" }),
    ).toBe("/etc/p/ml-host.token");
    expect(mlHostTokenFile({ PAGED_ML_HOST_CONFIG: "/etc/p.d/config" })).toBe(
      "/etc/p.d/config.token",
    );
    expect(mlHostTokenFile({ HOME: "/home/u" }, "linux")).toBe(
      "/home/u/.config/paged/ml-host.token",
    );
    expect(mlHostTokenFile({ HOME: "/Users/u" }, "darwin")).toBe(
      "/Users/u/Library/Application Support/paged/ml-host.token",
    );
    expect(mlHostTokenFile({}, "linux")).toBeNull();
  });

  it("presents the token to the host and to no other origin", async () => {
    const seen: Array<[string, string | null]> = [];
    const inner = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push([
        String(input),
        new Headers(init?.headers).get("authorization"),
      ]);
      return new Response("{}");
    }) as typeof fetch;
    const f = mlHostFetch(
      "http://127.0.0.1:7861",
      () => Promise.resolve(TOKEN),
      inner,
    );
    await f("http://127.0.0.1:7861/api/ml/config", {
      headers: { "content-type": "application/json" },
    });
    await f("http://127.0.0.1:9999/api/ml/config");
    await f("https://example.com/api/ml/config");
    expect(seen).toEqual([
      ["http://127.0.0.1:7861/api/ml/config", `Bearer ${TOKEN}`],
      ["http://127.0.0.1:9999/api/ml/config", null],
      ["https://example.com/api/ml/config", null],
    ]);
    // No token: the request goes on as it was.
    const bare = mlHostFetch(
      "http://127.0.0.1:7861",
      () => Promise.resolve(null),
      inner,
    );
    await bare("http://127.0.0.1:7861/api/ml/health");
    expect(seen.at(-1)).toEqual(["http://127.0.0.1:7861/api/ml/health", null]);
  });
});
