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

// The editor's OWN handle, faked: the contract fake (plugin-sdk's
// `createFakeEditor`) plus the members the editor's built-in tools reach
// for and a bundle never sees — the CanvasClient's typed gesture methods
// (`beginGesture` / `updateGesture` / `commitGesture` / `cancelGesture`,
// all through the recorded gesture channel), the live camera buffer
// (`client.camera.read()`), `marqueeHits`, `requestSnapshot`, the
// tool-settings store, and the content-selection setter.
//
// Built here, not in the public SDK: these are the editor's internals,
// and a community plugin must not learn to depend on them. A test hands
// `fake.shell` to a built-in handler (cast to the shell's `PagedEditor`:
// the fake is structural, the handler reads only what it uses).

import {
  createFakeEditor,
  type FakeEditor,
  type FakeEditorOptions,
} from "@paged-media/plugin-sdk/gesture-kit";
import type {
  ElementId,
  GestureType,
  MainToWorkerKind,
  WorkerToMain,
} from "@paged-media/plugin-api";

export type ToolSettingValue = string | number | boolean;

export interface ShellFakeOptions extends FakeEditorOptions {
  /** Tool-scoped settings, `{ [toolId]: { [key]: value } }`. */
  toolSettings?: Record<string, Record<string, ToolSettingValue>>;
  /** The `requestSnapshot` answer (PNG bytes of a page at a width). */
  snapshot?: (
    pageId: string,
    targetWidthPx: number,
  ) => { pngBytes: number[]; widthPx: number; heightPx: number } | null;
}

export interface ShellFakeEditor extends FakeEditor {
  /** The shell-shaped handle: hand it to a built-in tool's handler. */
  readonly shell: ShellEditorLike;
  /** Set a tool setting (what the tool-options popover writes). */
  setToolSetting(toolId: string, key: string, value: ToolSettingValue): void;
  /** The content selection the handle was last given (a caret). */
  contentSelection(): unknown;
}

/** The structural shape the built-in handlers read. */
export interface ShellEditorLike {
  client: Record<string, unknown> & {
    send(message: MainToWorkerKind): Promise<WorkerToMain>;
    camera: { read(): { scale: number; tx: number; ty: number } };
  };
  [member: string]: unknown;
}

const describe = (reply: WorkerToMain) =>
  JSON.stringify((reply as { payload?: unknown }).payload ?? null).slice(
    0,
    200,
  );

/** A fake of the editor's own `PagedEditor` for the built-in tools. */
export function createFakeShellEditor(
  options: ShellFakeOptions = {},
): ShellFakeEditor {
  const snapshot = options.snapshot;
  const fake = createFakeEditor({
    ...options,
    reply(message) {
      const scripted = options.reply?.(message);
      if (scripted) return scripted;
      if (message.kind === "requestSnapshot") {
        const p = message.payload as { pageId: string; targetWidthPx: number };
        const shot = snapshot?.(p.pageId, p.targetWidthPx) ?? null;
        return shot
          ? { kind: "snapshotReady", payload: { pageId: p.pageId, ...shot } }
          : {
              kind: "snapshotFailed",
              payload: { error: { kind: "noSnapshot" } },
            };
      }
      return undefined;
    },
  });
  const settings = new Map<string, Record<string, ToolSettingValue>>(
    Object.entries(options.toolSettings ?? {}),
  );
  let content: unknown = null;
  const base = fake.editor;
  const send = base.client.send;

  const client = {
    ...base.client,
    camera: { read: () => fake.camera() },
    async marqueeHits(
      pageId: string,
      rect: [number, number, number, number],
    ): Promise<ElementId[]> {
      const r = await send({
        kind: "requestMarqueeHits",
        payload: { pageId, rect },
      });
      return r.kind === "marqueeHits" ? r.payload.ids : [];
    },
    async requestSnapshot(pageId: string, targetWidthPx: number, dpi?: number) {
      const r = await send({
        kind: "requestSnapshot",
        payload: { pageId, targetWidthPx, dpi: dpi ?? null },
      });
      if (r.kind === "snapshotReady") return r.payload;
      throw new Error(`snapshot failed: ${describe(r)}`);
    },
    async beginGesture(
      nodes: ElementId[],
      gesture: GestureType,
      anchor: unknown = null,
    ): Promise<number> {
      const r = await send({
        kind: "beginGesture",
        payload: {
          nodes,
          gesture,
          anchor: anchor as never,
          cameraScale: fake.camera().scale,
        },
      });
      if (r.kind === "gestureBegun") return r.payload.handle;
      throw new Error(`beginGesture failed: ${describe(r)}`);
    },
    async updateGesture(
      handle: number,
      delta: [number, number],
      modifiers: { shift: boolean; alt: boolean; disableSnap?: boolean },
      mode: "json" | "sab" = "json",
    ) {
      // The SAB lane posts no message in the editor; the fake records it
      // on the same channel (with the lane) so a test sees every delta.
      const r = await send({
        kind: "updateGesture",
        payload: { handle, delta, modifiers, lane: mode } as never,
      });
      if (r.kind === "gestureUpdated")
        return {
          pageIds: r.payload.pageIds,
          snapLines: r.payload.snapLines ?? [],
        };
      throw new Error(`updateGesture failed: ${describe(r)}`);
    },
    async commitGesture(handle: number) {
      const r = await send({ kind: "commitGesture", payload: { handle } });
      if (r.kind === "gestureCommitted")
        return { appliedSeq: r.payload.appliedSeq, pageIds: r.payload.pageIds };
      throw new Error(`commitGesture failed: ${describe(r)}`);
    },
    async cancelGesture(handle: number) {
      const r = await send({ kind: "cancelGesture", payload: { handle } });
      if (r.kind === "gestureCancelled") return r.payload.pageIds;
      throw new Error(`cancelGesture failed: ${describe(r)}`);
    },
  };

  const shell: ShellEditorLike = {
    ...base,
    client,
    selection: base.selection,
    camera: base.camera,
    toolSettings: {
      getValue: (toolId: string, key: string) => settings.get(toolId)?.[key],
      get: (toolId: string) => ({ ...(settings.get(toolId) ?? {}) }),
      set: (toolId: string, key: string, value: ToolSettingValue) => {
        settings.set(toolId, { ...(settings.get(toolId) ?? {}), [key]: value });
      },
      subscribe: () => () => {},
    },
    contentSelection: {
      get contentSelection() {
        return content;
      },
      setContentSelection(value: unknown) {
        content = value;
        fake.record({
          channel: "extra",
          member: "contentSelection.setContentSelection",
          args: [value],
        });
      },
    },
  };

  return Object.assign(fake, {
    shell,
    setToolSetting(toolId: string, key: string, value: ToolSettingValue) {
      settings.set(toolId, { ...(settings.get(toolId) ?? {}), [key]: value });
    },
    contentSelection: () => content,
  });
}
