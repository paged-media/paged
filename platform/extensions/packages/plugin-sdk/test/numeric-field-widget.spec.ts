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

// `host.widgets.NumericField` (the editor's one numeric field, through the
// contract): always present, the plain decimal fallback when the host
// injects none, and `widgets.numericField@1` tracks the injection.

import { describe, expect, it } from "bun:test";

import type {
  NumericFieldProps,
  PluginManifest,
} from "@paged-media/plugin-api";

import { createBundleHost } from "../src/host-impl";
import { FALLBACK_WIDGETS } from "../src/widgets-fallback";
import { makeFakeEditor } from "./fake-editor";
import { silentConsole as silent } from "../src/testing";

const MANIFEST: PluginManifest = {
  id: "media.paged.example",
  name: "example",
  version: "1.0.0",
  apiVersion: "^0.2",
  capabilities: {},
};

describe("widgets.NumericField", () => {
  it("is always present; the flag tracks the host's injection", () => {
    const fake = makeFakeEditor();
    const bare = createBundleHost(() => fake.editor, MANIFEST, {
      console: silent,
    }).host;
    expect(bare.widgets.NumericField).toBe(FALLBACK_WIDGETS.NumericField);
    expect(bare.supports("widgets.numericField@1")).toBe(false);

    const Field = (_: NumericFieldProps) => null;
    const wired = createBundleHost(() => fake.editor, MANIFEST, {
      console: silent,
      widgets: { NumericField: Field },
    }).host;
    expect(wired.widgets.NumericField).toBe(Field);
    expect(wired.supports("widgets.numericField@1")).toBe(true);
    // The other members keep their fallbacks.
    expect(typeof wired.widgets.ColorPicker).toBe("function");
    expect(wired.supports("widgets.colorPicker@1")).toBe(false);
  });
});
