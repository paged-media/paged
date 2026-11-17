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

// A host starts an embedded editor on a seed document and fits the view to
// the selection (editor ADR 212, amendment 1): `config.seed` names one of
// the docs playground's seeds (playground/seeds.ts), refused before anything
// mounts when it names none; the seed is a blank US Letter page and its
// prelude, run whatever the session's role; `fitSelection` is View ▸ Fit
// selection in window.

import { afterEach, describe, expect, test } from "bun:test";

import type { Role, SessionPolicy } from "@paged-media/client";

import { PAGED_VIEW_FIT_SELECTION } from "../../src/app-commands";
import {
  createEditor,
  FIT_SELECTION,
  seedDocument,
} from "../../src/embed/create-editor";
import { editorError, isEditorError } from "../../src/embed/errors";
import { SEEDS } from "../../src/playground/seeds";

const g = globalThis as { crossOriginIsolated?: unknown };
const before = Object.getOwnPropertyDescriptor(
  globalThis,
  "crossOriginIsolated",
);

afterEach(() => {
  if (before) Object.defineProperty(globalThis, "crossOriginIsolated", before);
  else delete g.crossOriginIsolated;
});

/** A handle and client that log what the seed does with them. */
function rig(options: { error?: string } = {}) {
  const log: string[] = [];
  const handle = {
    newDocument: async (w: number, h: number) => void log.push(`new ${w}x${h}`),
  };
  const client = {
    setSessionPolicy: async (policy: SessionPolicy) => {
      log.push(`role ${policy.role}`);
      return policy;
    },
    executeScript: async (source: string) => {
      log.push(`run ${source.length}`);
      return {
        output: [] as string[],
        error: options.error ?? null,
        budgetKind: null,
      };
    },
  };
  return { log, handle, client };
}

describe("config.seed", () => {
  test("an unknown name refuses with unknownSeed, naming the seeds, before anything mounts", async () => {
    Object.defineProperty(globalThis, "crossOriginIsolated", {
      value: true,
      configurable: true,
      writable: true,
    });
    const element = document.createElement("div");
    document.body.append(element);
    let caught: unknown;
    try {
      await createEditor(element, { profile: "viewer", seed: "no-such-seed" });
    } catch (error) {
      caught = error;
    }
    expect(isEditorError(caught)).toBe(true);
    const error = caught as Error & { code: string };
    expect(error.code).toBe("unknownSeed");
    expect(error.message).toContain('"no-such-seed"');
    for (const name of Object.keys(SEEDS))
      expect(error.message).toContain(name);
    expect(element.childElementCount).toBe(0);
    element.remove();
  });

  test("unknownSeed is one of the codes a host branches on", () => {
    expect(isEditorError(editorError("unknownSeed", "x"))).toBe(true);
  });

  test("a seed is a blank US Letter page, then its prelude", async () => {
    const r = rig();
    const prelude = SEEDS.flyer.prelude;
    await seedDocument(r.handle, r.client, prelude, "editor");
    expect(r.log).toEqual(["new 612x792", `run ${prelude.length}`]);
  });

  test("the blank seed runs no script", async () => {
    const r = rig();
    await seedDocument(r.handle, r.client, SEEDS.blank.prelude, "viewer");
    expect(r.log).toEqual(["new 612x792"]);
  });

  test("a role that changes nothing is lifted to editor for the prelude and put back", async () => {
    for (const role of ["viewer", "filler"] satisfies Role[]) {
      const r = rig();
      const prelude = SEEDS["one-text-frame-selected"].prelude;
      await seedDocument(r.handle, r.client, prelude, role);
      expect(r.log).toEqual([
        "new 612x792",
        "role editor",
        `run ${prelude.length}`,
        `role ${role}`,
      ]);
    }
  });

  test("a prelude that fails rejects, with the role put back", async () => {
    const r = rig({ error: "TypeError: boom" });
    const prelude = SEEDS["two-frames"].prelude;
    let caught: unknown;
    try {
      await seedDocument(r.handle, r.client, prelude, "viewer");
    } catch (error) {
      caught = error;
    }
    expect(String(caught)).toContain("TypeError: boom");
    expect(r.log.at(-1)).toBe("role viewer");
  });
});

describe("handle.fitSelection", () => {
  test("runs View ▸ Fit selection in window", () => {
    expect(FIT_SELECTION).toBe(PAGED_VIEW_FIT_SELECTION);
  });
});
