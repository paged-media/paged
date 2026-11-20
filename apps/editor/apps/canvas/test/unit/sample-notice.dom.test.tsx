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

// Editor ADR 1243, amendment 1: each sample names its publisher, and the list
// says, in text, that the samples are illustrations from archive.org.

import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, test } from "bun:test";
import { SampleCredit, SampleNotice } from "../../src/samples/SampleNotice";

afterEach(cleanup);

test("a sample names its publisher as the catalog gives it", () => {
  const { container } = render(<SampleCredit publisher="A Publisher" />);
  expect(container.querySelector("[data-sample-credit]")?.textContent).toBe(
    "© A Publisher",
  );
});

test("a sample without a credit shows none", () => {
  const { container } = render(<SampleCredit />);
  expect(container.querySelector("[data-sample-credit]")).toBeNull();
});

test("the notice says illustration, archive.org and whose property they are", () => {
  const { container } = render(<SampleNotice />);
  const text =
    container.querySelector("[data-samples-notice]")?.textContent ?? "";
  expect(text).toContain("illustrative and demonstration purposes");
  expect(text).toContain("archive.org");
  expect(text).toContain("publishers’ property");
});
