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

// The tools the model drives the document with. Fixed per mode and in a
// fixed order: they sit in the cached prefix, and the proxy rebuilds them
// server-side, so a client cannot add one.

import type Anthropic from "@anthropic-ai/sdk";

export const RUN_SCRIPT = "run_script";
export const LOOKUP_API = "lookup_api";
export const RENDER_PAGE = "render_page";

export const SCRIPT_TOOLS: Anthropic.Tool[] = [
  {
    name: RUN_SCRIPT,
    description:
      "Run a paged.* JavaScript program against the open document. Returns the console output, the error if the script threw or a budget tripped, and which stories are overset afterwards. Writes made before an error stay applied.",
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          description: "The Boa (ECMAScript) source to run.",
        },
      },
      required: ["source"],
      additionalProperties: false,
    },
  },
  {
    name: LOOKUP_API,
    description:
      "Look up the engine catalog: host functions whose name contains the query, and property paths that contain it with their type, unit and allowed values. Use it before setting a property you have not used yet.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Part of a function name or property path, e.g. insertTextFrame or StrokeWeight.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: RENDER_PAGE,
    description:
      "Render one page of the document to an image so you can judge layout and look. Costs more than a script; use it to check visual results.",
    input_schema: {
      type: "object",
      properties: {
        page: { type: "integer", description: "1-based page number." },
      },
      required: ["page"],
      additionalProperties: false,
    },
  },
];

// ─────────────────────────────── editor ADR 1241: the proposal tools
//
// Read-only: the model reads properties through the host's object model
// and answers ONE change set. No tool writes; the user previews the change
// set and the editor applies what the user approves.

export const READ_OBJECTS = "read_objects";
export const PROPOSE_CHANGES = "propose_changes";

/** The most objects one `read_objects` call answers. */
export const READ_OBJECTS_LIMIT = 60;
/** The most changes one proposal may hold. */
export const PROPOSE_CHANGES_LIMIT = 200;

export const PROPOSE_TOOLS: Anthropic.Tool[] = [
  {
    name: READ_OBJECTS,
    description:
      "Read properties of the objects a selector names (ADR 131 selectors and addresses: `frame`, `textFrame:u12`, `story`, `storyRange:u1@0..20`, `page:#2 > frame`, `style:paragraph/Caption`). Returns each object's address with the values of the paths asked for. Read-only. Objects outside what the user allowed are not answered.",
    input_schema: {
      type: "object",
      properties: {
        selector: {
          type: "string",
          description: "A selector or an address.",
        },
        paths: {
          type: "array",
          items: { type: "string" },
          description:
            "Property paths to read, e.g. characterFontSize, frameFillColor, appliedParagraphStyle, text.",
        },
      },
      required: ["selector", "paths"],
      additionalProperties: false,
    },
  },
  // lookup_api, shared with the script tools.
  SCRIPT_TOOLS[1]!,
  {
    name: PROPOSE_CHANGES,
    description:
      "Answer the user's request with ONE change set: ordinary property writes (address, path, new value) and the reason for each. Nothing is applied: the user previews the changes and approves them. Call it once, last. Propose the smallest set that does what was asked.",
    input_schema: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description: "One sentence: what the change set does.",
        },
        changes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              address: { type: "string" },
              path: { type: "string" },
              value: {},
              reason: { type: "string" },
            },
            required: ["address", "path", "value", "reason"],
            additionalProperties: false,
          },
        },
      },
      required: ["summary", "changes"],
      additionalProperties: false,
    },
  },
];

/** One change a proposal holds, as the model sent it. */
export interface ProposedChangeInput {
  address: string;
  path: string;
  value: unknown;
  reason: string;
}

export type ToolInput =
  | { name: typeof RUN_SCRIPT; source: string }
  | { name: typeof LOOKUP_API; query: string }
  | { name: typeof RENDER_PAGE; page: number }
  | { name: typeof READ_OBJECTS; selector: string; paths: string[] }
  | {
      name: typeof PROPOSE_CHANGES;
      summary: string;
      changes: ProposedChangeInput[];
    };

/** Validate a tool call's input. With eager input streaming the API no
 *  longer validates it, and the SDK's tolerant parser can hand back a
 *  truncated object — so every call is checked here before it runs. */
export function parseToolInput(name: string, input: unknown): ToolInput | null {
  if (typeof input !== "object" || input === null) return null;
  const o = input as Record<string, unknown>;
  switch (name) {
    case RUN_SCRIPT:
      return typeof o.source === "string" && o.source.trim()
        ? { name, source: o.source }
        : null;
    case LOOKUP_API:
      return typeof o.query === "string" ? { name, query: o.query } : null;
    case RENDER_PAGE:
      return typeof o.page === "number" &&
        Number.isInteger(o.page) &&
        o.page >= 1
        ? { name, page: o.page }
        : null;
    case READ_OBJECTS:
      return typeof o.selector === "string" &&
        o.selector.trim() &&
        Array.isArray(o.paths) &&
        o.paths.length > 0 &&
        o.paths.every((p) => typeof p === "string")
        ? { name, selector: o.selector, paths: o.paths as string[] }
        : null;
    case PROPOSE_CHANGES: {
      if (typeof o.summary !== "string" || !Array.isArray(o.changes))
        return null;
      if (o.changes.length > PROPOSE_CHANGES_LIMIT) return null;
      const changes: ProposedChangeInput[] = [];
      for (const c of o.changes) {
        const r = c as Record<string, unknown> | null;
        if (
          !r ||
          typeof r.address !== "string" ||
          typeof r.path !== "string" ||
          !("value" in r) ||
          typeof r.reason !== "string"
        )
          return null;
        changes.push({
          address: r.address,
          path: r.path,
          value: r.value,
          reason: r.reason,
        });
      }
      return { name, summary: o.summary, changes };
    }
    default:
      return null;
  }
}
