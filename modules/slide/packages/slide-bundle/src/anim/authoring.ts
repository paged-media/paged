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

// Authoring a slide's animations (slide ADR 714): every change is the
// slide engine's edit of the slide's timing (slide-anim, which rebuilds
// PowerPoint's own structure), written back into the slide's page label in
// one undoable step. The Animations pane, the typed commands and the
// Animation Painter all come through here.

import type { BundleHost, ElementId } from "@paged-media/plugin-api";

import type { SlideEngine } from "../engine.js";
import { setStateMutation, type SlidesStore } from "../slides-model.js";
import type {
  EffectList,
  GalleryPreset,
  TargetRef,
  Timing,
  TimingEdit,
} from "./model.js";
import { idOf, pageShapes, targetOf, type PageShapes } from "./shapes.js";

export type EditOutcome =
  { ok: true; timing: Timing } | { ok: false; reason: string };

export class AnimationAuthoring {
  private gallery: GalleryPreset[] | null = null;

  constructor(
    private readonly host: BundleHost,
    private readonly store: SlidesStore,
    private readonly engine: () => Promise<SlideEngine>,
  ) {}

  /** A slide's effects as the Animation Pane lists them. */
  async effects(pageId: string): Promise<EffectList> {
    const slide = this.store.list().find((s) => s.pageId === pageId);
    return (await this.engine()).effects(slide?.state.timing ?? null);
  }

  /** Every preset by class (cached for the session). */
  async presets(): Promise<GalleryPreset[]> {
    if (!this.gallery) this.gallery = (await this.engine()).animationGallery();
    return this.gallery;
  }

  /** The shapes on a page (targets, triggers). */
  async shapes(pageId: string): Promise<PageShapes | undefined> {
    return (await pageShapes(this.host)).get(pageId);
  }

  /** Make `edit` on the slide's timing: one undo step. */
  async edit(pageId: string, edit: TimingEdit): Promise<EditOutcome> {
    const slide = this.store.list().find((s) => s.pageId === pageId);
    if (!slide) return { ok: false, reason: `no slide ${pageId}` };
    let timing: Timing | null;
    try {
      timing = (await this.engine()).editTiming(
        slide.state.timing ?? null,
        edit,
      );
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
    // No effect left: an empty timing, so export removes the deck's.
    const next: Timing = timing ?? { nodes: [] };
    const out = await this.host.document.mutate(
      setStateMutation(pageId, { ...slide.state, timing: next }),
    );
    if (!out.applied)
      return { ok: false, reason: `the engine refused (${String(out.error)})` };
    await this.store.refresh();
    return { ok: true, timing: next };
  }

  /** The target an effect on `element` names, and how many paragraphs its
   *  text has (a build by paragraph runs over them). */
  async target(
    pageId: string,
    element: ElementId,
  ): Promise<{ target: TargetRef; paragraphs: number; hasText: boolean }> {
    const page = await this.shapes(pageId);
    const target = targetOf(page, element);
    const shape = page?.shapes.find((s) =>
      s.items.some((i) => idOf(i.id) === idOf(element)),
    );
    let paragraphs = 0;
    if (shape?.text) {
      const [g] = await this.host.document.elementGeometry([shape.text.id]);
      const storyId = (g as { storyId?: string | null } | undefined)?.storyId;
      if (storyId) {
        const content = await this.host.document.storyContent(storyId);
        paragraphs =
          content?.paragraphs.filter((p) => p.runs.some((r) => r.text !== ""))
            .length ?? 0;
      }
    }
    return { target, paragraphs, hasText: !!shape?.text };
  }

  /** Add a preset to `element` (the selection's shape). */
  async add(
    pageId: string,
    element: ElementId,
    preset: {
      presetClass: string;
      presetId: number;
      presetSubtype?: number;
      start?: "click" | "with" | "after";
      durationMs?: number;
      delayMs?: number;
      byParagraph?: boolean;
    },
  ): Promise<EditOutcome & { index?: number }> {
    const { target, paragraphs, hasText } = await this.target(pageId, element);
    const before = (await this.effects(pageId)).effects.length;
    const out = await this.edit(pageId, {
      kind: "add",
      target,
      presetClass: preset.presetClass,
      presetId: preset.presetId,
      ...(preset.presetSubtype !== undefined
        ? { presetSubtype: preset.presetSubtype }
        : {}),
      ...(preset.start ? { start: preset.start } : {}),
      ...(preset.durationMs !== undefined
        ? { durationMs: preset.durationMs }
        : {}),
      ...(preset.delayMs !== undefined ? { delayMs: preset.delayMs } : {}),
      ...(preset.byParagraph && paragraphs > 1 ? { paragraphs } : {}),
      ...(hasText ? { hasText } : {}),
    });
    return out.ok ? { ...out, index: before } : out;
  }

  /** The Animation Painter: `to` gets `from`'s effects. */
  async paint(
    pageId: string,
    from: ElementId,
    to: ElementId,
  ): Promise<EditOutcome> {
    const page = await this.shapes(pageId);
    return this.edit(pageId, {
      kind: "paint",
      from: targetOf(page, from),
      to: targetOf(page, to),
    });
  }
}
