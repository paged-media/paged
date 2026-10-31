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

// Concept 2 — Color panel: composition chrome (fill picker + tint
// scrub) + the live MIXER (CMYK/RGB/Lab/HSB channels, hex, gamut
// warning, ephemeral apply / add-to-swatches).
//
// Mixer semantics mirror InDesign's Color panel vs Swatches split:
// "Apply" creates (or reuses) an UNNAMED swatch from the mixed
// channels and applies its ref to the selection through the same
// `frameFillColor` colorRef path a swatch click takes — the
// mixed-selection sentinel + multi-select fan-out come from the
// binding layer for free. "+ Add to Swatches" promotes the same
// channels to a named entry via `createSwatch`.
//
// W2.5 (2026-06-07) — document-default write. With NOTHING selected
// (`frameFillColor` has no commit path), Apply writes the created
// swatch as the DOCUMENT DEFAULT fill via `setDocumentDefaults`
// (whole-triple, not undoable) — matching InDesign's "set the default
// fill when no object is selected" behaviour. The panel reads the
// current default off `documentMeta()` so the readout reflects it.
//
// ADR 323 — the fill + tint fields are migrated `PropertyField`s
// (color.composition.ts: the fill keeps its swatch collection select).
// The mixer's Apply writes through `host.objects` too: the selection's
// `frameFillColor`, or — with nothing selected — the document's
// `doc.defaultFillColor` virtual path (the same `setDocumentDefaults`
// op, the other two defaults preserved by the core seam).
//
// WP7.2 — the PAINT TARGET (shell `tools/paint-target.ts`). While a tool
// has coloured parts of an object selected — the Mesh tool's mesh
// points, the Gradient tool's freeform points — it sets a target in the
// editor's scope; the panel reads it through `usePaintTarget` and the
// mixer's Apply colours those parts through `target.apply` (one
// mutation, one undo step) instead of writing the fill. The panel knows
// nothing of meshes: the target carries its label and its write.

import { useEffect, useState } from "react";

import {
  CatalogRegistryProvider,
  CompositionRenderer,
  useBindingProviderHost,
  useCockpitActions,
  useCanvasClient,
  useObjectBindings,
  useDocumentMeta,
  usePaintTarget,
  useProviderProperty,
  writeSelectionProperty,
  type PaintColor,
  type ProvidedProperty,
} from "@paged-media/shell";
import { ColorMixer, hexToRgb, type MixerValue } from "@paged-media/ui";
import type {
  ColorPreview,
  SwatchColorSpec,
  SwatchSpec,
  Value,
} from "@paged-media/client";

import { appCatalogRegistry } from "./catalog-registry";
import { colorComposition } from "./color.composition";
import { defineMessages, useStrings } from "@paged-media/strings";

const M = defineMessages("app.colorPanel", {
  noSelection: "No selection — Apply sets the document default fill.",
  openColorWheel: "Open color wheel",
  newSwatch: "New swatch",
  fillWell: "Fill",
  strokeWell: "Stroke",
  rawWells:
    "The fill and stroke wells are this content's own colours (in an image: the foreground and background). A swatch click sets the fill, Alt-click the stroke.",
  paintTarget: "Apply colours the selection: {target}.",
});

/** The mixer's colour as a paint-target colour: the tint folded into the
 *  ink channels (CMYK, Gray), which is what a tint of them is. */
export function mixerToPaint(v: MixerValue): PaintColor {
  const tint = v.tint < 100 ? Math.max(0, v.tint) / 100 : 1;
  const inked = v.space === "CMYK" || v.space === "Gray";
  return {
    space: v.space,
    value: v.value.map((c) => (inked ? c * tint : c)),
  };
}

/** The current selection, as a provider target (module-level: the hook
 *  keys on it). */
const SELECTION = { kind: "selection", scope: "element" } as const;

/** A provider's RAW colour answer for a well (`swatchColor`), or null —
 *  the edit context's colour is not a document swatch (WP4.10). */
function rawColour(p: ProvidedProperty): SwatchColorSpec | null {
  if (p.source !== "provider" || p.read.kind !== "value") return null;
  const v = p.read.value as Value;
  return v.type === "swatchColor" ? v.value : null;
}

const FILL_BINDING = {
  value: { scope: "element" as const, path: "frameFillColor" },
  docDefault: { path: "defaultFillColor", targets: ["doc"] as const },
};

function unwrapColorRef(v: Value | null): string | null {
  if (!v) return null;
  if (v.type !== "colorRef") return null;
  return (v.value as string | null) ?? null;
}

export function ColorPanel() {
  const fillOwn = useProviderProperty("frameFillColor", SELECTION);
  const strokeOwn = useProviderProperty("frameStrokeColor", SELECTION);
  const rawFill = rawColour(fillOwn);
  if (rawFill) {
    return <RawColourWells fill={rawFill} stroke={rawColour(strokeOwn)} />;
  }
  return <DocumentColourPanel />;
}

/**
 * WP4.10 — the Color panel over an edit context whose colours are its own
 * (paged.image's foreground / background): two wells, the mixer on the
 * active one, every commit written to the owner as an RGB colour. A CMYK
 * or Lab edit is resolved through the document's colour management
 * (`colorCompute`) to the RGB the owner stores; no document swatch is
 * minted for it, because the colour is not the document's.
 */
function RawColourWells({
  fill,
  stroke,
}: {
  fill: SwatchColorSpec;
  stroke: SwatchColorSpec | null;
}) {
  const strings = useStrings();
  const client = useCanvasClient();
  const host = useBindingProviderHost();
  const [well, setWell] = useState<"fill" | "stroke">("fill");
  const current = well === "stroke" && stroke ? stroke : fill;
  const seed = JSON.stringify(current);
  const [mix, setMix] = useState<{ seed: string; value: MixerValue }>(() => ({
    seed,
    value: specToMixer(current),
  }));
  // Follow the owner when its colour changed elsewhere (a sample, a swap).
  const shown = mix.seed === seed ? mix.value : specToMixer(current);

  const write = async (v: MixerValue) => {
    if (!host) return;
    let rgb: number[] | null = v.space === "RGB" ? v.value : null;
    if (!rgb) {
      const c = await client.colorCompute({
        space: v.space,
        value: v.value,
        tint: v.tint < 100 ? v.tint : null,
      });
      rgb = hexToRgb(c.rgbHex);
    }
    if (!rgb) return;
    await writeSelectionProperty(
      host,
      well === "fill" ? "frameFillColor" : "frameStrokeColor",
      "element",
      {
        type: "swatchColor",
        value: { space: "RGB", value: rgb.map(Math.round), model: "Process" },
      } as Value,
    );
  };

  const chip = (c: SwatchColorSpec | null) =>
    c && c.space.toUpperCase() === "RGB"
      ? `rgb(${c.value.slice(0, 3).join(",")})`
      : "transparent";

  return (
    <div
      className="p-3 flex flex-col gap-3"
      data-color-panel="ready"
      data-target="edit-context"
    >
      <div className="flex items-center gap-2" role="group">
        {(["fill", "stroke"] as const).map((w) => (
          <button
            key={w}
            type="button"
            data-color-well={w}
            aria-pressed={well === w}
            disabled={w === "stroke" && !stroke}
            onClick={() => setWell(w)}
            className="flex items-center gap-1 text-xs px-2 py-1 rounded border border-input"
            style={{
              background: well === w ? "var(--chrome-slot-active)" : undefined,
            }}
          >
            <span
              className="inline-block w-4 h-4 rounded border border-input"
              style={{ background: chip(w === "fill" ? fill : stroke) }}
              data-color-well-chip={w}
            />
            {strings.t(w === "fill" ? M.fillWell : M.strokeWell)}
          </button>
        ))}
      </div>
      <ColorMixer
        value={shown}
        showTint={false}
        onChange={(next) => setMix({ seed, value: next })}
        onCommit={(next) => {
          setMix({ seed, value: next });
          void write(next);
        }}
      />
      <div
        className="text-[11px]"
        style={{ color: "var(--pg-muted-fg)" }}
        data-color-raw-note
      >
        {strings.t(M.rawWells)}
      </div>
    </div>
  );
}

function specToMixer(c: SwatchColorSpec): MixerValue {
  const space = c.space.toUpperCase();
  return {
    space:
      space === "CMYK"
        ? "CMYK"
        : space === "LAB"
          ? "LAB"
          : space === "GRAY"
            ? "Gray"
            : "RGB",
    value: [...c.value],
    tint: 100,
  };
}

function DocumentColourPanel() {
  const cockpitActions = useCockpitActions();
  const strings = useStrings();
  const client = useCanvasClient();
  const resolved = useObjectBindings(FILL_BINDING);
  const meta = useDocumentMeta();
  const paintTarget = usePaintTarget();
  // W2.5 — with nothing selected the binding has no commit path; the
  // panel then targets the document-default fill instead.
  const hasSelection = resolved.value.onCommit != null;
  const docDefaultFill = meta?.defaultFillColor ?? null;
  // The readout reflects the selection's fill when one exists, else the
  // document default.
  const fillRef = hasSelection
    ? unwrapColorRef(resolved.value.value)
    : docDefaultFill;
  const [preview, setPreview] = useState<ColorPreview | null>(null);
  // Mixer state — local channel values being authored. Seeds from
  // a neutral default; deliberately NOT slaved to the selection's
  // swatch (the mixer authors a NEW colour; the readout below
  // reflects the applied one).
  const [mix, setMix] = useState<MixerValue>({
    space: "CMYK",
    value: [0, 0, 0, 100],
    tint: 100,
  });

  // Ephemeral apply: create an unnamed swatch from the channels and
  // apply its ref. With a selection it commits through the SAME
  // `frameFillColor` path a swatch pick takes; with NOTHING selected
  // (W2.5) it writes the swatch as the document-default fill via
  // `setDocumentDefaults` (whole-triple — the other two members are
  // preserved from the current meta).
  const applyMix = (v: MixerValue) => {
    if (paintTarget) {
      void paintTarget.apply(mixerToPaint(v)).catch(() => {});
      return;
    }
    const spec: SwatchSpec = {
      selfId: null,
      name: null,
      space: v.space,
      value: [...v.value],
      model: "Process",
      alternateSpace: null,
      alternateValue: [],
      tint: v.tint < 100 ? v.tint : null,
      alpha: null,
    };
    void client
      .mutate({ op: "createSwatch", args: { spec } })
      .then(async () => {
        // The created swatch is the newest entry; resolve its id
        // from the collection (createSwatch doesn't echo createdId
        // — swatches aren't elements).
        const swatches = await client.collection<{ selfId: string }>(
          "swatches",
        );
        const last = swatches[swatches.length - 1];
        if (!last) return;
        if (hasSelection) {
          resolved.value.onCommit?.({ type: "colorRef", value: last.selfId });
        } else {
          // W2.5 — no selection: write the document-default fill; the
          // core seam preserves the existing stroke/weight defaults.
          resolved.docDefault.onCommit?.({
            type: "colorRef",
            value: last.selfId,
          });
        }
      })
      .catch(() => {});
  };

  const addSwatch = (spec: SwatchSpec) => {
    void client
      .mutate({
        op: "createSwatch",
        args: { spec: { ...spec, name: spec.name ?? strings.t(M.newSwatch) } },
      })
      .catch(() => {});
  };

  useEffect(() => {
    let cancelled = false;
    if (!fillRef) {
      setPreview(null);
      return;
    }
    void client.colorPreview(fillRef).then((p) => {
      if (cancelled) return;
      setPreview(p);
    });
    const off = client.subscribe((msg) => {
      if (
        msg.kind === "mutationApplied" ||
        msg.kind === "undoApplied" ||
        msg.kind === "redoApplied"
      ) {
        if (!fillRef) return;
        void client.colorPreview(fillRef).then((p) => {
          if (cancelled) return;
          setPreview(p);
        });
      }
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [client, fillRef]);

  return (
    <CatalogRegistryProvider registry={appCatalogRegistry()}>
      <div
        className="p-3 flex flex-col gap-3"
        data-color-panel="ready"
        data-target={
          paintTarget
            ? "paint-target"
            : hasSelection
              ? "selection"
              : "document-default"
        }
      >
        {paintTarget ? (
          <div
            className="text-[11px]"
            style={{ color: "var(--pg-muted-fg)" }}
            data-paint-target={paintTarget.owner}
          >
            {strings.t(M.paintTarget, { target: paintTarget.label })}
          </div>
        ) : !hasSelection ? (
          <div
            className="text-[11px]"
            style={{ color: "var(--pg-muted-fg)" }}
            data-doc-default-hint
          >
            {strings.t(M.noSelection)}
          </div>
        ) : null}
        <CompositionRenderer composition={colorComposition(strings)} />
        {/* Concept 2 — the mixer (expert child; hybrid pattern). */}
        <div className="border-t border-input pt-3">
          <ColorMixer
            value={mix}
            onChange={setMix}
            onApply={applyMix}
            onAddSwatch={addSwatch}
          />
        </div>
        {/* Panel-gallery pass — hand off to the colour wheel (the
            harmony-palette author; same swatch pipeline). */}
        <button
          type="button"
          data-open-color-wheel
          onClick={() => cockpitActions.openPanel?.("paged.color-wheel")}
          className="text-xs text-left text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
        >
          {strings.t(M.openColorWheel)}
        </button>
        {preview ? (
          <div
            className="border-t border-input pt-3 flex flex-col gap-1 text-xs"
            data-color-preview
          >
            <div className="flex items-center gap-2">
              <span
                className="inline-block w-6 h-6 border border-input rounded"
                style={{ background: preview.rgbHex }}
                data-color-swatch
              />
              <span className="font-medium">{preview.name}</span>
              <span className="text-muted-foreground">{preview.model}</span>
            </div>
            <div className="grid grid-cols-[5rem_1fr] gap-x-2">
              <span className="text-muted-foreground">RGB</span>
              <span data-color-rgb>{preview.rgbHex}</span>
              {preview.cmyk ? (
                <>
                  <span className="text-muted-foreground">CMYK</span>
                  <span data-color-cmyk>
                    {preview.cmyk.map((v) => `${v.toFixed(0)}%`).join(" / ")}
                  </span>
                </>
              ) : (
                <>
                  <span className="text-muted-foreground">CMYK</span>
                  <span className="text-muted-foreground">—</span>
                </>
              )}
            </div>
          </div>
        ) : null}
      </div>
    </CatalogRegistryProvider>
  );
}
