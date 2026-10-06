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

// The REFERENCE object-model plugin (ADR 323): a tiny bundle whose state —
// a set of notes — lives OUTSIDE core, the way image layers and sheet cells
// do. It follows the label-hash pattern end to end:
//
//   · the state is a JSON document in a CONTENT-ADDRESSED part
//     (`notes/<hash>.json`, never overwritten);
//   · the host rectangle's `x-paged:acme.notes` label names the hash;
//   · every write answers `{ kind: "state", parts, host, labelKey,
//     labelValue }`, so the registry writes the part and sets the label in
//     ONE engine batch — and undo, which reverts the label, brings back
//     the previous state with no plugin-side history.
//
// Reads go label → part → state on every call: there is no cache to keep
// coherent with undo.

import type {
  BundleHost,
  ObjectOp,
  ObjectValue,
  ObjectWrite,
  PagedBundle,
  PartChange,
  PluginManifest,
  PropertySchema,
} from "@paged-media/plugin-api";

import { parseAddress, toElementId } from "../../src/object-address";

export const NOTES_ID = "acme.notes";
export const LABEL_KEY = `x-paged:${NOTES_ID}`;

export interface Note {
  text: string;
  size: number;
  visible: boolean;
  tone: "red" | "blue";
}
type State = Record<string, Note>;

export const NOTE_SCHEMA: PropertySchema[] = [
  { path: "text", type: { kind: "text" }, summary: "The note's text." },
  { path: "size", type: { kind: "number", unit: "pt" }, range: { min: 4, max: 72 }, default: 12 },
  { path: "visible", type: { kind: "bool" }, default: true },
  { path: "tone", type: { kind: "enum", members: ["red", "blue"] } },
  { path: "length", type: { kind: "number", integer: true }, access: "derived" },
];

export const notesManifest: PluginManifest = {
  id: NOTES_ID,
  name: "Notes (reference object model)",
  version: "0.0.0",
  apiVersion: "^0.2.0",
  capabilities: { document: { read: "broad", write: "broad" } },
  contributes: {
    objectModel: {
      kinds: [{ kind: "note", title: "Note", schema: NOTE_SCHEMA }],
      commands: [
        {
          id: "acme.notes.attach",
          title: "Attach notes to a frame",
          args: { kind: "struct", fields: { frame: { kind: "ref", to: "frame" }, count: { kind: "number", integer: true } } },
        },
      ],
    },
  },
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** FNV-1a, hex — content addressing, not security. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function makeNotesBundle(manifest: PluginManifest = notesManifest): PagedBundle {
  return {
    manifest,
    activate(host: BundleHost) {
      /** The frame hosting the notes (set by `attach`; one per session). */
      let hostFrame: string | null = null;

      const elementOf = (address: string) => {
        const p = parseAddress(address);
        return p ? toElementId(p) : null;
      };

      async function load(): Promise<State | null> {
        if (!hostFrame) return null;
        const id = elementOf(hostFrame);
        if (!id) return null;
        const env = await host.document.getMetadata(id);
        const h = env?.data?.["hash"];
        if (typeof h !== "string") return null;
        const bytes = await host.parts.read(`notes/${h}.json`);
        return bytes ? (JSON.parse(decoder.decode(bytes)) as State) : null;
      }

      function commit(state: State): ObjectWrite {
        const text = JSON.stringify(state);
        const h = hash(text);
        const parts: PartChange[] = [{ path: `notes/${h}.json`, bytes: encoder.encode(text) }];
        return {
          kind: "state",
          parts,
          host: hostFrame!,
          labelKey: LABEL_KEY,
          labelValue: JSON.stringify({ v: 1, data: { hash: h } }),
        };
      }

      const addr = (id: string) => `plugin:${manifest.id}/note/${id}`;
      const idOf = (address: string) => {
        const p = parseAddress(address);
        return p?.kind === "plugin" ? p.id : null;
      };

      function apply(state: State, ops: readonly ObjectOp[]): string | null {
        for (const op of ops) {
          if (op.op === "set") {
            const id = idOf(op.address);
            const note = id ? state[id] : undefined;
            if (!note) return `no note ${op.address}`;
            (note as unknown as Record<string, unknown>)[op.path] = op.value;
          } else if (op.op === "create") {
            const id = `n${Object.keys(state).length + 1}`;
            state[id] = { text: "", size: 12, visible: true, tone: "red", ...(op.props as Partial<Note>) };
          } else if (op.op === "delete") {
            const id = idOf(op.address);
            if (!id || !state[id]) return `no note ${op.address}`;
            delete state[id];
          } else {
            return `unsupported op ${op.op}`;
          }
        }
        return null;
      }

      const handle = host.contribute.objectModel({
        kinds: [
          {
            kind: "note",
            title: "Note",
            schema: NOTE_SCHEMA,
            content: { kind: "text" },
            hostOf: () => hostFrame,
            async list(query) {
              const state = await load();
              let ids = Object.keys(state ?? {});
              // Honour `text=` itself (the optimisation); the registry
              // post-filters the rest.
              const byText = query.predicates?.find((p) => p.key === "text" && p.op === "=");
              if (byText) ids = ids.filter((id) => state![id]!.text === byText.value);
              return ids.map(addr);
            },
            async get(address, path): Promise<ObjectValue> {
              const state = await load();
              const id = idOf(address);
              const note = id && state ? state[id] : undefined;
              if (!note) return { kind: "refused", code: "unknownAddress", reason: `no note ${address}` };
              if (path === "length") return { kind: "value", value: note.text.length };
              if (path === "content") return { kind: "value", value: note.text };
              if (!(path in note)) return { kind: "absent" };
              return { kind: "value", value: (note as unknown as Record<string, unknown>)[path] };
            },
            async batch(ops) {
              const state = (await load()) ?? {};
              const error = apply(state, ops);
              return error ? { kind: "rejected", reason: error } : commit(state);
            },
          },
        ],
        commands: [
          {
            id: "acme.notes.attach",
            title: "Attach notes to a frame",
            args: { kind: "struct", fields: { frame: { kind: "ref", to: "frame" }, count: { kind: "number", integer: true } } },
            async handler(ctx, args) {
              const a = args as { frame: string; count: number };
              hostFrame = a.frame;
              const ops: ObjectOp[] = [];
              for (let i = 0; i < a.count; i++) {
                ops.push({ op: "create", kind: `plugin:${manifest.id}/note`, props: { text: i === 0 ? "hello" : `note ${i + 1}` } });
              }
              const out = await ctx.objects.batch(ops);
              return out.applied ? (await ctx.objects.query("plugin:acme.notes/note")).length : -1;
            },
          },
        ],
      });
      return handle;
    },
  };
}
