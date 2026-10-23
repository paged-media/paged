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

// ADR 560's typed commands, the UNIT layer: the real bundle on the SDK's
// in-process host over the recording fake editor (no canvas engine, so no
// template): each command says what is missing and writes nothing. The
// catalogue itself is made on the real engine
// (./headless/catalogue.headless.test.ts).

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  setDefaultTimeout,
} from "bun:test";

import { covers } from "@paged-media/test-kit";

import { readiness, unitEnv, type DataEnv } from "./conformance/env";
import { D, seed } from "./conformance/scenarios";

const gate = readiness(false);

describe.skipIf(!gate.ready && !gate.required)(
  `paged.data catalogue commands on the fake editor${gate.ready ? "" : ` (unavailable: ${gate.missing})`}`,
  () => {
    setDefaultTimeout(60_000);
    let env: DataEnv;
    beforeEach(async () => {
      env = await unitEnv();
    });
    afterEach(() => env.dispose());

    it("templateFieldTargets — a document without a template has none", async () => {
      covers("command:media.paged.data.templateFieldTargets");
      expect(
        await env.objects.invoke(`${D}.templateFieldTargets` as never, {}),
      ).toEqual([]);
    });

    it("bindTemplateField — a field the template lacks is refused, nothing is kept", async () => {
      covers("command:media.paged.data.bindTemplateField");
      await seed(env);
      const mark = env.mark();
      expect(
        await env.objects.invoke(`${D}.bindTemplateField` as never, {
          field: "title",
          query: "q",
          expr: "name",
        }),
      ).toEqual({ ok: false, reason: 'The template has no field "title".' });
      expect(env.session.templateFieldBindings()).toEqual([]);
      expect(env.writesSince(mark)).toEqual([]);
    });

    it("runCatalogue — with no field bound it says so and writes nothing", async () => {
      covers("command:media.paged.data.runCatalogue");
      await seed(env);
      const mark = env.mark();
      const r = (await env.objects.invoke(`${D}.runCatalogue` as never, {
        mode: "perRecord",
      })) as { ok: boolean; message: string; pages: string[] };
      expect(r.ok).toBe(false);
      expect(r.message).toBe("No template field is bound to the data yet.");
      expect(r.pages).toEqual([]);
      expect(env.writesSince(mark)).toEqual([]);
      expect(env.session.getState().message).toBe(r.message);
    });
  },
);
