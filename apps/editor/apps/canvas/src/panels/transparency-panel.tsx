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

// Editor ADR 309 — the Transparency panel (Illustrator's): the selection's
// blend mode and opacity, and its opacity mask — the mask artwork's
// thumbnail, Make and Release, the mask's mode, Clip and Invert Mask, and
// Edit Mask, which selects the mask artwork so the Color, Swatches,
// Gradient and Stroke panels edit it while it masks.
//
// Every control is an object-model field or one wire op: the blend list
// is the schema row's members (blend modes are core's, plan C1), the mask
// options are the `opacityMaskType` / `opacityMaskInvert` /
// `opacityMaskClip` rows (one write, one undo step each), Make is
// `applyOpacityMask` with the selection's top item as the mask and Release
// `releaseOpacityMask`. The thumbnail is a snapshot of the mask item alone
// (`only`), refreshed when the page renders again.

import { useEffect, useState, type ReactNode } from "react";

import {
  ObjectFieldFrame,
  TogglePill,
  useCanvasClient,
  useDocument,
  useObjectBindings,
  useSelection,
  type ObjectField,
} from "@paged-media/shell";
import type { ElementId } from "@paged-media/client";
import { KitSelect, NumberInput } from "@paged-media/ui";
import { defineMessages, useStrings, type Strings } from "@paged-media/strings";

import { schemaBlendModes } from "./effects-panel";

const M = defineMessages("app.transparencyPanel", {
  blend: "Blend",
  opacity: "Opacity",
  opacityMask: "Opacity mask",
  noMask: "No opacity mask",
  make: "Make mask",
  release: "Release",
  clip: "Clip",
  invert: "Invert mask",
  mode: "Mode",
  luminosity: "Luminosity",
  alpha: "Alpha",
  edit: "Edit mask",
  stopEditing: "Stop editing mask",
  editing: "Editing the opacity mask: the panels edit its artwork.",
  thumbnail: "The mask artwork",
  makeHint: "Select two items: the top one becomes the mask.",
});

const BINDINGS = {
  blend: { path: "frameBlendMode", scope: "element" as const },
  opacity: { path: "frameOpacity", scope: "element" as const },
  mask: { path: "opacityMask", scope: "element" as const },
  maskType: { path: "opacityMaskType", scope: "element" as const },
  invert: { path: "opacityMaskInvert", scope: "element" as const },
  clip: { path: "opacityMaskClip", scope: "element" as const },
};

/** The kinds that take part in an opacity mask, on either side. */
const MASKABLE = ["rectangle", "oval", "polygon", "graphicLine"];

type Ref = { kind: string; id: string };

const keyOf = (r: { kind: string; id: unknown }) => `${r.kind}:${String(r.id)}`;

const raw = (f: ObjectField): unknown =>
  f.state.state === "value" ? f.state.value : undefined;

/** The mask item's id a target reads (`opacityMask`), or null. */
function maskIdOf(f: ObjectField): string | null {
  const v = raw(f);
  if (typeof v === "string" && v) return v.includes(":") ? v.split(":")[1]! : v;
  return null;
}

/** The selection ordered top to bottom by the scene tree's paint order
 *  (`frames_in_order`, back to front). Ids the tree does not list sort to
 *  the back. */
export function topToBottom(
  selection: readonly Ref[],
  paintOrder: readonly string[],
): Ref[] {
  const rank = new Map(paintOrder.map((k, i) => [k, i] as const));
  return selection
    .map((id, i) => ({ id, i, z: rank.get(keyOf(id)) ?? -1 }))
    .sort((a, b) => (a.z !== b.z ? b.z - a.z : a.i - b.i))
    .map((e) => e.id);
}

type Tree = { id?: { kind: string; id: unknown } | null; children?: Tree[] };

function paintOrder(roots: readonly Tree[]): string[] {
  const out: string[] = [];
  const walk = (nodes: readonly Tree[]) => {
    for (const n of nodes) {
      if (n.id) out.push(keyOf(n.id));
      if (n.children) walk(n.children);
    }
  };
  walk(roots);
  return out;
}

type Client = ReturnType<typeof useCanvasClient>;

/** The mask item's element id: the mask is no page item of its own while
 *  it masks, so its kind is found by asking the engine for its geometry. */
async function maskRefOf(client: Client, id: string): Promise<Ref | null> {
  for (const kind of MASKABLE) {
    const ref = { kind, id } as unknown as ElementId;
    const items = await client.elementGeometry([ref]).catch(() => []);
    if (items.length > 0) return { kind, id };
  }
  return null;
}

/** The mask artwork drawn alone, small. */
function MaskThumbnail({
  target,
  maskId,
  refresh,
  label,
}: {
  target: Ref;
  maskId: string;
  refresh: string;
  label: string;
}) {
  const client = useCanvasClient();
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let made: string | null = null;
    void (async () => {
      const geo = await client
        .elementGeometry([target as unknown as ElementId])
        .catch(() => []);
      const pageId = geo[0]?.pageId;
      if (!pageId) return;
      const snap = await client
        .requestSnapshot(pageId, 96, undefined, {
          only: [{ kind: "rectangle", id: maskId } as unknown as ElementId],
          background: "transparent",
          trim: true,
        })
        .catch(() => null);
      if (cancelled || !snap?.pngBytes?.length) return;
      made = URL.createObjectURL(
        new Blob([new Uint8Array(snap.pngBytes)], { type: "image/png" }),
      );
      setUrl(made);
    })();
    return () => {
      cancelled = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [client, target, maskId, refresh]);
  return (
    <div
      data-mask-thumbnail={url ? "ready" : "pending"}
      title={label}
      className="flex h-[48px] w-[48px] items-center justify-center overflow-hidden rounded border border-input"
      style={{
        background:
          "repeating-conic-gradient(var(--pg-muted) 0 25%, transparent 0 50%) 50% / 8px 8px",
      }}
    >
      {url && (
        <img
          src={url}
          alt={label}
          className="max-h-full max-w-full object-contain"
        />
      )}
    </div>
  );
}

function ActionButton({
  hook,
  label,
  disabled,
  onClick,
}: {
  hook: string;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-mask-action={hook}
      disabled={disabled}
      onClick={onClick}
      className="h-[24px] rounded border border-input px-2 text-xs disabled:opacity-40"
    >
      {label}
    </button>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[84px_1fr] items-center gap-2">
      <span className="text-xs" style={{ color: "var(--pg-muted-fg)" }}>
        {label}
      </span>
      {children}
    </div>
  );
}

function MaskOption({
  field,
  hook,
  label,
}: {
  field: ObjectField;
  hook: string;
  label: string;
}) {
  const v = raw(field);
  return (
    <ObjectFieldFrame
      field={field}
      className="relative flex items-center gap-[9px] py-[2px]"
    >
      <TogglePill
        checked={v === true}
        disabled={field.commit == null}
        onToggle={(next) => void field.commit?.(next)}
        testId={`mask:${hook}`}
        label={label}
      />
      <span className="flex-1 text-xs">{label}</span>
    </ObjectFieldFrame>
  );
}

function modeMembers(field: ObjectField): readonly string[] {
  const t = field.row?.type as { kind?: string; members?: readonly string[] };
  return t?.kind === "enum" && t.members?.length
    ? t.members
    : ["luminosity", "alpha"];
}

function modeLabel(strings: Strings, m: string): string {
  const key = (M as Record<string, string>)[m];
  return key ? strings.t(key) : m;
}

export function TransparencyPanel() {
  const strings = useStrings();
  const client = useCanvasClient();
  const { snapshots } = useDocument();
  const { elementSelection, setElementSelection, setElementGeometry } =
    useSelection();
  const fields = useObjectBindings(BINDINGS);
  const [editing, setEditing] = useState<{ target: Ref; mask: Ref } | null>(
    null,
  );

  const selection = elementSelection as unknown as Ref[];
  const target = selection.length === 1 ? selection[0]! : null;
  const maskId = target && !editing ? maskIdOf(fields.mask) : null;
  const masked = maskId != null;
  const canMake =
    !editing &&
    selection.length === 2 &&
    selection.every((s) => MASKABLE.includes(s.kind));

  const select = async (ref: Ref) => {
    const ids = await client.setElementSelection(
      [ref as unknown as ElementId],
      "replace",
    );
    setElementSelection(ids);
    setElementGeometry(await client.elementGeometry(ids).catch(() => []));
  };

  const make = async () => {
    const roots = (await client.sceneTree().catch(() => [])) as Tree[];
    const [top, below] = topToBottom(selection, paintOrder(roots));
    if (!top || !below) return;
    const reply = await client.mutate({
      op: "applyOpacityMask",
      args: { targetId: below, maskId: top },
    } as never);
    if (reply.kind === "mutationApplied") await select(below);
  };

  const release = async () => {
    if (!target) return;
    await client.mutate({
      op: "releaseOpacityMask",
      args: { targetId: target },
    } as never);
  };

  const editMask = async () => {
    if (!target || !maskId) return;
    const mask = await maskRefOf(client, maskId);
    if (!mask) return;
    setEditing({ target, mask });
    await select(mask);
  };

  const stopEditing = async () => {
    const was = editing;
    setEditing(null);
    if (was) await select(was.target);
  };

  const opacity = raw(fields.opacity);
  const blendValue = raw(fields.blend);
  const blendMixed = fields.blend.state.state === "mixed";
  const modes = schemaBlendModes(strings, fields.blend.row);
  const pageThumb = [...snapshots.values()].join("|");
  const refresh = [
    maskId,
    raw(fields.maskType),
    raw(fields.invert),
    raw(fields.clip),
    pageThumb,
  ].join("/");

  return (
    <div
      className="p-3 flex flex-col gap-[9px]"
      data-transparency-panel="ready"
      data-mask-state={editing ? "editing" : masked ? "masked" : "none"}
    >
      <ObjectFieldFrame field={fields.blend} className="relative">
        <Row label={strings.t(M.blend)}>
          <KitSelect
            aria-label={strings.t(M.blend)}
            value={
              blendMixed
                ? "__mixed__"
                : typeof blendValue === "string" && blendValue
                  ? blendValue
                  : "Normal"
            }
            soft={blendMixed}
            disabled={fields.blend.commit == null}
            data-transparency-blend=""
            onChange={(e) => {
              if (e.target.value !== "__mixed__")
                void fields.blend.commit?.(e.target.value);
            }}
          >
            {blendMixed && (
              <option value="__mixed__" disabled>
                —
              </option>
            )}
            {modes.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </KitSelect>
        </Row>
      </ObjectFieldFrame>
      <ObjectFieldFrame field={fields.opacity} className="relative">
        <Row label={strings.t(M.opacity)}>
          <NumberInput
            suffix="%"
            value={
              fields.opacity.state.state === "value"
                ? typeof opacity === "number"
                  ? opacity
                  : 100
                : null
            }
            min={0}
            max={100}
            precision={0}
            disabled={fields.opacity.commit == null}
            onChange={() => {}}
            onCommit={(v) => void fields.opacity.commit?.(v)}
            aria-label={strings.t(M.opacity)}
          />
        </Row>
      </ObjectFieldFrame>

      <div
        className="-mx-3 flex flex-col gap-[6px] border-t border-input px-3 pt-2"
        data-transparency-mask=""
      >
        <div className="pg-label">{strings.t(M.opacityMask)}</div>
        {editing ? (
          <>
            <span
              className="text-xs"
              data-mask-editing=""
              style={{ color: "var(--pg-primary)" }}
            >
              {strings.t(M.editing)}
            </span>
            <ActionButton
              hook="stop"
              label={strings.t(M.stopEditing)}
              onClick={() => void stopEditing()}
            />
          </>
        ) : (
          <>
            <div className="flex items-center gap-2">
              {masked && target ? (
                <MaskThumbnail
                  target={target}
                  maskId={maskId}
                  refresh={refresh}
                  label={strings.t(M.thumbnail)}
                />
              ) : (
                <span
                  className="text-xs"
                  style={{ color: "var(--pg-muted-fg)" }}
                >
                  {canMake ? strings.t(M.makeHint) : strings.t(M.noMask)}
                </span>
              )}
              <div className="flex flex-1 flex-wrap justify-end gap-1">
                {masked ? (
                  <>
                    <ActionButton
                      hook="edit"
                      label={strings.t(M.edit)}
                      onClick={() => void editMask()}
                    />
                    <ActionButton
                      hook="release"
                      label={strings.t(M.release)}
                      onClick={() => void release()}
                    />
                  </>
                ) : (
                  <ActionButton
                    hook="make"
                    label={strings.t(M.make)}
                    disabled={!canMake}
                    onClick={() => void make()}
                  />
                )}
              </div>
            </div>
            {masked && (
              <>
                <MaskOption
                  field={fields.clip}
                  hook="clip"
                  label={strings.t(M.clip)}
                />
                <MaskOption
                  field={fields.invert}
                  hook="invert"
                  label={strings.t(M.invert)}
                />
                <ObjectFieldFrame field={fields.maskType} className="relative">
                  <Row label={strings.t(M.mode)}>
                    <KitSelect
                      aria-label={strings.t(M.mode)}
                      data-mask-mode=""
                      value={
                        typeof raw(fields.maskType) === "string"
                          ? (raw(fields.maskType) as string)
                          : "luminosity"
                      }
                      disabled={fields.maskType.commit == null}
                      onChange={(e) =>
                        void fields.maskType.commit?.(e.target.value)
                      }
                    >
                      {modeMembers(fields.maskType).map((m) => (
                        <option key={m} value={m}>
                          {modeLabel(strings, m)}
                        </option>
                      ))}
                    </KitSelect>
                  </Row>
                </ObjectFieldFrame>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
