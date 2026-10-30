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

// Typed commands over the ML doors (extensions ADR 1100), so a script, a
// template run and `paged-node invoke` can generate and edit images:
//
//   paged-node invoke doc.paged paged.ml.generate '{"prompt":"…"}' --result-out out.png
//   await paged.invoke("paged.ml.generate", { prompt: "…", width: 512, height: 512 })
//
// A host registers them as its own (`registry.register({ plugin: "paged.ml",
// model: mlObjectModel(backend, codec) })`). Images cross as PNG bytes; the
// host's codec turns them into the doors' RGBA images and back.

import type {
  MlImage,
  MlMask,
  ObjectModelContribution,
} from "@paged-media/plugin-api";

import type { MlBackend } from "./doors-ml.js";
import { ML_MAX_REFERENCES, checkMlRequest } from "./doors-ml.js";
import type { MlPngCodec } from "./ml-host-client.js";

export const ML_GENERATE_COMMAND = "paged.ml.generate";
export const ML_EDIT_COMMAND = "paged.ml.edit";

const RESULT = {
  kind: "struct",
  fields: {
    png: { kind: "bytes", mime: ["image/png"] },
    width: { kind: "number", integer: true },
    height: { kind: "number", integer: true },
    provider: { kind: "text" },
    tier: { kind: "enum", members: ["A", "B"] },
    model: { kind: "text", optional: true },
  },
} as const;

const toMask = (image: MlImage): MlMask => {
  const data = new Uint8Array(image.width * image.height);
  for (let i = 0; i < data.length; i++) data[i] = image.data[i * 4]!;
  return { width: image.width, height: image.height, data };
};

export function mlObjectModel(
  backend: MlBackend,
  codec: MlPngCodec,
): ObjectModelContribution {
  const answer = async (r: {
    image: MlImage;
    provider: string;
    tier: "A" | "B";
    model?: string;
  }) => ({
    png: await codec.encode(r.image),
    width: r.image.width,
    height: r.image.height,
    provider: r.provider,
    tier: r.tier,
    ...(r.model !== undefined ? { model: r.model } : {}),
  });
  return {
    kinds: [],
    commands: [
      {
        id: ML_GENERATE_COMMAND,
        title: "Generate an image from a prompt",
        args: {
          kind: "struct",
          fields: {
            prompt: { kind: "text", multiline: true, maxLength: 4000 },
            negativePrompt: {
              kind: "text",
              multiline: true,
              maxLength: 4000,
              optional: true,
            },
            width: { kind: "number", integer: true, default: 1024 },
            height: { kind: "number", integer: true, default: 1024 },
            seed: { kind: "number", integer: true, optional: true },
            steps: { kind: "number", integer: true, optional: true },
          },
        },
        result: RESULT,
        async handler(_ctx, args) {
          const a = args as {
            prompt: string;
            negativePrompt?: string;
            width: number;
            height: number;
            seed?: number;
            steps?: number;
          };
          const request = {
            prompt: a.prompt,
            width: a.width,
            height: a.height,
            ...(a.negativePrompt ? { negativePrompt: a.negativePrompt } : {}),
            ...(a.seed !== undefined ? { seed: a.seed } : {}),
            ...(a.steps !== undefined ? { steps: a.steps } : {}),
          };
          checkMlRequest("generate", request);
          return answer(await backend.run("generate", request));
        },
      },
      {
        id: ML_EDIT_COMMAND,
        title:
          "Edit an image with a prompt (inside a mask, guided by references)",
        args: {
          kind: "struct",
          fields: {
            prompt: { kind: "text", multiline: true, maxLength: 4000 },
            image: { kind: "bytes", mime: ["image/png"] },
            mask: { kind: "bytes", mime: ["image/png"], optional: true },
            references: {
              kind: "list",
              of: { kind: "bytes", mime: ["image/png"] },
              maxItems: ML_MAX_REFERENCES,
              optional: true,
            },
            seed: { kind: "number", integer: true, optional: true },
            steps: { kind: "number", integer: true, optional: true },
            strength: { kind: "number", optional: true },
          },
        },
        result: RESULT,
        async handler(_ctx, args) {
          const a = args as {
            prompt: string;
            image: Uint8Array;
            mask?: Uint8Array;
            references?: Uint8Array[];
            seed?: number;
            steps?: number;
            strength?: number;
          };
          const request = {
            prompt: a.prompt,
            image: await codec.decode(a.image),
            ...(a.mask ? { mask: toMask(await codec.decode(a.mask)) } : {}),
            ...(a.references?.length
              ? {
                  references: await Promise.all(
                    a.references.map((r) => codec.decode(r)),
                  ),
                }
              : {}),
            ...(a.seed !== undefined ? { seed: a.seed } : {}),
            ...(a.steps !== undefined ? { steps: a.steps } : {}),
            ...(a.strength !== undefined ? { strength: a.strength } : {}),
          };
          checkMlRequest("edit", request);
          return answer(await backend.run("edit", request));
        },
      },
    ],
  };
}
