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

// Editor ADR 290 — the same-origin route to the local host: it forwards
// only /api/ml paths and the host's methods to a loopback target, passes
// the body and streams the answer, drops credentials, and answers 503
// "local image model not running" when the host does not answer.

import { describe, expect, test } from "bun:test";

import {
  handleMlProxy,
  mlHostTarget,
  mlHostToken,
  mlHostTokenFile,
} from "../../../src/ml/host-proxy";

describe("[plugin-platform.ml-service] /api/ml proxy", () => {
  test("the target must be loopback http", () => {
    expect(mlHostTarget(undefined)).toBe("http://127.0.0.1:7861");
    expect(mlHostTarget("http://localhost:9000")).toBe("http://localhost:9000");
    expect(mlHostTarget("https://example.com")).toBeNull();
    expect(mlHostTarget("http://10.0.0.2:7861")).toBeNull();
    expect(mlHostTarget("http://127.0.0.1:7861/other")).toBeNull();
  });

  test("forwards path, query, method and body; no cookies or credentials", async () => {
    let seen: {
      url: string;
      method: string;
      headers: Headers;
      body: string;
    } | null = null;
    const res = await handleMlProxy(
      new Request("http://127.0.0.1:5173/api/ml/jobs?x=1", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "s=1",
          authorization: "Bearer t",
        },
        body: '{"kind":"generate"}',
      }),
      {
        target: "http://127.0.0.1:7861",
        token: null,
        fetch: (async (url: string, init: RequestInit) => {
          seen = {
            url,
            method: init.method!,
            headers: new Headers(init.headers),
            body: new TextDecoder().decode(init.body as ArrayBuffer),
          };
          return new Response('{"id":"j1"}', {
            status: 202,
            headers: {
              "content-type": "application/json",
              "set-cookie": "a=b",
            },
          });
        }) as typeof fetch,
      },
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ id: "j1" });
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(seen!.url).toBe("http://127.0.0.1:7861/api/ml/jobs?x=1");
    expect(seen!.method).toBe("POST");
    expect(seen!.body).toBe('{"kind":"generate"}');
    expect(seen!.headers.get("cookie")).toBeNull();
    expect(seen!.headers.get("authorization")).toBeNull();
  });

  test("streams server-sent events through", async () => {
    const enc = new TextEncoder();
    const res = await handleMlProxy(
      new Request("http://127.0.0.1:5173/api/ml/jobs/j1/events"),
      {
        target: "http://127.0.0.1:7861",
        token: null,
        fetch: (async () =>
          new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(enc.encode("event: progress\ndata: {}\n\n"));
                c.close();
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          )) as unknown as typeof fetch,
      },
    );
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(await res.text()).toBe("event: progress\ndata: {}\n\n");
  });

  test("refuses other paths and methods; 503 when the host is down", async () => {
    const target = "http://127.0.0.1:7861";
    expect(
      (
        await handleMlProxy(new Request("http://127.0.0.1:5173/api/ai/v1"), {
          target,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await handleMlProxy(
          new Request("http://127.0.0.1:5173/api/ml/health", {
            method: "PATCH",
          }),
          { target },
        )
      ).status,
    ).toBe(405);
    const down = await handleMlProxy(
      new Request("http://127.0.0.1:5173/api/ml/health"),
      {
        target,
        token: null,
        fetch: (async () => {
          throw new Error("ECONNREFUSED");
        }) as unknown as typeof fetch,
      },
    );
    expect(down.status).toBe(503);
    expect(await down.json()).toMatchObject({
      error: "unreachable",
      message: expect.stringMatching(/local image model not running/),
    });
    expect(
      (
        await handleMlProxy(
          new Request("http://127.0.0.1:5173/api/ml/health"),
          {
            target: null,
          },
        )
      ).status,
    ).toBe(503);
  });

  // The proxy presents the host's token for the page, so it holds the
  // host's guards itself.
  const TOKEN = "t".repeat(64);
  const seenBy = () => {
    const calls: Headers[] = [];
    const fetch = (async (_url: string, init: RequestInit) => {
      calls.push(new Headers(init.headers));
      return new Response("{}", {
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;
    return { calls, fetch };
  };
  const ROUTES: Array<[string, string]> = [
    ["GET", "/api/ml/health"],
    ["GET", "/api/ml/config"],
    ["PUT", "/api/ml/config"],
    ["POST", "/api/ml/jobs"],
    ["GET", "/api/ml/jobs/j1"],
    ["DELETE", "/api/ml/jobs/j1"],
    ["GET", "/api/ml/jobs/j1/result"],
    ["GET", "/api/ml/jobs/j1/events"],
  ];
  const req = (
    method: string,
    path: string,
    host: string,
    headers: Record<string, string>,
  ) =>
    new Request(`http://${host}${path}`, {
      method,
      headers,
      ...(method === "PUT" || method === "POST" ? { body: "{}" } : {}),
    });

  test("presents the host's token and what the browser said of its origin", async () => {
    for (const [method, path] of ROUTES) {
      const { calls, fetch } = seenBy();
      const res = await handleMlProxy(
        req(method, path, "localhost:5173", {
          origin: "http://localhost:5173",
          "sec-fetch-site": "same-origin",
          authorization: "Bearer from-the-page",
        }),
        { target: "http://127.0.0.1:7861", token: TOKEN, fetch },
      );
      expect(res.status).toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.get("authorization")).toBe(`Bearer ${TOKEN}`);
      expect(calls[0]!.get("origin")).toBe("http://localhost:5173");
      expect(calls[0]!.get("sec-fetch-site")).toBe("same-origin");
    }
  });

  test("every route refuses a foreign origin, and never reaches the host", async () => {
    const foreign: Array<Record<string, string>> = [
      { origin: "https://evil.example" },
      { origin: "http://localhost:9999" },
      { origin: "null" },
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-site" },
    ];
    for (const [method, path] of ROUTES)
      for (const headers of foreign) {
        const { calls, fetch } = seenBy();
        const res = await handleMlProxy(
          req(method, path, "localhost:5173", headers),
          { target: "http://127.0.0.1:7861", token: TOKEN, fetch },
        );
        expect(res.status).toBe(403);
        expect(await res.json()).toMatchObject({ error: "forbidden_origin" });
        expect(calls).toHaveLength(0);
      }
  });

  test("every route refuses a host that is not loopback", async () => {
    for (const [method, path] of ROUTES)
      for (const host of [
        "evil.example",
        "192.168.1.20:5173",
        "127.0.0.1.evil.example:5173",
      ]) {
        const { calls, fetch } = seenBy();
        const res = await handleMlProxy(req(method, path, host, {}), {
          target: "http://127.0.0.1:7861",
          token: TOKEN,
          fetch,
        });
        expect(res.status).toBe(403);
        expect(await res.json()).toMatchObject({ error: "forbidden_host" });
        expect(calls).toHaveLength(0);
      }
  });

  test("without a token the request goes on bare, for the host to refuse", async () => {
    const { calls, fetch } = seenBy();
    await handleMlProxy(req("GET", "/api/ml/config", "127.0.0.1:5173", {}), {
      target: "http://127.0.0.1:7861",
      token: null,
      fetch,
    });
    expect(calls[0]!.get("authorization")).toBeNull();
  });

  test("the token comes from the environment or the host's token file", async () => {
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
    const file = async (path: string) => {
      read.push(path);
      return `${TOKEN}\n`;
    };
    expect(
      await mlHostToken({ PAGED_ML_HOST_TOKEN_FILE: "/run/ml.token" }, file),
    ).toBe(TOKEN);
    expect(read).toEqual(["/run/ml.token"]);
    expect(
      await mlHostToken({ PAGED_ML_HOST_TOKEN_FILE: "/run/ml.token" }, never),
    ).toBeNull();
    expect(
      await mlHostToken(
        { PAGED_ML_HOST_TOKEN_FILE: "/run/ml.token" },
        async () => "not a token\r\nx-injected: 1",
      ),
    ).toBeNull();

    expect(
      mlHostTokenFile({ PAGED_ML_HOST_CONFIG: "/etc/p/ml-host.json" }),
    ).toBe("/etc/p/ml-host.token");
    expect(mlHostTokenFile({ PAGED_ML_HOST_CONFIG: "/etc/p.d/config" })).toBe(
      "/etc/p.d/config.token",
    );
    expect(mlHostTokenFile({ HOME: "/home/u" }, "linux")).toBe(
      "/home/u/.config/paged/ml-host.token",
    );
    expect(
      mlHostTokenFile({ HOME: "/home/u", XDG_CONFIG_HOME: "/x" }, "linux"),
    ).toBe("/x/paged/ml-host.token");
    expect(mlHostTokenFile({ HOME: "/Users/u" }, "darwin")).toBe(
      "/Users/u/Library/Application Support/paged/ml-host.token",
    );
    expect(mlHostTokenFile({}, "linux")).toBeNull();
  });
});
