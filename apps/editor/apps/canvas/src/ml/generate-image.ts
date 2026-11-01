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

// Generate Image, the host's (editor ADR 313): fills ANY image frame of the
// page, in a document, a deck, a sheet or a publication, with a picture made
// from a prompt through the ML doors (`ml.generate@1`, extensions ADR 1100).
// The frame is a page item, so one runner serves every module.
//
//   · one graphic frame selected (empty or already holding a picture): the
//     picture replaces its content, through `replaceImageBytes`, the lane
//     Place uses;
//   · anything else: a new image frame is minted on the current page and
//     filled in the SAME batch, so the insert is one undo step and a refusal
//     leaves nothing behind.
//
// Nothing is generated before the model answers, so a refusal (the
// registry's sentence: "local image model not running…") changes nothing.
// No model is bundled or downloaded here: the local host is user-installed
// (Settings ▸ Models, editor ADR 290).

import type { ElementId, Mutation } from "@paged-media/client";
import type { MlCallOptions, MlGenerateRequest } from "@paged-media/plugin-api";
import type { PagedEditor } from "@paged-media/shell";
import { mutateAndSelect } from "@paged-media/tools";
import { defineMessages, t } from "@paged-media/strings";

import {
  blockedFor,
  centeredBoundsOn,
  currentPageTarget,
  outcomeOf,
  refusedTap,
  REFUSED,
  type InsertOutcome,
  type InsertReport,
} from "../insert-commands";
import type { GeneratedImage } from "./service";

const M = defineMessages("app.generateImage", {
  needsPrompt:
    "Generate image needs a prompt: say what the picture should show.",
  failed: "Generate image failed: {error}",
});

/** The generator a host lends the runner (the ML service's, or a test's). */
export type ImageGenerator = (
  request: MlGenerateRequest,
  options?: MlCallOptions,
) => Promise<GeneratedImage>;

/** The longest side a generated picture is asked for. */
export const GENERATE_SIDE = 1024;
export const GENERATE_MIN_SIDE = 64;
export const GENERATE_MAX_SIDE = 4096;
/** A new frame is this fraction of the page's shorter side on its long side. */
export const GENERATE_FRAME_FRACTION = 0.6;

/** The model's size for an aspect: the long side `GENERATE_SIDE`, both sides
 *  multiples of 8 within 64 to 4096 (the doors' rule). */
export function generationSize(
  width: number,
  height: number,
): { width: number; height: number } {
  const k = GENERATE_SIDE / Math.max(width, height, 1);
  const snap = (v: number) =>
    Math.min(
      GENERATE_MAX_SIDE,
      Math.max(GENERATE_MIN_SIDE, Math.round((v * k) / 8) * 8),
    );
  return { width: snap(width), height: snap(height) };
}

export interface GenerateImageRequest {
  prompt: string;
  negativePrompt?: string;
  /** The picture's aspect (any units); default: the selected frame's, else square. */
  aspect?: { width: number; height: number };
  seed?: number;
  steps?: number;
}

export interface GenerateImageOutcome extends InsertOutcome {
  provider?: string;
  model?: string;
  /** True when a new frame was minted (false: the selected frame was filled). */
  created?: boolean;
}

/** The selected graphic frame (empty or holding a picture) and its size. */
async function selectedGraphicFrame(
  paged: PagedEditor,
): Promise<{ id: ElementId; width: number; height: number } | null> {
  const selected = paged.selection.elementSelection;
  if (selected.length !== 1) return null;
  const [id] = selected;
  if (id.kind !== "rectangle" && id.kind !== "oval" && id.kind !== "polygon") {
    return null;
  }
  try {
    const [g] = await paged.client.elementGeometry([id]);
    if (!g) return null;
    const [top, left, bottom, right] = g.bounds;
    return { id, width: right - left, height: bottom - top };
  } catch {
    return null;
  }
}

export async function generateImage(
  paged: PagedEditor,
  report: InsertReport,
  generate: ImageGenerator,
  request: GenerateImageRequest,
  options: MlCallOptions = {},
): Promise<GenerateImageOutcome> {
  const verb = "Generate image";
  if (blockedFor(paged, report, verb)) return REFUSED;
  const prompt = request.prompt.trim();
  if (!prompt) {
    report("info", t(M.needsPrompt));
    return REFUSED;
  }
  const into = await selectedGraphicFrame(paged);
  const target = into ? null : currentPageTarget(paged);
  if (!into && !target) return REFUSED;
  const aspect = request.aspect ??
    (into ? { width: into.width, height: into.height } : undefined) ?? {
      width: 1,
      height: 1,
    };
  const size = generationSize(aspect.width, aspect.height);

  let made: GeneratedImage;
  try {
    made = await generate(
      {
        prompt,
        ...(request.negativePrompt
          ? { negativePrompt: request.negativePrompt }
          : {}),
        width: size.width,
        height: size.height,
        ...(request.seed !== undefined ? { seed: request.seed } : {}),
        ...(request.steps !== undefined ? { steps: request.steps } : {}),
      },
      options,
    );
  } catch (err) {
    // The registry's own sentence, and nothing was changed.
    if (options.signal?.aborted) return REFUSED;
    report(
      "error",
      t(M.failed, { error: err instanceof Error ? err.message : String(err) }),
    );
    return REFUSED;
  }
  const bytes = Array.from(made.png);
  const tap = refusedTap(report, verb);
  let mutation: Mutation;
  if (into) {
    mutation = {
      op: "replaceImageBytes",
      args: { elementId: into.id.id as string, bytes },
    } as Mutation;
  } else {
    const page = target!;
    const fit = GENERATE_FRAME_FRACTION * Math.min(page.rect.w, page.rect.h);
    const k = fit / Math.max(aspect.width, aspect.height);
    mutation = {
      op: "batch",
      args: {
        ops: [
          {
            op: "insertFrame",
            args: {
              pageId: page.pageId,
              bounds: centeredBoundsOn(
                page.rect,
                aspect.width * k,
                aspect.height * k,
              ),
            },
          },
          { op: "bindCreated", args: { handle: "frame" } },
          {
            op: "replaceImageBytes",
            args: { elementId: "$h:frame", bytes },
          },
        ],
      },
    } as Mutation;
  }
  const outcome = outcomeOf(
    await mutateAndSelect(paged, mutation, "generateImage", tap),
  );
  if (!outcome.applied) return REFUSED;
  return {
    ...outcome,
    provider: made.provider,
    ...(made.model !== undefined ? { model: made.model } : {}),
    created: !into,
  };
}

/** What the `paged.insert.generateImage` handler needs of its host. */
export interface GenerateImageCommandDeps {
  generate: ImageGenerator;
  report: InsertReport;
}

/** The handler of `paged.insert.generateImage` `{ prompt, aspect?, seed?,
 *  steps? }` (registered with the insert commands): the panel's action as a
 *  command, so a script or a test generates without the panel. The menu row
 *  opens the panel (a prompt needs a field). */
export function generateImageHandler(
  deps: GenerateImageCommandDeps,
): (paged: PagedEditor, payload?: unknown) => Promise<GenerateImageOutcome> {
  return (paged, payload) => {
    const p = (payload ?? {}) as Partial<GenerateImageRequest>;
    return generateImage(paged, deps.report, deps.generate, {
      ...p,
      prompt: typeof p.prompt === "string" ? p.prompt : "",
    });
  };
}
