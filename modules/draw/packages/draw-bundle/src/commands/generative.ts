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

// GENERATION IN DRAW (WP8.3, draw ADR 369): Text to Vector and Generative
// Recolor, through the host's doors only. No model and no key lives in this
// bundle.
//
// THE AGENT DOOR. A bundle reaches Claude through the host's shared object
// registry: the editor and the CLI register `paged.ai.complete` (plain text
// from a prompt, `@paged-media/ai`, plugin-sdk ADR 325), and
// `host.objects.invoke` calls it. The editor answers through its same-origin
// proxy (editor ADR 221), the CLI with the caller's own credential; a host
// without it (no registry, no key, the proxy's 503) refuses in its own
// words, and this module logs them. Nothing is sent but the prompt text.
//
// TEXT TO VECTOR has two routes, both ending in ordinary vector artwork:
//   · AGENT (route 1): Claude writes an SVG; it is refused when it carries
//     anything active (scripts, event handlers, external references,
//     entities), then imported through the engine's SVG door
//     (`document.importSvg`, the size guard of `importSvgFile` applies):
//     one batch, ONE undo step;
//   · IMAGE (route 2): `ml.generate@1` makes an RGBA picture (the
//     user-installed local model, extensions ADR 1100), it is placed in a
//     frame and traced by Image Trace (WP6.6). Two undo steps (place, then
//     trace). The tracer needs a browser realm to decode the picture.
//   `auto` (the default) takes route 1 and falls back to route 2 when the
//   agent refuses and the host has a generator.
//
// GENERATIVE RECOLOR asks the agent for a colour MAP only — `{ swatch ref:
// "#rrggbb" }` for the colours the selection uses — and applies it with the
// Recolor Artwork machinery's `map` mode (one batch, one undo step, tints
// kept). Refs the artwork does not use and values that are not colours are
// dropped, never applied.

import type {
  BundleHost,
  Disposable,
  ElementId,
} from "@paged-media/plugin-api";
import { parseCssColor, rgbToHex } from "@paged-media/vector-geometry";
import { bytesToBase64, encodePng } from "@paged-media/helpers";
import { defineMessages } from "@paged-media/strings";

import { registerCommand } from "../command-registry";
import { importSvgFile, MAX_SVG_BYTES } from "../io/svg";
import { resolveTargetPage } from "../target-page";
import {
  batchMutationFor,
  bindCreatedMutationFor,
  HANDLE_PREFIX,
} from "./batch-handles";
import { applyImageTrace } from "./image-trace";
import { mutateMinting } from "./minted";
import {
  applyRecolorArtwork,
  readArtworkColors,
  type ArtworkColor,
} from "./recolor";

const M = defineMessages("draw.generative", {
  textToVector:
    "Draw: Text to vector (the Claude agent writes an SVG, or a generated picture is traced)",
  generativeRecolor:
    "Color: Generative recolor (the Claude agent recolours the selection from a prompt — one undo step)",
  textToVectorOptions: "Draw: Text to vector…",
  generativeRecolorOptions: "Color: Generative recolor…",
});

export const GENERATIVE_COMMAND_CATEGORY = "Image";
export const GENERATIVE_RECOLOR_CATEGORY = "Color";
export const TEXT_TO_VECTOR_COMMAND_ID =
  "media.paged.draw.command.textToVector";
export const GENERATIVE_RECOLOR_COMMAND_ID =
  "media.paged.draw.command.generativeRecolor";
export const TEXT_TO_VECTOR_OPTIONS_COMMAND_ID =
  "media.paged.draw.command.textToVectorOptions";
export const GENERATIVE_RECOLOR_OPTIONS_COMMAND_ID =
  "media.paged.draw.command.generativeRecolorOptions";
export const GENERATIVE_COMMAND_IDS = [
  TEXT_TO_VECTOR_COMMAND_ID,
  GENERATIVE_RECOLOR_COMMAND_ID,
  TEXT_TO_VECTOR_OPTIONS_COMMAND_ID,
  GENERATIVE_RECOLOR_OPTIONS_COMMAND_ID,
] as const;
export const GENERATIVE_PANEL_ID = "media.paged.draw.panel.generative";

/** The host's typed command for plain text from Claude. */
export const AGENT_COMPLETE_COMMAND = "paged.ai.complete";
/** The longest prompt a user's words may add to ours (characters). */
export const MAX_SUBJECT_CHARS = 2000;

export type GenerativeRoute = "auto" | "agent" | "image";
export const GENERATIVE_ROUTES: readonly GenerativeRoute[] = [
  "auto",
  "agent",
  "image",
];

// ------------------------------------------------------------- the agent

/** Ask the host's agent for plain text. Throws the refusal's words. */
export async function askAgent(
  host: BundleHost,
  prompt: string,
): Promise<string> {
  if (!host.supports("objects.shared@1")) {
    throw new Error(
      "the host shares no object registry, so no agent is reachable",
    );
  }
  let answer: unknown;
  try {
    answer = await host.objects.invoke(AGENT_COMPLETE_COMMAND, { prompt });
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    throw new Error(
      why.startsWith("unknownCommand")
        ? "this host has no Claude agent (paged.ai.complete is not registered)"
        : why,
    );
  }
  if (typeof answer !== "string" || answer.trim() === "") {
    throw new Error("the agent answered with no text");
  }
  return answer;
}

// ------------------------------------------------------- text to vector

/** The prompt that makes Claude write a drawable, safe SVG. Pure. */
export function svgPromptFor(subject: string): string {
  return [
    "Draw the following as a vector illustration and reply with ONE complete SVG document and nothing else (no Markdown fence, no commentary).",
    'Rules: root <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">; use only <path>, <rect>, <circle>, <ellipse>, <polygon>, <polyline>, <line>, <g>, <defs>, <linearGradient>, <radialGradient>, <stop>, <clipPath> and <use> to a local #id; flat colours and gradients; no <script>, no <style>, no <text>, no <image>, no filters, no external links, no event attributes; at most 120 shapes; keep a margin of 16 units.',
    `Subject: ${subject.trim().slice(0, MAX_SUBJECT_CHARS)}`,
  ].join("\n");
}

/** The SVG document inside an agent's reply (a fence or a sentence around
 *  it is tolerated), or null. Pure. */
export function extractSvg(reply: string): string | null {
  const start = reply.search(/<svg[\s>]/i);
  const end = reply.toLowerCase().lastIndexOf("</svg>");
  if (start < 0 || end < start) return null;
  return reply.slice(start, end + "</svg>".length);
}

/** Why an SVG must not be imported, or null when it is plain drawing.
 *  Pure. The importer reads no script, but an agent's text is untrusted
 *  input, so anything active or external is refused outright rather than
 *  cleaned. */
export function svgRefusal(svg: string): string | null {
  const rules: [RegExp, string][] = [
    [/<\s*script/i, "it contains a script"],
    [/<\s*foreignObject/i, "it contains a foreignObject"],
    [
      /<\s*(iframe|embed|object|audio|video|animate|set)\b/i,
      "it contains active content",
    ],
    [/\son[a-z]+\s*=/i, "it contains an event handler"],
    [/javascript\s*:/i, "it contains a javascript: link"],
    [/<!\s*(DOCTYPE|ENTITY)/i, "it declares a DOCTYPE or an entity"],
    [
      /(?:xlink:)?href\s*=\s*["']\s*(?!#)/i,
      "it references something outside itself",
    ],
    [/url\(\s*["']?\s*(?!#)/i, "it references something outside itself"],
  ];
  for (const [re, why] of rules) if (re.test(svg)) return why;
  return null;
}

export interface TextToVectorRequest {
  prompt: string;
  route: GenerativeRoute;
}

export function textToVectorRequestFrom(payload: unknown): TextToVectorRequest {
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<
    string,
    unknown
  >;
  return {
    prompt: typeof p.prompt === "string" ? p.prompt.trim() : "",
    route: GENERATIVE_ROUTES.includes(p.route as GenerativeRoute)
      ? (p.route as GenerativeRoute)
      : "auto",
  };
}

export interface GenerativeOutcome {
  applied: boolean;
  /** Which route made the artwork. */
  route?: "agent" | "image";
  ids: ElementId[];
  /** Why nothing applied (also logged). */
  reason?: string;
}

const refused = (host: BundleHost, reason: string): GenerativeOutcome => {
  host.log.warn(`${TEXT_TO_VECTOR_COMMAND_ID}: ${reason}`);
  return { applied: false, ids: [], reason };
};

/** Route 1: the agent writes the SVG, the engine imports it. */
export async function textToVectorByAgent(
  host: BundleHost,
  subject: string,
): Promise<GenerativeOutcome> {
  let reply: string;
  try {
    reply = await askAgent(host, svgPromptFor(subject));
  } catch (e) {
    return refused(host, e instanceof Error ? e.message : String(e));
  }
  const svg = extractSvg(reply);
  if (!svg) return refused(host, "the agent's answer holds no SVG document");
  const why = svgRefusal(svg);
  if (why) return refused(host, `the agent's SVG was refused: ${why}`);
  const bytes = new TextEncoder().encode(svg);
  if (bytes.byteLength > MAX_SVG_BYTES)
    return refused(host, "the agent's SVG is too large");
  const { result, ids } = await importSvgFile(
    host,
    TEXT_TO_VECTOR_COMMAND_ID,
    "text-to-vector.svg",
    bytes,
    // Centred on the page, one group: a drawing, not loose shapes.
    { group: true },
  );
  if (!result?.applied || ids.length === 0) {
    return {
      applied: false,
      ids: [],
      reason: result?.error ?? "nothing was imported",
    };
  }
  await host.selection.set([ids[ids.length - 1]]);
  return { applied: true, route: "agent", ids };
}

/** What the picture route asks the model for: flat shapes trace well. */
export const imagePromptFor = (subject: string): string =>
  `${subject.trim().slice(0, MAX_SUBJECT_CHARS)}, flat vector illustration, solid colours, clean shapes, plain white background`;

/** The side (pt) of the frame the generated picture is placed in. */
async function frameSideFor(
  host: BundleHost,
  pageId: string,
): Promise<{ side: number; page: [number, number] }> {
  try {
    const pages = await host.document.collection<{
      selfId?: string;
      sizePt?: [number, number];
    }>("pages");
    const page = pages.find((p) => p.selfId === pageId)?.sizePt;
    if (page && page[0] > 0 && page[1] > 0)
      return { side: 0.7 * Math.min(page[0], page[1]), page };
  } catch {
    /* fall through */
  }
  return { side: 360, page: [612, 792] };
}

/** Route 2: `ml.generate@1`, a frame, Image Trace. */
export async function textToVectorByImage(
  host: BundleHost,
  subject: string,
  tracePayload: unknown = { preset: "colors16" },
): Promise<GenerativeOutcome> {
  let image;
  try {
    // The registry's own sentence when no model runs.
    image = (
      await host.ml.generate({
        prompt: imagePromptFor(subject),
        width: 768,
        height: 768,
      })
    ).image;
  } catch (e) {
    return refused(host, e instanceof Error ? e.message : String(e));
  }
  const pageId = await resolveTargetPage(host);
  if (!pageId) return refused(host, "no target page");
  const png = await encodePng(image);
  const { side, page } = await frameSideFor(host, pageId);
  const left = (page[0] - side) / 2;
  const top = (page[1] - side) / 2;
  const placed = await mutateMinting(
    host,
    batchMutationFor([
      {
        op: "insertFrame",
        args: { pageId, bounds: [top, left, top + side, left + side] },
      },
      bindCreatedMutationFor("generated"),
      {
        op: "placeImage",
        args: {
          elementId: `${HANDLE_PREFIX}generated`,
          uri: `data:image/png;base64,${bytesToBase64(png)}`,
          fit: "ContentToFrame",
        },
      },
    ]),
  );
  if (!placed.outcome.applied) {
    return refused(
      host,
      `the picture could not be placed: ${JSON.stringify(placed.outcome.error)}`,
    );
  }
  const created = placed.minted[0]?.element;
  if (!created) return refused(host, "the placed picture was not reported");
  await host.selection.set([created]);
  const traced = await applyImageTrace(host, tracePayload);
  if (traced.length === 0) {
    // The picture stays placed (one undo step removes it); say why.
    return {
      applied: false,
      route: "image",
      ids: [created],
      reason:
        "the picture was generated and placed, but Image Trace made nothing (see the log)",
    };
  }
  return { applied: true, route: "image", ids: traced };
}

/** **TEXT TO VECTOR** (module header). */
export async function applyTextToVector(
  host: BundleHost,
  payload?: unknown,
): Promise<GenerativeOutcome> {
  const request = textToVectorRequestFrom(payload);
  if (request.prompt === "") {
    return refused(host, "say what to draw: the prompt is empty");
  }
  if (request.route === "image") {
    return textToVectorByImage(host, request.prompt);
  }
  const first = await textToVectorByAgent(host, request.prompt);
  if (first.applied || request.route === "agent") return first;
  if (!host.supports("ml.generate@1")) return first;
  host.log.info(
    `${TEXT_TO_VECTOR_COMMAND_ID}: the agent route failed (${first.reason}); trying the generated-picture route`,
  );
  return textToVectorByImage(host, request.prompt);
}

// ----------------------------------------------------- generative recolor

/** The prompt that makes Claude answer with a colour map. Pure. */
export function recolorPromptFor(
  colors: readonly ArtworkColor[],
  wish: string,
): string {
  const rows = colors.map(
    (c) =>
      `${JSON.stringify(c.ref)}: ${rgbToHex(c.rgb)} (${c.name}, used ${c.weight}×)`,
  );
  return [
    'Recolour vector artwork. Reply with ONE JSON object and nothing else: keys are the swatch ids below, values are the new colours as "#rrggbb". Include only the colours that should change. Keep the artwork readable (keep contrast between neighbouring colours).',
    "Colours used by the artwork:",
    ...rows,
    `Wish: ${wish.trim().slice(0, MAX_SUBJECT_CHARS)}`,
  ].join("\n");
}

/** The colour map inside an agent's reply: known refs only, valid colours
 *  only, normalised to `#rrggbb`. Pure. Empty when nothing usable. */
export function parseColorMap(
  reply: string,
  colors: readonly ArtworkColor[],
): Record<string, string> {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end < start) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const known = new Set(colors.map((c) => c.ref));
  const out: Record<string, string> = {};
  for (const [ref, to] of Object.entries(parsed as Record<string, unknown>)) {
    if (!known.has(ref) || typeof to !== "string") continue;
    const rgb = parseCssColor(to.trim());
    if (rgb) out[ref] = rgbToHex(rgb);
  }
  return out;
}

export interface GenerativeRecolorOutcome {
  applied: boolean;
  changed: number;
  reason?: string;
}

/** **GENERATIVE RECOLOR** (module header). */
export async function applyGenerativeRecolor(
  host: BundleHost,
  payload?: unknown,
): Promise<GenerativeRecolorOutcome> {
  const label = GENERATIVE_RECOLOR_COMMAND_ID;
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<
    string,
    unknown
  >;
  const wish = typeof p.prompt === "string" ? p.prompt.trim() : "";
  const none = (reason: string): GenerativeRecolorOutcome => {
    host.log.warn(`${label}: ${reason}`);
    return { applied: false, changed: 0, reason };
  };
  if (wish === "") return none("say how to recolour: the prompt is empty");
  const read = await readArtworkColors(host);
  if (read.colors.length === 0)
    return none("the selection carries no colour to recolour");
  let reply: string;
  try {
    reply = await askAgent(host, recolorPromptFor(read.colors, wish));
  } catch (e) {
    return none(e instanceof Error ? e.message : String(e));
  }
  const map = parseColorMap(reply, read.colors);
  if (Object.keys(map).length === 0)
    return none("the agent's answer holds no usable colour map");
  const outcome = await applyRecolorArtwork(host, { mode: "map", map });
  return outcome.applied
    ? { applied: true, changed: outcome.changed }
    : { applied: false, changed: 0, reason: "the recolour changed nothing" };
}

// -------------------------------------------------------------- commands

export function contributeGenerativeCommands(host: BundleHost): Disposable {
  const disposers = [
    registerCommand(host, {
      id: TEXT_TO_VECTOR_COMMAND_ID,
      title: M.textToVector,
      category: GENERATIVE_COMMAND_CATEGORY,
      handler: (_paged, payload) =>
        applyTextToVector(host, payload).then(() => undefined),
    }),
    registerCommand(host, {
      id: GENERATIVE_RECOLOR_COMMAND_ID,
      title: M.generativeRecolor,
      category: GENERATIVE_RECOLOR_CATEGORY,
      handler: (_paged, payload) =>
        applyGenerativeRecolor(host, payload).then(() => undefined),
    }),
    ...(
      [
        [
          TEXT_TO_VECTOR_OPTIONS_COMMAND_ID,
          M.textToVectorOptions,
          GENERATIVE_COMMAND_CATEGORY,
        ],
        [
          GENERATIVE_RECOLOR_OPTIONS_COMMAND_ID,
          M.generativeRecolorOptions,
          GENERATIVE_RECOLOR_CATEGORY,
        ],
      ] as const
    ).map(([id, title, category]) =>
      registerCommand(host, {
        id,
        title,
        category,
        // Both rows raise the one panel, where the prompt is typed.
        handler: async () => {
          if (host.supports("shell.openPanel@1")) {
            await host.shell.openPanel(GENERATIVE_PANEL_ID);
            return;
          }
          host.log.info(
            `${id}: this host cannot raise the panel — run ${TEXT_TO_VECTOR_COMMAND_ID} or ${GENERATIVE_RECOLOR_COMMAND_ID} with a prompt`,
          );
        },
      }),
    ),
  ];
  return {
    dispose() {
      for (const d of disposers) d.dispose();
    },
  };
}
