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

// The show's video and audio, rendered (happy-dom; slide ADR 718): a
// slide's media become media elements laid over their frames, start at
// their build step, play and pause on a click, follow the step back, and
// go when the slide is left.

import { afterEach, describe, expect, it } from "bun:test";

import type { MediaItem } from "@paged-media/plugin-api";

import type { ShowMedia } from "../../src/media";
import { MediaPlayer } from "../../src/show/media-player";
import type { ShowSlide } from "../../src/show/show-model";

const players: MediaPlayer[] = [];
afterEach(() => {
  for (const p of players.splice(0)) p.dispose();
  document.body.replaceChildren();
});

const media = (
  id: string,
  over: Partial<MediaItem>,
  step: number | null,
): ShowMedia => ({
  element: { kind: "rectangle", id } as never,
  box: { x: 100, y: 50, w: 320, h: 180 },
  media: {
    kind: "movie",
    source: { type: "part", path: `paged/core/media/${id}.mp4` },
    mime: "video/mp4",
    play: "onClick",
    volume: 0.5,
    ...over,
  } as MediaItem,
  step,
  beginMs: 0,
});

const slide = (list: ShowMedia[]): ShowSlide => ({
  pageId: "p1",
  number: 1,
  hidden: false,
  advanceAfterMs: null,
  transition: null,
  notes: "",
  sizePt: [960, 540],
  media: list,
});

function mount() {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const reads: string[] = [];
  const p = new MediaPlayer(
    el,
    window as unknown as Window,
    async (id) => {
      reads.push(String(id.id));
      return {
        media: {} as MediaItem,
        bytes: new Uint8Array([1, 2, 3]),
        url: null,
      };
    },
    // The slide drawn at half size, 10 px in.
    () => ({ x: 10, y: 0, width: 480, height: 270 }),
  );
  players.push(p);
  return { el, p, reads };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("the show's media (slide ADR 718)", () => {
  it("lays each medium over its frame, reads its bytes, starts the one of step 0", async () => {
    const { p, reads } = mount();
    p.show(slide([media("v1", { play: "auto" }, 0), media("v2", {}, null)]));
    await tick();
    expect(reads).toEqual(["v1", "v2"]);
    const [v1, v2] = p.elements();
    expect(v1!.tagName).toBe("VIDEO");
    expect(v1!.style.left).toBe("60px");
    expect(v1!.style.top).toBe("25px");
    expect(v1!.style.width).toBe("160px");
    expect(v1!.getAttribute("data-media-state")).toBe("playing");
    expect(v1!.style.visibility).toBe("visible");
    expect(v1!.volume).toBe(0.5);
    // A medium that plays when clicked waits, hidden over its poster.
    expect(v2!.getAttribute("data-media-state")).toBe("ready");
    expect(v2!.style.visibility).toBe("hidden");
  });

  it("starts at its build step, and resets when the step goes back", async () => {
    const { p } = mount();
    p.show(slide([media("v1", {}, 2)]));
    await tick();
    const [v] = p.elements();
    p.setStep(1);
    expect(v!.getAttribute("data-media-state")).toBe("ready");
    p.setStep(2);
    expect(v!.getAttribute("data-media-state")).toBe("playing");
    p.setStep(1);
    expect(v!.getAttribute("data-media-state")).toBe("ready");
  });

  it("a click on a medium plays it; outside, it does not take the click", async () => {
    const { p } = mount();
    p.show(slide([media("v1", {}, null)]));
    await tick();
    expect(p.click(10, 10)).toBe(false);
    expect(p.click(200, 100)).toBe(true);
    expect(p.elements()[0]!.getAttribute("data-media-state")).toBe("playing");
  });

  it("a sound has no box on the slide, and leaving the slide stops every medium", async () => {
    const { el, p } = mount();
    p.show(slide([media("s1", { kind: "sound", mime: "audio/mp4" }, 0)]));
    await tick();
    expect(p.elements()[0]!.tagName).toBe("AUDIO");
    expect(el.querySelectorAll("[data-show-media-item]")).toHaveLength(1);
    p.show(null);
    expect(el.querySelectorAll("[data-show-media-item]")).toHaveLength(0);
  });
});
