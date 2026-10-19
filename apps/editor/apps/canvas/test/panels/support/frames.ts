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

// Shared helpers for the frame-property panel tests (Object/Transform,
// Text Frame, Text Wrap, Frame Fitting, Effects, Attributes, Align,
// Pathfinder, Layers): wire-shape builders, what a field shows, and a
// scene with a placed image.

import type { ElementId, Mutation } from "@paged-media/client";

import {
  apply,
  richScene,
  type RichScene,
  type SceneBuilder,
} from "../fixtures";
import type { PanelHarness } from "../harness";

/** The ADR 131 address of a page item (`rectangle:u2`). */
export const addr = (id: ElementId | { kind: string; id: unknown }) =>
  `${id.kind}:${String(id.id)}`;

/** The object-model write a schema-driven field sends. */
export const set = (address: string, path: string, value: unknown) => ({
  op: "set",
  args: { address, path, value },
});

/** Several writes as the one batch a multi-selection edit sends. */
export const batch = (...ops: unknown[]) => ({ op: "batch", args: { ops } });

// Numbers ride the wire as `length` (Value has no number variant).
export const len = (value: number | null) => ({ type: "length", value });
export const bool = (value: boolean) => ({ type: "bool", value });
export const text = (value: string) => ({ type: "text", value });
export const bounds = (value: [number, number, number, number]) => ({
  type: "bounds",
  value,
});

type H = PanelHarness<unknown>;

/** A field's binding state (`none` / `value` / `mixed` / `absent`). */
export const state = (h: H, path: string) =>
  h.field(path).getAttribute("data-binding-state");

/** What one field shows: its text input, the active toggle segment, the
 *  checked switch, or its select's value. */
export function shown(h: H, path: string): string | null {
  const f = h.field(path);
  const input = f.querySelector("input");
  if (input) return input.value;
  const active = f.querySelector('[data-active="true"]');
  if (active) return active.getAttribute("data-option-value");
  const sw = f.querySelector('[role="switch"]');
  if (sw) return sw.getAttribute("aria-checked");
  const select = f.querySelector("select");
  return select ? select.value : null;
}

/** Every native control under `el` is disabled. */
export function allDisabled(el: Element): boolean {
  const controls = [
    ...el.querySelectorAll<HTMLButtonElement>("input, select, button"),
  ];
  return controls.length > 0 && controls.every((c) => c.disabled);
}

/** One of BoundsInput's four cells (`T` / `L` / `B` / `R`) in a field. */
export function boundsCell(h: H, path: string, side: "T" | "L" | "B" | "R") {
  const cell = h
    .field(path)
    .querySelector<HTMLInputElement>(`input[aria-label="${side}"]`);
  if (!cell) throw new Error(`no ${side} cell in ${path}`);
  return cell;
}

/** The rich scene with an image placed in its rectangle (the link points
 *  at a file that is not there: no corpus, and nothing renders). */
export type ImageScene = RichScene & { imageFrame: ElementId };

export const imageScene: SceneBuilder<ImageScene> = async (ctx) => {
  const scene = await richScene(ctx);
  await apply(ctx.client, {
    op: "placeImage",
    args: {
      elementId: String(scene.rect.id),
      uri: "file:///fixtures/photo.png",
    },
  } as Mutation);
  return { ...scene, imageFrame: scene.rect };
};
