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

// The X-Ray fixture (editor ADRs 1233, 1234): one page holding every fact
// Document X-Ray and the Typography Debugger answer, built in code like the
// interaction contract's fixtures (FIXTURES.md). A based-on chain of
// paragraph styles (Base ← Body ← Head), a character style and a local
// override; an object style chain (Box ← BoxChild) on a locked rectangle;
// a rectangle on a locked layer; two frames placing the same missing
// picture; a thread of two frames whose story is overset; and a justified,
// hyphenated story in a narrow frame. Positions are page-local pt on a
// 612 × 792 page; boxes are IDML's `[top, left, bottom, right]`.

import { storedZip } from "@paged-media/test-kit";

export const IDML_MIME = "application/vnd.adobe.indesign-idml-package";
const PKG =
  'xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"';

export const XRAY = {
  pageId: "xrP",
  /** "Plain " (Body) + "emph" (Emph) + " big" (14 pt locally), then
   *  "Heading" (Head). Character offsets: emph 6–10, big 10–14. */
  text: { frame: "xrT1", story: "xrS1" },
  locked: "xrBox",
  lockedLayer: "xrOnLock",
  layerLock: { id: "xrLLock", name: "Locked art" },
  pictures: ["xrImg1", "xrImg2"] as const,
  link: "file:///nowhere/photo.jpg",
  thread: { first: "xrT2", last: "xrT3", story: "xrS2" },
  justified: { frame: "xrTJ", story: "xrSJ" },
} as const;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<idPkg:Styles ${PKG} DOMVersion="20.0">
<RootCharacterStyleGroup Self="rc">
<CharacterStyle Self="CharacterStyle/$ID/[No character style]" Name="$ID/[No character style]"/>
<CharacterStyle Self="CharacterStyle/Emph" Name="Emph" FillColor="Color/Blue"/>
</RootCharacterStyleGroup>
<RootParagraphStyleGroup Self="rp">
<ParagraphStyle Self="ParagraphStyle/$ID/[No paragraph style]" Name="$ID/[No paragraph style]"/>
<ParagraphStyle Self="ParagraphStyle/Base" Name="Base" PointSize="10" Leading="12" FillColor="Color/Black" SpaceAfter="6"/>
<ParagraphStyle Self="ParagraphStyle/Body" Name="Body" FillColor="Color/Red"><Properties><BasedOn type="object">ParagraphStyle/Base</BasedOn></Properties></ParagraphStyle>
<ParagraphStyle Self="ParagraphStyle/Head" Name="Head" PointSize="18"><Properties><BasedOn type="object">ParagraphStyle/Body</BasedOn></Properties></ParagraphStyle>
<ParagraphStyle Self="ParagraphStyle/Just" Name="Just" PointSize="10" Leading="12" Justification="LeftJustified" Hyphenation="true"/>
</RootParagraphStyleGroup>
<RootObjectStyleGroup Self="ro">
<ObjectStyle Self="ObjectStyle/$ID/[None]" Name="$ID/[None]"/>
<ObjectStyle Self="ObjectStyle/Box" Name="Box" FillColor="Color/Red"/>
<ObjectStyle Self="ObjectStyle/BoxChild" Name="BoxChild"><Properties><BasedOn type="object">ObjectStyle/Box</BasedOn></Properties></ObjectStyle>
</RootObjectStyleGroup>
</idPkg:Styles>`;

const run = (style: string, text: string, extra = "") =>
  `<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/${style}"${extra}><Content>${text}</Content></CharacterStyleRange>`;

const story = (id: string, body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Story ${PKG} DOMVersion="20.0"><Story Self="${id}">${body}</Story></idPkg:Story>`;

const rect = (id: string, box: string, extra: string, inner = "") =>
  `<Rectangle Self="${id}" GeometricBounds="${box}" ItemTransform="1 0 0 1 0 0" ${extra}>${inner}</Rectangle>`;

/** The fixture's IDML package. */
export function xrayFixture(): Uint8Array {
  const X = XRAY;
  const image = (link: string) =>
    `<Image Self="${link}i" ItemTransform="1 0 0 1 0 0"><Link Self="${link}" LinkResourceURI="${X.link}"/></Image>`;
  const items = [
    `<TextFrame Self="${X.text.frame}" ParentStory="${X.text.story}" GeometricBounds="48 48 160 300" ItemTransform="1 0 0 1 0 0"/>`,
    rect(
      X.locked,
      "48 340 120 440",
      'Locked="true" AppliedObjectStyle="ObjectStyle/BoxChild"',
    ),
    rect(
      X.lockedLayer,
      "48 460 120 560",
      `ItemLayer="${X.layerLock.id}" FillColor="Color/Blue"`,
    ),
    rect(X.pictures[0], "180 340 260 440", "", image("xrL1")),
    rect(X.pictures[1], "180 460 260 560", "", image("xrL2")),
    `<TextFrame Self="${X.thread.first}" ParentStory="${X.thread.story}" NextTextFrame="${X.thread.last}" GeometricBounds="300 48 340 200" ItemTransform="1 0 0 1 0 0"/>`,
    `<TextFrame Self="${X.thread.last}" ParentStory="${X.thread.story}" PreviousTextFrame="${X.thread.first}" GeometricBounds="300 240 340 392" ItemTransform="1 0 0 1 0 0"/>`,
    `<TextFrame Self="${X.justified.frame}" ParentStory="${X.justified.story}" GeometricBounds="400 48 700 138" ItemTransform="1 0 0 1 0 0"/>`,
  ].join("\n");
  const designmap = `<?xml version="1.0" encoding="UTF-8"?>
<Document DOMVersion="20.0" Self="d" ${PKG}>
<idPkg:Styles src="Resources/Styles.xml"/>
<Layer Self="xrLBody" Name="Layer 1" Visible="true" Locked="false" Printable="true"/>
<Layer Self="${X.layerLock.id}" Name="${X.layerLock.name}" Visible="true" Locked="true" Printable="true"/>
<idPkg:Spread src="Spreads/Spread_xr.xml"/>
<idPkg:Story src="Stories/Story_${X.text.story}.xml"/>
<idPkg:Story src="Stories/Story_${X.thread.story}.xml"/>
<idPkg:Story src="Stories/Story_${X.justified.story}.xml"/>
</Document>`;
  const spread = `<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Spread ${PKG} DOMVersion="20.0">
<Spread Self="xrSpread" PageCount="1" BindingLocation="0" ItemTransform="1 0 0 1 0 0">
<Page Self="${X.pageId}" Name="1" GeometricBounds="0 0 792 612" ItemTransform="1 0 0 1 0 0"/>
${items}
</Spread></idPkg:Spread>`;
  const s1 =
    `<ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/Body">` +
    run("$ID/[No character style]", "Plain ") +
    run("Emph", "emph") +
    run("$ID/[No character style]", " big", ' PointSize="14"') +
    `<Br/></ParagraphStyleRange>` +
    `<ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/Head">` +
    run("$ID/[No character style]", "Heading") +
    `</ParagraphStyleRange>`;
  const s2 =
    `<ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/Base">` +
    run(
      "$ID/[No character style]",
      "Threaded text runs from the first frame into the second and on past it. ".repeat(
        10,
      ),
    ) +
    `</ParagraphStyleRange>`;
  const sj =
    `<ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/Just">` +
    run(
      "$ID/[No character style]",
      "Typographers internationalize characteristically extraordinary paragraphs with considerable responsibility, and a narrow column makes every decision visible to the reader.",
    ) +
    `</ParagraphStyleRange>`;
  return storedZip([
    { name: "mimetype", data: IDML_MIME },
    { name: "designmap.xml", data: designmap },
    { name: "Resources/Styles.xml", data: STYLES },
    { name: "Spreads/Spread_xr.xml", data: spread },
    {
      name: `Stories/Story_${X.text.story}.xml`,
      data: story(X.text.story, s1),
    },
    {
      name: `Stories/Story_${X.thread.story}.xml`,
      data: story(X.thread.story, s2),
    },
    {
      name: `Stories/Story_${X.justified.story}.xml`,
      data: story(X.justified.story, sj),
    },
  ]);
}
