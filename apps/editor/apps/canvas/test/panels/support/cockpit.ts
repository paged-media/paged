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

// Fixtures and doors for the cockpit panels' tests (Prepress / Export /
// Review / Data modes), built in code like everything in the lane.
//
// `linksDocument()` is an IDML whose two image frames point at files that
// do not exist (no resolver runs headless, so the build draws the grey
// placeholder and the links read `missing`, as an IDML opened without its
// links folder does): `ulow` at 72 effective ppi (below the 150-ppi
// warn floor), `uhigh` at 300. Its handle's stats are the load's real
// counts (two frames).

import type { CanvasClient, Mutation } from "@paged-media/client";
import { buildFixtureIdml, rect } from "@paged-media/test-kit";

import { apply } from "../fixtures";

/** A rectangle holding a placed image, as InDesign writes it. */
function imageFrame(
  self: string,
  box: readonly [number, number, number, number],
  uri: string,
  ppi: number,
): string {
  const plain = rect(self, box, { fill: "Swatch/None" });
  return plain.replace(
    "</Rectangle>",
    `<Image Self="${self}i" Space="$ID/RGB" ActualPpi="(${ppi} ${ppi})" ` +
      `EffectivePpi="(${ppi} ${ppi})" LinkResourceURI="${uri}"/></Rectangle>`,
  );
}

export const LINKS = {
  lowRes: { frame: "ulow", uri: "file:///placed/low-res-photo.jpg", ppi: 72 },
  highRes: { frame: "uhigh", uri: "file:///placed/cover.tif", ppi: 300 },
} as const;

/** Two pages; page 1 carries the two image frames with missing links. */
export function linksDocument(): Uint8Array {
  return buildFixtureIdml({
    name: "cockpit-links",
    pages: [
      {
        id: "cp1",
        items: [
          imageFrame(
            LINKS.lowRes.frame,
            [72, 72, 272, 272],
            LINKS.lowRes.uri,
            LINKS.lowRes.ppi,
          ),
          imageFrame(
            LINKS.highRes.frame,
            [72, 320, 272, 520],
            LINKS.highRes.uri,
            LINKS.highRes.ppi,
          ),
        ],
      },
      { id: "cp2", items: [] },
    ],
  });
}

/** The CMYK working space the print-output tests name (ADR 265). */
export const PRESS_PROFILE = "Coated Test Press";

/** One page whose designmap DECLARES `PRESS_PROFILE` as its CMYK working
 *  space, with no profile bytes: what a file from another machine is. */
export function declaredProfileDocument(): Uint8Array {
  return buildFixtureIdml({
    name: "cockpit-declared-profile",
    pages: [{ id: "cp1", items: [] }],
    cmykProfile: PRESS_PROFILE,
  });
}

/** The smallest bytes that read as an ICC profile: a 132-byte file whose
 *  header declares its size and carries the `acsp` signature at byte 36. */
export function iccBytes(): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(new ArrayBuffer(132));
  b[3] = 132;
  b.set([0x61, 0x63, 0x73, 0x70], 36);
  return b;
}

/** Register `name`'s bytes and make it the working space, the way Color
 *  settings does: after this the working space is ACTIVE. */
export async function activateProfile(
  client: CanvasClient,
  name: string = PRESS_PROFILE,
): Promise<void> {
  await client.registerColorProfile(name, iccBytes());
  await apply(client, {
    op: "setColorSettings",
    args: { cmykProfileName: name, rgbPolicy: null, intent: null, bpc: null },
  } as Mutation);
}

/** Swatches for the ink-limit check: total area coverage 300 %, 400 %
 *  and an RGB swatch that has no ink breakdown. */
export async function inkSwatches(client: CanvasClient): Promise<void> {
  const m = (x: unknown) => apply(client, x as Mutation);
  await m({
    op: "createSwatch",
    args: {
      spec: {
        name: "Rich Black",
        space: "CMYK",
        value: [75, 68, 67, 90],
        model: "Process",
      },
    },
  });
  await m({
    op: "createSwatch",
    args: {
      spec: {
        name: "Registration-ish",
        space: "CMYK",
        value: [100, 100, 100, 100],
        model: "Process",
      },
    },
  });
  await m({
    op: "createSwatch",
    args: {
      spec: {
        name: "Screen Blue",
        space: "RGB",
        value: [20, 80, 220],
        model: "Process",
      },
    },
  });
}

/** A download the panel started (the anchor-click path of
 *  `downloadBytes`), captured instead of followed. */
export interface Download {
  name: string;
  href: string;
}

/** Capture anchor-click downloads until the returned `restore` runs. */
export function captureDownloads(): { downloads: Download[]; restore(): void } {
  const downloads: Download[] = [];
  const proto = HTMLAnchorElement.prototype;
  const original = proto.click;
  proto.click = function (this: HTMLAnchorElement) {
    if (this.download) downloads.push({ name: this.download, href: this.href });
    else original.call(this);
  };
  return {
    downloads,
    restore() {
      proto.click = original;
    },
  };
}

/** The ComingSoon cards a panel shows, as their titles. */
export function comingSoonTitles(root: HTMLElement): string[] {
  return [...root.querySelectorAll("[data-coming-soon]")].map(
    (card) => card.querySelector("span")?.textContent ?? "",
  );
}

/** A status pill's words and tone (`StatusPill`, by its test id). */
export function pill(
  root: HTMLElement,
  testId: string,
): { text: string; tone: string | null } | null {
  const el = root.querySelector(`[data-status-pill="${testId}"]`);
  return el
    ? { text: el.textContent ?? "", tone: el.getAttribute("data-tone") }
    : null;
}

/** A kit button by its `testId` (`data-cockpit-action`). */
export function action(root: HTMLElement, testId: string): HTMLButtonElement {
  const el = root.querySelector<HTMLButtonElement>(
    `[data-cockpit-action="${testId}"]`,
  );
  if (!el) throw new Error(`no cockpit action ${testId}`);
  return el;
}

/** Every enabled button, input and select under `root`. */
export function enabledControls(root: HTMLElement): HTMLElement[] {
  return [
    ...root.querySelectorAll<HTMLElement>("button, input, select, textarea"),
  ].filter((el) => !(el as HTMLButtonElement).disabled);
}
