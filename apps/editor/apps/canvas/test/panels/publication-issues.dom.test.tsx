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

// The publication's issues on the page (editor ADR 1223; UX audit F-09):
// the canvas app gathers them from what the engine reports, Publication
// health lists them with a page overview, a click goes to one and shows
// its fixes, and the markers anchor on the item's box.

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";
import { issueMarkersOf, publicationIssuesOf } from "@paged-media/shell";

import { PublicationHealthPanel } from "../../src/panels/cockpit/publication-health-panel";
import { usePublicationIssuesSource } from "../../src/publication-issues";
import { mountPanel, unmountAll } from "./harness";
import { LINKS, linksDocument } from "./support/cockpit";

afterEach(unmountAll);

function HealthWithIssues() {
  usePublicationIssuesSource();
  return <PublicationHealthPanel />;
}

describe("Publication health: the issues where they are", () => {
  test("missing links and a low-res picture are issues on their frames, on page 1", async () => {
    covers("panel:paged.publication-health");
    const h = await mountPanel(HealthWithIssues, {
      id: "paged.publication-health",
      document: linksDocument(),
    });
    await h.settle();
    const { issues } = publicationIssuesOf(h.scope);
    const kinds = issues.map((i) => `${i.kind}:${i.element?.id}`).sort();
    expect(kinds).toEqual(
      [
        `low-res:${LINKS.lowRes.frame}`,
        `missing-link:${LINKS.highRes.frame}`,
        `missing-link:${LINKS.lowRes.frame}`,
      ].sort(),
    );
    expect(issues.every((i) => i.pageIndex === 0 && i.box)).toBe(true);
    // One marker per frame, at its top-right corner.
    const markers = issueMarkersOf(issues);
    expect(markers).toHaveLength(2);
    const low = issues.find((i) => i.element?.id === LINKS.lowRes.frame)!;
    const m = markers.find((x) => x.key.endsWith(LINKS.lowRes.frame))!;
    expect(m.at).toEqual([low.box![0] + low.box![2], low.box![1]]);
    expect(m.severity).toBe("error");

    // The page overview: page 1 has issues, page 2 none.
    const pages = [...h.root.querySelectorAll("[data-issue-page]")];
    expect(pages.map((p) => p.getAttribute("data-issue-count"))).toEqual([
      "3",
      "0",
    ]);
    // A click on an issue shows its fixes, each saying what it does.
    const row = h.root.querySelector(
      `[data-issue="missing-link:${LINKS.highRes.frame}"]`,
    )!;
    await h.user.click(row.querySelector("[data-issue-go]")!);
    await h.settle();
    expect(row.getAttribute("data-active")).toBe("true");
    // Engine ADR 1308: the picture is relinked in place; the Links panel
    // stays beside it.
    expect(row.querySelector('[data-issue-fix="relink"]')!.textContent).toBe(
      "Relink…",
    );
    expect(
      row.querySelector('[data-issue-fix="open-links"]')!.textContent,
    ).toBe("Open Links");
    expect(row.querySelector("[data-issue-fix-preview]")).not.toBeNull();
  });
});
