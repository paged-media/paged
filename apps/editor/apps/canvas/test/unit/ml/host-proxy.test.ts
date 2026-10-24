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

import { handleMlProxy, mlHostTarget } from "../../../src/ml/host-proxy";

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
      new Request("http://x/api/ml/jobs/j1/events"),
      {
        target: "http://127.0.0.1:7861",
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
      (await handleMlProxy(new Request("http://x/api/ai/v1"), { target }))
        .status,
    ).toBe(404);
    expect(
      (
        await handleMlProxy(
          new Request("http://x/api/ml/health", { method: "PATCH" }),
          { target },
        )
      ).status,
    ).toBe(405);
    const down = await handleMlProxy(new Request("http://x/api/ml/health"), {
      target,
      fetch: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    expect(down.status).toBe(503);
    expect(await down.json()).toMatchObject({
      error: "unreachable",
      message: expect.stringMatching(/local image model not running/),
    });
    expect(
      (
        await handleMlProxy(new Request("http://x/api/ml/health"), {
          target: null,
        })
      ).status,
    ).toBe(503);
  });
});
