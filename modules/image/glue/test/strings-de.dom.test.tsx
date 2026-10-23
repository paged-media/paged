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

// The image bundle in German (plan E10): its panel sections, tool options
// and properties panel read the active catalogue, and the bundle registers
// its own German beside its English.

import { afterEach, describe, expect, it } from "bun:test";
import {
  BUILT_IN_LOCALES,
  createStrings,
  setActiveStrings,
} from "@paged-media/strings";
import { cleanup, render } from "@testing-library/react";

// The bundle's entry registers the German catalogue.
import "../src/activate";
import { ChannelsSection, LayersSection } from "../src/panels/image-panel";
import { imagePropertiesPanel } from "../src/panels/properties-panel";
import { toolOptionFields } from "../src/tool-options";

afterEach(() => {
  cleanup();
  setActiveStrings(createStrings());
});

const german = () => setActiveStrings(createStrings("de", BUILT_IN_LOCALES.de));

const noop = () => {};

describe("the image bundle in German", () => {
  it("renders the Layers and Channels sections in German", () => {
    german();
    const view = render(
      <>
        <LayersSection
          layers={[]}
          active={0}
          history={null}
          blendModes={[]}
          layersNote={null}
          gpu
          disabled={false}
          onSelect={noop}
          onAdd={noop}
          onDuplicate={noop}
          onRemove={noop}
          onMove={noop}
          onVisible={noop}
          onOpacity={noop}
          onBlend={noop}
          onLock={noop}
          onAddAdjustment={noop}
          onMaskFromSelection={noop}
          onMaskToggle={noop}
          onClip={noop}
          groups={[]}
          onGroup={noop}
          onUngroup={noop}
          onGroupVisible={noop}
          onGroupOpacity={noop}
          onGroupPassThrough={noop}
          onMaskClear={noop}
          onUndoTo={noop}
          onRedoTo={noop}
          onBake={noop}
          onUndo={noop}
          onRedo={noop}
        />
        <ChannelsSection
          channels={null}
          disabled={false}
          onLoadSelection={noop}
        />
      </>,
    );
    const text = view.container.textContent ?? "";
    expect(text).toContain("Ebene hinzufügen");
    expect(text).toContain("Einstellungsebene hinzufügen");
    expect(text).toContain("Kanäle");
    expect(text).not.toContain("Add layer");
  });

  it("labels the tool options and the properties panel in German", () => {
    german();
    const fields = toolOptionFields({
      brush: "b",
      pencil: "p",
      eraser: "e",
      wand: "w",
      bucket: "k",
      gradient: "g",
    });
    expect(fields.b!.map((f) => f.label)).toEqual([
      "Größe",
      "Härte",
      "Deckkraft",
      "Fluss",
    ]);
    const panel = imagePropertiesPanel();
    expect(panel.title).toBe("Bildeigenschaften");
    expect(panel.sections.map((s) => s.title)).toContain("Ebenen");
  });

  it("stays English by default", () => {
    expect(imagePropertiesPanel().title).toBe("Image properties");
  });
});
