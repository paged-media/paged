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

// READ parity: the catalog's read functions (`hostFunctions` of kind
// `read`), asked through every surface that reaches them on the parity
// fixture; the answers must be the same value. Two representations are the
// same value by design and are unwrapped before the comparison: a wire
// `Value` (`{ type, value }`) and an object-model read
// (`{ kind: "value", value }`) both carry `value`; a Boa function answers
// JSON text, which is parsed.

import type { BundleHost } from "@paged-media/plugin-api";

import type { HeadlessEditor } from "../harness";
import { P } from "./fixture";
import type { SurfaceId } from "./doors";

type Ask = (msg: object) => Promise<{ kind: string; payload?: unknown }>;

export interface ReadDoorSet {
  /** The wire's answer (the reference). */
  wire(ask: Ask): Promise<unknown>;
  /** A Boa expression whose value is the answer. */
  boa?: string;
  plugin?: (host: BundleHost) => Promise<unknown>;
  automation?: (ed: HeadlessEditor) => Promise<unknown>;
  /** `paged <args…>` with `{doc}` for the document; prints the wire
   *  reply envelope (or a value for `get`). */
  cli?: string[];
}

export interface ReadCase extends ReadDoorSet {
  /** The catalog function (`paged.pages`). */
  fn: string;
  /** A second read of the same function (`paged.get/swatch`). */
  variant?: string;
}

const payload = async (ask: Ask, msg: object, kind: string) => {
  const r = await ask(msg);
  if (r.kind !== kind)
    throw new Error(`wire answered ${r.kind}: ${JSON.stringify(r.payload)}`);
  return r.payload as Record<string, unknown>;
};

const collection = (fn: string, name: string): ReadCase => ({
  fn: `paged.${fn}`,
  wire: async (ask) =>
    (
      await payload(
        ask,
        { kind: "requestCollection", payload: { name } },
        "collectionReply",
      )
    )["items"],
  boa: `paged.${fn}(${fn === "collection" ? JSON.stringify(name) : ""})`,
  plugin: (host) => host.document.collection(name as never),
  cli: ["read", "collection", "{doc}", name],
});

/** Every collection the catalog names a function for, plus `collection`. */
export const READ_CASES: readonly ReadCase[] = [
  collection("pages", "pages"),
  collection("stories", "stories"),
  collection("layers", "layers"),
  collection("swatches", "swatches"),
  collection("paragraphStyles", "paragraphStyles"),
  collection("characterStyles", "characterStyles"),
  collection("objectStyles", "objectStyles"),
  collection("gradients", "gradients"),
  collection("colorGroups", "colorGroups"),
  collection("links", "links"),
  collection("conditions", "conditions"),
  collection("conditionSets", "conditionSets"),
  { ...collection("collection", "spreads"), variant: "spreads" },
  { ...collection("collection", "masterPages"), variant: "masterPages" },
  {
    fn: "paged.documentMeta",
    wire: async (ask) =>
      (
        await payload(ask, { kind: "requestDocumentMeta" }, "documentMetaReply")
      )["meta"],
    boa: "paged.documentMeta()",
    plugin: (host) => host.document.meta(),
  },
  {
    fn: "paged.tree",
    wire: async (ask) =>
      (await payload(ask, { kind: "requestSceneTree" }, "sceneTree"))["roots"],
    boa: "paged.tree()",
    plugin: (host) => host.document.tree(),
  },
  {
    fn: "paged.inspect",
    wire: async (ask) =>
      (
        await payload(
          ask,
          {
            kind: "requestElementProperties",
            payload: { id: { kind: "rectangle", id: P.frame } },
          },
          "elementProperties",
        )
      )["result"],
    boa: `paged.inspect("rectangle:${P.frame}")`,
    plugin: (host) =>
      host.document.elementProperties({
        kind: "rectangle",
        id: P.frame,
      } as never),
    cli: ["read", "element-properties", "{doc}", `rectangle:${P.frame}`],
  },
  {
    fn: "paged.query",
    wire: async (ask) =>
      (
        await payload(
          ask,
          { kind: "requestQuery", payload: { selector: "frame" } },
          "queryResult",
        )
      )["addresses"],
    boa: `paged.query("frame")`,
    plugin: (host) => host.objects.query("frame"),
    automation: (ed) => ed.automation.editor.query("frame"),
    cli: ["query", "{doc}", "frame", "--json"],
  },
  ...(
    [
      ["frame", `rectangle:${P.frame}`, "frameBounds"],
      ["swatch", "swatch:Color/Gray", "value"],
      ["page", `page:${P.page}`, "pageBounds"],
    ] as const
  ).map(([variant, address, path]): ReadCase => ({
    fn: "paged.get",
    variant,
    wire: async (ask) =>
      (
        await payload(
          ask,
          { kind: "requestGet", payload: { address, path } },
          "propertyValue",
        )
      )["value"],
    boa: `paged.get(${JSON.stringify(address)}, ${JSON.stringify(path)})`,
    plugin: (host) => host.objects.get(address, path as never),
    automation: (ed) => ed.automation.editor.get(address, path),
    cli: ["get", "{doc}", address, path],
  })),
  {
    fn: "paged.schema",
    wire: async () => null,
    boa: `paged.schema("swatch")`,
    plugin: (host) => host.objects.schema("swatch"),
    automation: (ed) => ed.automation.editor.schema("swatch"),
  },
];

export const readCaseName = (c: ReadCase) =>
  c.variant ? `${c.fn}/${c.variant}` : c.fn;

/** Which surface each read door belongs to. */
export const READ_DOORS: ReadonlyArray<{
  id: "boa" | "plugin" | "automation" | "cli";
  surface: SurfaceId;
}> = [
  { id: "boa", surface: "boa" },
  { id: "plugin", surface: "plugin-api" },
  { id: "automation", surface: "automation" },
  { id: "cli", surface: "cli" },
];

/** The value, with the representations that are the same by design
 *  unwrapped (see the header). */
export function readValue(v: unknown): unknown {
  if (typeof v === "string") {
    try {
      return readValue(JSON.parse(v));
    } catch {
      return v;
    }
  }
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).sort().join(",");
    if (keys === "type,value") return readValue(o["value"]);
    if (keys === "kind,value" && o["kind"] === "value")
      return readValue(o["value"]);
  }
  return v;
}

/** A CLI read's answer: the reply envelope's payload field the wire read
 *  takes, or the printed value. */
export function cliValue(out: string): unknown {
  const text = out.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // `paged query` prints one address per line without --json.
    return text.split("\n").filter(Boolean);
  }
  const env = parsed as { kind?: string; payload?: Record<string, unknown> };
  if (env && typeof env === "object" && env.kind && env.payload) {
    const p = env.payload;
    if ("items" in p) return p["items"];
    if ("addresses" in p) return p["addresses"];
    if ("result" in p) return p["result"];
    if ("value" in p) return p["value"];
    if ("meta" in p) return p["meta"];
  }
  return parsed;
}
