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

// The MCP tool catalog of `paged mcp`, mirrored from the engine's
// `paged-mcp` crate (engine/core/crates/paged-mcp/src/tools.rs): the same
// names, titles, descriptions, input schemas and annotations, so an agent
// sees one paged server whichever CLI runs it. test/mcp-parity.spec.ts holds
// this table to the Rust CLI's recorded `tools/list` (its golden
// tests/golden/paged.mcp/tools-list.txt); change both together.

/** The MCP Apps view: one HTML resource rendered next to tool results. */
export const VIEW_URI = "ui://paged/view";
export const VIEW_MIME = "text/html;profile=mcp-app";

export interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
  /** The result has a view (VIEW_URI). */
  view: boolean;
}

/** A tool as `tools/list` answers it. */
export function toolJson(t: Tool): Record<string, unknown> {
  return {
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: {
      readOnlyHint: t.readOnly,
      destructiveHint: false,
      openWorldHint: false,
    },
    ...(t.view ? { _meta: { ui: { resourceUri: VIEW_URI } } } : {}),
  };
}

export const INSTRUCTIONS =
  "paged is a page-layout system (InDesign-class documents: IDML and .paged). " +
  "A document is a repository: versions (commits), branches and releases; a file is a projection of one version. " +
  "Read with describe_document, history, read_part and diff. To change a document, either edit it in an engine " +
  "(open_document, then run_script with paged.* JavaScript — call lookup_api first, the API is not guessable — " +
  "check with render_page, and keep the result with save_document), or write parts directly with commit_parts. " +
  "Your writes land on agent/ branches; a person merges them after review (propose_change). Never claim a change " +
  "reached main unless the tool said so.";

const schema = (
  props: Record<string, unknown>,
  required: string[],
): Record<string, unknown> => ({
  type: "object",
  properties: props,
  required,
  additionalProperties: false,
});

const doc = () => ({
  type: "string",
  description:
    "The document: its repository name, or <workspace>/<repository>.",
});

const reference = () => ({
  type: "string",
  description: "A branch, release or version address. Default: main.",
});

/** Tools that read and write repositories. */
export const STORE = [
  "list_documents",
  "describe_document",
  "read_part",
  "history",
  "diff",
  "create_branch",
  "commit_parts",
  "propose_change",
  "list_changes",
  "download_link",
] as const;
/** Tools that need a document open in an engine. */
export const ENGINE = [
  "open_document",
  "run_script",
  "render_page",
  "save_document",
] as const;
/** Tools that need no document. */
export const REFERENCE = ["lookup_api"] as const;
/** Tools that reach the user's open editor tabs (paged.server only). */
export const LIVE = ["list_live_sessions"] as const;

/** Every tool, in a stable order. */
export function catalog(): Tool[] {
  return [
    {
      name: "list_documents",
      title: "List documents",
      description: "The documents you can read, with when each last changed.",
      inputSchema: schema(
        {
          workspace: {
            type: "string",
            description: "Only this workspace's documents.",
          },
        },
        [],
      ),
      readOnly: true,
      view: false,
    },
    {
      name: "describe_document",
      title: "Describe a document",
      description:
        "A document's branches and releases, and the parts (files) of one version with their sizes.",
      inputSchema: schema({ document: doc(), ref: reference() }, ["document"]),
      readOnly: true,
      view: true,
    },
    {
      name: "read_part",
      title: "Read a part",
      description:
        "One part of a version: text parts as text (stories, styles, JSON), others as their size.",
      inputSchema: schema(
        {
          document: doc(),
          path: {
            type: "string",
            description: "The part's path, e.g. Stories/Story_u1.xml.",
          },
          ref: reference(),
        },
        ["document", "path"],
      ),
      readOnly: true,
      view: false,
    },
    {
      name: "history",
      title: "History",
      description:
        "The versions of a branch, newest first: who made each (people and agents), when, and why.",
      inputSchema: schema({ document: doc(), ref: reference() }, ["document"]),
      readOnly: true,
      view: true,
    },
    {
      name: "diff",
      title: "Compare versions",
      description: "Which parts differ between two versions or branches.",
      inputSchema: schema(
        { document: doc(), from: reference(), to: reference() },
        ["document", "from", "to"],
      ),
      readOnly: true,
      view: false,
    },
    {
      name: "create_branch",
      title: "Start a branch",
      description:
        "Starts your branch (agent/<run>/<name>) at a version, to write on without touching main.",
      inputSchema: schema(
        {
          document: doc(),
          name: {
            type: "string",
            description: "A short name: letters, digits, '-'.",
          },
          from: reference(),
        },
        ["document", "name"],
      ),
      readOnly: false,
      view: false,
    },
    {
      name: "commit_parts",
      title: "Write parts",
      description:
        "Writes parts on your branch as one new version: each part given as text or base64, or deleted.",
      inputSchema: schema(
        {
          document: doc(),
          branch: {
            type: "string",
            description: "Your branch, from create_branch.",
          },
          message: {
            type: "string",
            description: "Why: one line a person will read.",
          },
          parts: {
            type: "array",
            items: schema(
              {
                path: { type: "string" },
                text: { type: "string" },
                base64: { type: "string" },
                delete: { type: "boolean" },
              },
              ["path"],
            ),
          },
        },
        ["document", "branch", "message", "parts"],
      ),
      readOnly: false,
      view: false,
    },
    {
      name: "propose_change",
      title: "Propose a change",
      description:
        "Asks for your branch to be merged into main (or another branch). A person reviews and merges it.",
      inputSchema: schema(
        {
          document: doc(),
          branch: { type: "string" },
          title: { type: "string" },
          target: reference(),
        },
        ["document", "branch", "title"],
      ),
      readOnly: false,
      view: false,
    },
    {
      name: "list_changes",
      title: "Change requests",
      description: "Open and past change requests, with their approvals.",
      inputSchema: schema({ document: doc() }, ["document"]),
      readOnly: true,
      view: true,
    },
    {
      name: "download_link",
      title: "Download link",
      description:
        "A short-lived link to the .paged file of a version, for a person to open.",
      inputSchema: schema({ document: doc(), ref: reference() }, ["document"]),
      readOnly: true,
      view: false,
    },
    {
      name: "open_document",
      title: "Open in the engine",
      description:
        "Opens a version in the engine, for run_script and render_page.",
      inputSchema: schema({ document: doc(), ref: reference() }, ["document"]),
      readOnly: true,
      view: false,
    },
    {
      name: "run_script",
      title: "Run a script",
      description:
        "Runs paged.* JavaScript (Boa: no fetch, files or timers; about 2 s) against the open document. Returns console output, any error, and overset stories. Call lookup_api first.",
      inputSchema: schema({ source: { type: "string" } }, ["source"]),
      readOnly: false,
      view: false,
    },
    {
      name: "render_page",
      title: "Render a page",
      description:
        "A PNG of one page of the open document, to check the result.",
      inputSchema: schema(
        {
          page: {
            type: "integer",
            minimum: 1,
            description: "1-based. Default: 1.",
          },
        },
        [],
      ),
      readOnly: true,
      view: true,
    },
    {
      name: "save_document",
      title: "Save as a version",
      description: "Keeps the open document as a new version on your branch.",
      inputSchema: schema({ message: { type: "string" } }, ["message"]),
      readOnly: false,
      view: false,
    },
    {
      name: "lookup_api",
      title: "Look up the API",
      description:
        "Searches the engine's capability catalog: paged.* functions, address grammar, settable properties and their types, constraints.",
      inputSchema: schema({ query: { type: "string" } }, ["query"]),
      readOnly: true,
      view: false,
    },
    {
      name: "list_live_sessions",
      title: "Open editor tabs",
      description:
        "Your editor tabs connected to this server. Engine tools act in the tab you name; you see and can undo every step there.",
      inputSchema: schema({}, []),
      readOnly: true,
      view: false,
    },
  ];
}

/** The catalog entries named in `groups`, in catalog order. */
export function select(...groups: ReadonlyArray<readonly string[]>): Tool[] {
  const wanted = new Set(groups.flat());
  return catalog().filter((t) => wanted.has(t.name));
}
