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

// The Publication contract panel (editor ADR 1236): a contract made from
// the document is one undo step and reads ready; its checks show; an
// approval is an explicit action and one undo step.

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";
import { publicationReadinessOf } from "@paged-media/shell";

import { usePublicationContractSource } from "../../src/contract/source";
import { ContractPanel } from "../../src/panels/contract-panel";
import { mountPanel, unmountAll } from "./harness";

afterEach(unmountAll);

function PanelWithSource() {
  usePublicationContractSource();
  return <ContractPanel />;
}

const undoLen = async (client: {
  undoLog(limit?: number): Promise<{ undoLen: number }>;
}) => (await client.undoLog(0)).undoLen;

async function until(h: { settle(): Promise<void> }, ok: () => boolean) {
  for (let i = 0; i < 60 && !ok(); i++) {
    await new Promise((r) => setTimeout(r, 50));
    await h.settle();
  }
}

describe("Publication contract", () => {
  test("made from the document it reads ready; approving is one undo step", async () => {
    covers("panel:paged.publication-contract");
    const h = await mountPanel(PanelWithSource, {
      id: "paged.publication-contract",
      document: "blank",
    });
    await h.settle();
    const before = await undoLen(h.client);
    await h.user.click(h.root.querySelector("[data-contract-create]")!);
    await until(
      h,
      () => h.root.querySelector("[data-contract-readiness]") !== null,
    );
    expect(await undoLen(h.client)).toBe(before + 1);
    const panel = h.root.querySelector("[data-contract-panel]")!;
    expect(panel.getAttribute("data-contract-readiness")).toBe("ready");
    expect(
      h.root
        .querySelector('[data-contract-check="page-size"]')
        ?.getAttribute("data-level"),
    ).toBe("ok");
    expect(publicationReadinessOf(h.scope)?.level).toBe("ready");

    await h.user.click(h.root.querySelector("[data-contract-approve]")!);
    await until(
      h,
      () =>
        h.root
          .querySelector("[data-contract-approval]")
          ?.getAttribute("data-contract-approval") === "approved",
    );
    expect(await undoLen(h.client)).toBe(before + 2);
    expect(publicationReadinessOf(h.scope)?.level).toBe("approved");
  });
});
