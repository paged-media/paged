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

import { describe, expect, it } from "bun:test";

import { escapeXmlAttr, escapeXmlText } from "../src/escape.ts";

describe("escapeXml*", () => {
  it("text escapes & < > and leaves quotes", () => {
    expect(escapeXmlText(`a & b < c > d "e" 'f'`)).toBe(
      `a &amp; b &lt; c &gt; d "e" 'f'`,
    );
  });
  it("an attribute also escapes the double quote", () => {
    expect(escapeXmlAttr(`"a" & <b>`)).toBe(`&quot;a&quot; &amp; &lt;b&gt;`);
  });
  it("escapes & first, so an entity is not escaped twice by accident", () => {
    expect(escapeXmlText("&lt;")).toBe("&amp;lt;");
  });
});
