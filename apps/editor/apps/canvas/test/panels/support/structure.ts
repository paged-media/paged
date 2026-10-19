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

// Support for the structure-list panels' tests (links, conditions,
// articles, cross-references, index, fonts, pages, stories, the
// document map): a document built in code with one of each structure
// those panels list, and the two pieces of the shell's chrome routing the
// panel harness does not mount (ShellChrome rebuilds the document handle
// after a page-structure change and puts the resolver's table into the
// document context).

import { storedZip } from "@paged-media/test-kit";
import type { WorkerToMain } from "@paged-media/client";

import type { PanelHarness } from "../harness";

const NS =
  'xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="20.0"';
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

const box = (t: number, l: number, b: number, r: number) =>
  `<Properties><PathGeometry><GeometryPathType PathOpen="false"><PathPointArray>` +
  [
    [l, t],
    [r, t],
    [r, b],
    [l, b],
  ]
    .map(
      ([x, y]) =>
        `<PathPointType Anchor="${x} ${y}" LeftDirection="${x} ${y}" RightDirection="${x} ${y}"/>`,
    )
    .join("") +
  `</PathPointArray></GeometryPathType></PathGeometry></Properties>`;

/** The ids `structureIdml` writes. */
export const STRUCTURE = {
  page1: "sp1",
  page2: "sp2",
  textFrame: { kind: "textFrame", id: "stf" } as const,
  story: "sstory",
  imageFrame: { kind: "rectangle", id: "simgframe" } as const,
  missingUri: "file:///nowhere/photo.jpg",
  conditions: { draft: "Condition/Draft", final: "Condition/Final" },
  conditionSet: "ConditionSet/Print",
  article: "sarticle",
  crossReference: "sxref",
  topics: ["sindex/apples", "sindex/bananas"],
  font: "Missing Sans",
} as const;

/** One document with every structure the group's panels list. `font`
 *  is the family its text runs name (default: one no registry holds, so
 *  it is missing). `headings` puts a "Heading 1" paragraph ("Chapter
 *  One") before the text and a "Heading 2" ("Section A") after it: the
 *  resolver's heading anchors. */
export function structureIdml(
  options: {
    font?: string;
    headings?: boolean;
    /** Replace the story with these headings ([level, text]), in order. */
    outline?: ReadonlyArray<readonly [number, string]>;
  } = {},
): Uint8Array {
  const font = options.font ?? STRUCTURE.font;
  const bounds = "0 0 792 612";
  const spread = (page: string, items: string) =>
    XML +
    `<idPkg:Spread ${NS}>\n<Spread Self="${page}-spread" PageCount="1" ItemTransform="1 0 0 1 0 0">\n` +
    `<Page Self="${page}" Name="${page}" GeometricBounds="${bounds}" ItemTransform="1 0 0 1 0 0" AppliedMaster="um"/>\n` +
    items +
    `\n</Spread>\n</idPkg:Spread>`;
  const s = STRUCTURE;
  const designmap =
    XML +
    `<?aid style="50" type="document" readerVersion="6.0" featureSet="257" product="20.0(32)"?>\n` +
    `<Document ${NS} Self="d" StoryList="${s.story}" Name="structure.indd">\n` +
    `<idPkg:Graphic src="Resources/Graphic.xml"/>\n<idPkg:Fonts src="Resources/Fonts.xml"/>\n` +
    `<idPkg:Styles src="Resources/Styles.xml"/>\n<idPkg:Preferences src="Resources/Preferences.xml"/>\n` +
    `<Condition Self="${s.conditions.draft}" Name="Draft" Visible="true" IndicatorMethod="UseHighlight"/>\n` +
    `<Condition Self="${s.conditions.final}" Name="Final" Visible="false" IndicatorMethod="UseUnderline"/>\n` +
    `<ConditionSet Self="${s.conditionSet}" Name="Print" Conditions="${s.conditions.draft} ${s.conditions.final}"/>\n` +
    `<idPkg:MasterSpread src="MasterSpreads/MasterSpread_um.xml"/>\n` +
    `<idPkg:Spread src="Spreads/Spread_${s.page1}.xml"/>\n` +
    `<idPkg:Spread src="Spreads/Spread_${s.page2}.xml"/>\n` +
    `<idPkg:Story src="Stories/Story_${s.story}.xml"/>\n` +
    `<Article Self="${s.article}" Name="Main article" MemberItemRefs="${s.textFrame.id} ${s.imageFrame.id}"/>\n` +
    `<CrossReferenceFormat Self="CrossReferenceFormat/u1" Name="Page Number"/>\n` +
    `<CrossReferenceSource Self="${s.crossReference}" Name="See the photo" AppliedFormat="CrossReferenceFormat/u1"/>\n` +
    `<Index Self="sindex"><Topic Self="${s.topics[0]}" Name="Apples" SortOrder="apples"/>` +
    `<Topic Self="${s.topics[1]}" Name="Bananas"/></Index>\n` +
    `<idPkg:BackingStory src="XML/BackingStory.xml"/>\n</Document>`;
  const para = (style: string, text: string, br: boolean) =>
    `<ParagraphStyleRange AppliedParagraphStyle="${style}">` +
    `<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]" AppliedFont="${font}">` +
    `<Content>${text}</Content>${br ? "<Br/>" : ""}</CharacterStyleRange></ParagraphStyleRange>`;
  const story =
    XML +
    `<idPkg:Story ${NS}><Story Self="${s.story}">` +
    (options.outline ?? [])
      .map(([level, text], i, all) =>
        para(`ParagraphStyle/Heading ${level}`, text, i < all.length - 1),
      )
      .join("") +
    (options.outline
      ? ""
      : options.headings
        ? para("ParagraphStyle/Heading 1", "Chapter One", true)
        : "") +
    (options.outline
      ? ""
      : para(
          "ParagraphStyle/$ID/[No paragraph style]",
          "Structure text",
          options.headings === true,
        )) +
    (!options.outline && options.headings
      ? para("ParagraphStyle/Heading 2", "Section A", false)
      : "") +
    `</Story></idPkg:Story>`;
  const empty = (tag: string) => `${XML}<idPkg:${tag} ${NS}/>`;
  return storedZip([
    { name: "mimetype", data: "application/vnd.adobe.indesign-idml-package" },
    { name: "designmap.xml", data: designmap },
    {
      name: "META-INF/container.xml",
      data:
        XML +
        `<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">` +
        `<rootfiles><rootfile full-path="designmap.xml" media-type="text/xml"/></rootfiles></container>`,
    },
    {
      name: "Resources/Graphic.xml",
      data:
        XML +
        `<idPkg:Graphic ${NS}>` +
        `<Color Self="Color/Black" Model="Process" Space="CMYK" ColorValue="0 0 0 100" Name="Black"/>` +
        `<Swatch Self="Swatch/None" Name="None"/></idPkg:Graphic>`,
    },
    { name: "Resources/Fonts.xml", data: empty("Fonts") },
    {
      name: "Resources/Styles.xml",
      data:
        XML +
        `<idPkg:Styles ${NS}><RootCharacterStyleGroup Self="rcs">` +
        `<CharacterStyle Self="CharacterStyle/$ID/[No character style]" Name="$ID/[No character style]"/>` +
        `</RootCharacterStyleGroup><RootParagraphStyleGroup Self="rps">` +
        `<ParagraphStyle Self="ParagraphStyle/$ID/[No paragraph style]" Name="$ID/[No paragraph style]"/>` +
        `</RootParagraphStyleGroup></idPkg:Styles>`,
    },
    { name: "Resources/Preferences.xml", data: empty("Preferences") },
    {
      name: "MasterSpreads/MasterSpread_um.xml",
      data:
        XML +
        `<idPkg:MasterSpread ${NS}><MasterSpread Self="um" Name="A">` +
        `<Page Self="ump" Name="A" GeometricBounds="${bounds}" ItemTransform="1 0 0 1 0 0"/>` +
        `</MasterSpread></idPkg:MasterSpread>`,
    },
    {
      name: `Spreads/Spread_${s.page1}.xml`,
      data: spread(
        s.page1,
        `<TextFrame Self="${s.textFrame.id}" ParentStory="${s.story}" ContentType="TextType" ItemTransform="1 0 0 1 0 0">` +
          box(72, 72, 200, 300) +
          `</TextFrame>` +
          `<Rectangle Self="${s.imageFrame.id}" GeometricBounds="300 72 500 300" ItemTransform="1 0 0 1 0 0" ContentType="GraphicType">` +
          box(300, 72, 500, 300) +
          `<Image Self="simg" ItemTransform="1 0 0 1 72 300"><Link Self="slink" LinkResourceURI="${s.missingUri}" LinkResourceFormat="$ID/JPEG"/></Image>` +
          `</Rectangle>`,
      ),
    },
    { name: `Spreads/Spread_${s.page2}.xml`, data: spread(s.page2, "") },
    { name: `Stories/Story_${s.story}.xml`, data: story },
    {
      name: "XML/BackingStory.xml",
      data: `${XML}<idPkg:BackingStory ${NS}><XmlStory Self="backing"/></idPkg:BackingStory>`,
    },
  ]);
}

/**
 * The two routes PagedShell's chrome takes for every mount and the panel
 * harness does not mount: a reply that changed the page structure
 * rebuilds the document handle (so the page grid follows), and the
 * resolver's table goes into the document context. Same rules as
 * ShellChrome's subscriber; returns the unsubscribe.
 */
export function routeShellEvents(h: PanelHarness<unknown>): () => void {
  return h.client.subscribe((msg: WorkerToMain) => {
    const doc = h.paged.document;
    if (msg.kind === "resolutionDone") {
      doc.setResolution(msg.payload);
    } else if (
      msg.kind === "mutationApplied" ||
      msg.kind === "undoApplied" ||
      msg.kind === "redoApplied"
    ) {
      const p = msg.payload as {
        pageStructureChanged?: boolean;
        pageIds?: string[];
        pageSizesPt?: [number, number][] | null;
      };
      const prev = doc.handle;
      if (prev && p.pageStructureChanged && p.pageSizesPt && p.pageIds) {
        doc.setHandle({
          ...prev,
          pageCount: p.pageIds.length,
          pageIds: p.pageIds as typeof prev.pageIds,
          pageSizesPt: p.pageSizesPt as typeof prev.pageSizesPt,
        });
      }
    }
  });
}

/** Give the camera a viewport (the canvas sets it; the harness has none). */
export async function withViewport(
  h: PanelHarness<unknown>,
  size: readonly [number, number] = [800, 600],
): Promise<void> {
  await h.act(() => h.paged.camera.setViewportSize(size as [number, number]));
}

/** Wait (bounded) until the animated camera lands on `target`. */
export async function cameraLandsOn(
  h: PanelHarness<unknown>,
  target: { scale: number; tx: number; ty: number },
): Promise<void> {
  const close = (a: number, b: number) => Math.abs(a - b) < 1e-6;
  for (let i = 0; i < 200; i++) {
    const c = h.paged.camera.camera;
    if (
      close(c.scale, target.scale) &&
      close(c.tx, target.tx) &&
      close(c.ty, target.ty)
    )
      return;
    await h.act(() => new Promise((r) => setTimeout(r, 10)));
  }
  throw new Error(
    `camera never landed on ${JSON.stringify(target)}: ${JSON.stringify(h.paged.camera.camera)}`,
  );
}

/** One `ListRows` row as the user reads it. */
export interface RowText {
  key: string;
  primary: string;
  secondary: string | null;
  badge: string | null;
  selected: boolean;
}

/** The `ListRows` rows under `root`, in order. */
export function rows(root: Element): RowText[] {
  return [...root.querySelectorAll<HTMLElement>("[data-list-row]")].map(
    (row) => {
      const texts = row.querySelectorAll(
        ":scope > span:not([data-row-badge]) > span",
      );
      return {
        key: row.getAttribute("data-list-row") ?? "",
        primary: texts[0]?.textContent ?? "",
        secondary: texts[1]?.textContent ?? null,
        badge:
          row
            .querySelector("[data-row-badge]")
            ?.getAttribute("data-row-badge") ?? null,
        selected: row.getAttribute("data-selected") === "true",
      };
    },
  );
}

/** Every enabled-looking seam button ("awaiting engine support") under
 *  `root`: each must be disabled. */
export function seamButtons(root: Element): HTMLButtonElement[] {
  return [...root.querySelectorAll<HTMLButtonElement>("button")].filter((b) =>
    (b.getAttribute("aria-label") ?? b.title ?? "").includes(
      "awaiting engine support",
    ),
  );
}
