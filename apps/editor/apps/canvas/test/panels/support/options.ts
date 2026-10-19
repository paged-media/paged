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

// Fixture content the options and text-concept panel tests need beyond
// `fixtures.ts`'s scenes: a document with conditions (no mutation
// creates one, so it is IDML built in code), a text field placeholder,
// an anchored frame and a numbering list (the engine's own mutations).

import type { ElementId, Mutation } from "@paged-media/client";
import { storedZip } from "@paged-media/test-kit";

import {
  apply,
  textScene,
  type SceneBuilder,
  type TextScene,
} from "../fixtures";

const NS =
  'xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="20.0"';
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** One page, two conditions (Draft visible, Print-only hidden) and a
 *  condition set Review naming both, in InDesign's own spelling
 *  (direct children of `<Document>`, members as typed Properties). */
export function conditionsIdml(): Uint8Array {
  const bounds = "0 0 792 612";
  const designmap =
    XML +
    `<?aid style="50" type="document" readerVersion="6.0" featureSet="257" product="20.0(32)"?>\n` +
    `<Document ${NS} Self="d" StoryList="" Name="conditions.indd">\n` +
    `<idPkg:Graphic src="Resources/Graphic.xml"/>\n<idPkg:Styles src="Resources/Styles.xml"/>\n` +
    `<Condition Self="Condition/Draft" Name="Draft" IndicatorMethod="UseHighlight" Visible="true"><Properties><IndicatorColor type="enumeration">Yellow</IndicatorColor></Properties></Condition>` +
    `<Condition Self="Condition/Print" Name="Print-only" IndicatorMethod="UseUnderline" Visible="false"><Properties><IndicatorColor type="enumeration">Green</IndicatorColor></Properties></Condition>` +
    `<ConditionSet Self="ConditionSet/Review" Name="Review"><Properties><SetConditions><VisibilityPair Condition="Condition/Draft" Visibility="true"/><VisibilityPair Condition="Condition/Print" Visibility="true"/></SetConditions></Properties></ConditionSet>` +
    `<ConditionalTextPreference ShowConditionIndicators="ShowIndicators" ActiveConditionSet="n"/>\n` +
    `<idPkg:MasterSpread src="MasterSpreads/MasterSpread_um.xml"/>\n` +
    `<idPkg:Spread src="Spreads/Spread_cp1.xml"/>\n</Document>`;
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
        `<idPkg:Graphic ${NS}><Color Self="Color/Black" Model="Process" Space="CMYK" ColorValue="0 0 0 100" Name="Black"/>` +
        `<Swatch Self="Swatch/None" Name="None"/></idPkg:Graphic>`,
    },
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
    {
      name: "MasterSpreads/MasterSpread_um.xml",
      data:
        XML +
        `<idPkg:MasterSpread ${NS}><MasterSpread Self="um" Name="A">` +
        `<Page Self="ump" Name="A" GeometricBounds="${bounds}" ItemTransform="1 0 0 1 0 0"/>` +
        `</MasterSpread></idPkg:MasterSpread>`,
    },
    {
      name: "Spreads/Spread_cp1.xml",
      data:
        XML +
        `<idPkg:Spread ${NS}>\n<Spread Self="cp1-spread" PageCount="1" ItemTransform="1 0 0 1 0 0">\n` +
        `<Page Self="cp1" Name="1" GeometricBounds="${bounds}" ItemTransform="1 0 0 1 0 0" AppliedMaster="um"/>\n` +
        `</Spread>\n</idPkg:Spread>`,
    },
  ]);
}

/** A text story with a Data Merge placeholder field at offset 0. */
export interface FieldScene extends TextScene {
  /** The field's object-model address (`field:<story>@<offset>`). */
  offset: number;
}

export const fieldScene: SceneBuilder<FieldScene> = async (ctx) => {
  const text = await textScene(ctx);
  await apply(ctx.client, {
    op: "insertField",
    args: {
      storyId: text.storyId,
      offset: 0,
      field: {
        placeholder: {
          plugin: "media.paged.data",
          key: "client",
          value: "ACME",
        },
      },
    },
  } as Mutation);
  return { ...text, offset: 0 };
};

/** A frame anchored into the text story at offset 2. */
export interface AnchoredScene extends TextScene {
  anchored: ElementId;
}

export const anchoredScene: SceneBuilder<AnchoredScene> = async (ctx) => {
  const text = await textScene(ctx);
  const payload = await apply(ctx.client, {
    op: "insertAnchoredFrame",
    args: { storyId: text.storyId, offset: 2, width: 40, height: 30 },
  } as Mutation);
  if (!payload.createdId) throw new Error("fixture: no anchored frame minted");
  return { ...text, anchored: payload.createdId };
};

/** A numbering list named Steps beside the text story. */
export interface ListScene extends TextScene {
  list: string;
}

export const listScene: SceneBuilder<ListScene> = async (ctx) => {
  const text = await textScene(ctx);
  await apply(ctx.client, {
    op: "createNumberingList",
    args: {
      spec: {
        name: "Steps",
        continueAcrossStories: false,
        continueAcrossDocuments: false,
      },
    },
  } as Mutation);
  const lists = (await ctx.client.collection("numberingLists")) as Array<{
    selfId: string;
    name: string;
  }>;
  const list = lists.find((l) => l.name === "Steps");
  if (!list) throw new Error("fixture: no numbering list Steps");
  return { ...text, list: list.selfId };
};
