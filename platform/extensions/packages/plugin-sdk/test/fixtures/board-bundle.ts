/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * This file is part of paged (https://paged.media) and is additionally
 * available under the Paged Media Enterprise License (PMEL). Full
 * copyright and license information is available in LICENSE.md which is
 * distributed with this source code.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    MPL-2.0 OR Paged Media Enterprise License (PMEL)
 */

// A TWO-KIND object-model plugin whose kinds share ONE state — the shape
// of paged.image (layers + adjustments in one stack) and paged.sheet
// (sheets + cells in one workbook). `board` carries the title, `card` the
// cards; both live in one content-addressed JSON part whose hash is the
// plugin's label on a host (a frame, a page or the document).
//
// Options exercise the contract fix-ups:
//   · `pluginBatch` — plan through the plugin-level `batch` (one plan for
//     both kinds) or per kind (the registry must refuse the conflict);
//   · `labelMode` — write the whole envelope under `x-paged:<id>`, or a
//     sub-key `x-paged:<id>.hash` the registry merges into `data`;
//   · `host` — where the label lives (frame / page / doc).
// The state is read back through `host.objects.get(host, "labels")`, the
// core seam's label read, so the fixture also proves that path.

import type {
  BundleHost,
  ObjectKindContribution,
  ObjectOp,
  ObjectValue,
  ObjectWrite,
  PagedBundle,
  PluginManifest,
  PropertySchema,
} from "@paged-media/plugin-api";

import { parseAddress } from "../../src/object-address";

export const BOARD_ID = "acme.board";
export const BOARD = `plugin:${BOARD_ID}/board`;
export const CARD = `plugin:${BOARD_ID}/card`;

interface State {
  title: string;
  cards: Record<string, string>;
}

export interface BoardOptions {
  pluginBatch?: boolean;
  labelMode?: "full" | "sub";
  /** The label host, fixed at attach time. */
  host?: "frame" | "page" | "doc";
}

const BOARD_SCHEMA: PropertySchema[] = [{ path: "title", type: { kind: "text" } }];
const CARD_SCHEMA: PropertySchema[] = [
  { path: "text", type: { kind: "text" } },
  { path: "thumbnail", type: { kind: "bytes" }, access: "readOnly", heavy: true },
];

export const EXPORT_ARGS = {
  kind: "struct",
  fields: {
    format: { kind: "enum", members: ["pdf", "png"], default: "pdf" },
    scale: { kind: "number", default: 1 },
    pages: { kind: "list", of: { kind: "number", integer: true }, optional: true },
    target: { kind: "ref", to: "frame" },
  },
} as const;

export function boardManifest(): PluginManifest {
  return {
    id: BOARD_ID,
    name: "Board (two kinds, one state)",
    version: "0.0.0",
    apiVersion: "^0.2.0",
    capabilities: { document: { read: "broad", write: "broad" } },
    contributes: {
      objectModel: {
        kinds: [
          { kind: "board", title: "Board", schema: BOARD_SCHEMA },
          { kind: "card", title: "Card", schema: CARD_SCHEMA },
        ],
        commands: [
          { id: "acme.board.attach", title: "Attach a board", args: { kind: "struct", fields: { host: { kind: "text" }, frame: { kind: "text" } } } },
          { id: "acme.board.export", title: "Export", args: EXPORT_ARGS as never },
        ],
      },
    },
  };
}

const enc = new TextEncoder();
const dec = new TextDecoder();
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** Observability for the specs. */
export interface BoardProbe {
  gets: string[];
  lists: Array<string | undefined>;
  exportArgs: unknown[];
  /** One entry per planner call: the op count it received. */
  plans: number[];
}

export function makeBoardBundle(options: BoardOptions = {}, probe?: BoardProbe): PagedBundle {
  const manifest = boardManifest();
  const mode = options.labelMode ?? "full";
  return {
    manifest,
    activate(host: BundleHost) {
      /** The label host and the frame the board belongs to. */
      let labelHost: string | null = null;
      let frame: string | null = null;
      const objects = host.objects;

      async function load(): Promise<State> {
        const empty: State = { title: "", cards: {} };
        if (!labelHost) return empty;
        const r = await objects.get(labelHost, "labels");
        if (r.kind !== "value") return empty;
        const text = (r.value as Record<string, string>)[`x-paged:${BOARD_ID}`];
        if (!text) return empty;
        const h = (JSON.parse(text) as { data: { hash?: string } }).data.hash;
        if (!h) return empty;
        const bytes = await host.parts.read(`board/${h}.json`);
        return bytes ? (JSON.parse(dec.decode(bytes)) as State) : empty;
      }

      function commit(state: State): ObjectWrite {
        const text = JSON.stringify(state);
        const h = hash(text);
        const parts = [{ path: `board/${h}.json`, bytes: enc.encode(text) }];
        return mode === "full"
          ? { kind: "state", parts, host: labelHost!, labelKey: `x-paged:${BOARD_ID}`, labelValue: JSON.stringify({ v: 1, data: { hash: h } }) }
          : { kind: "state", parts, host: labelHost!, labelKey: `x-paged:${BOARD_ID}.hash`, labelValue: JSON.stringify(h) };
      }

      const idOf = (a: string) => {
        const p = parseAddress(a);
        return p?.kind === "plugin" ? p.id : null;
      };

      function apply(state: State, ops: readonly ObjectOp[]): string | null {
        for (const op of ops) {
          if (op.op === "set") {
            const p = parseAddress(op.address);
            if (p?.kind !== "plugin") return `bad ${op.address}`;
            if (p.objectKind === "board") state.title = String(op.value);
            else if (state.cards[p.id] !== undefined) state.cards[p.id] = String(op.value);
            else return `no card ${op.address}`;
          } else if (op.op === "create" && op.kind === CARD) {
            const id = `c${Object.keys(state.cards).length + 1}`;
            state.cards[id] = String(op.props?.["text"] ?? "");
          } else {
            return `unsupported ${op.op}`;
          }
        }
        return null;
      }
      const plan = async (ops: readonly ObjectOp[]): Promise<ObjectWrite> => {
        probe?.plans.push(ops.length);
        const state = await load();
        const e = apply(state, ops);
        return e ? { kind: "rejected", reason: e } : commit(state);
      };

      const kind = (name: "board" | "card"): ObjectKindContribution => ({
        kind: name,
        title: name,
        schema: name === "board" ? BOARD_SCHEMA : CARD_SCHEMA,
        ...(name === "card" ? { content: { kind: "text" as const } } : {}),
        // ASYNC on purpose (fix-up 4).
        hostOf: async () => frame,
        async list(q) {
          probe?.lists.push(q.within);
          if (!frame) return [];
          // A card list scoped by a board: only that board's cards (one
          // board per session, so: the board or nothing).
          if (q.within !== undefined && q.within !== `${BOARD}/main`) {
            const idOfItem = (a: string | null) => {
              const p = a ? parseAddress(a) : null;
              return p && (p.kind === "item" || p.kind === "frame") ? p.id : null;
            };
            const wid = idOfItem(q.within);
            if (!wid || wid !== idOfItem(frame)) return [];
          }
          if (name === "board") return [`${BOARD}/main`];
          return Object.keys((await load()).cards).map((id) => `${CARD}/${id}`);
        },
        async get(address, path): Promise<ObjectValue> {
          probe?.gets.push(`${address}#${path}`);
          const state = await load();
          if (name === "board") return path === "title" ? { kind: "value", value: state.title } : { kind: "absent" };
          const id = idOf(address);
          const text = id ? state.cards[id] : undefined;
          if (text === undefined) return { kind: "refused", code: "unknownAddress", reason: address };
          if (path === "thumbnail") return { kind: "value", value: new Uint8Array(4) };
          return { kind: "value", value: text };
        },
        // Per-kind planner: what a plugin WITHOUT the plugin-level hook has.
        batch: plan,
      });

      return host.contribute.objectModel({
        kinds: [kind("board"), kind("card")],
        ...(options.pluginBatch ? { batch: plan } : {}),
        commands: [
          {
            id: "acme.board.attach",
            title: "Attach a board",
            args: { kind: "struct", fields: { host: { kind: "text" }, frame: { kind: "text" } } },
            async handler(ctx, args) {
              const a = args as { host: string; frame: string };
              labelHost = a.host;
              frame = a.frame;
              const out = await ctx.objects.batch([
                { op: "set", address: `${BOARD}/main`, path: "title", value: "Board" },
                { op: "create", kind: CARD, props: { text: "one" } },
              ]);
              return out.applied;
            },
          },
          {
            id: "acme.board.export",
            title: "Export",
            args: EXPORT_ARGS as never,
            handler(_ctx, args) {
              probe?.exportArgs.push(args);
              return true;
            },
          },
        ],
      });
    },
  };
}
