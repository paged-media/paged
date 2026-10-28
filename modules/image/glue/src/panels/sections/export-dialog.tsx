// FILE ▸ EXPORT AS… (ADR 468) — the image written as PNG, JPEG, WebP or
// TIFF with the choices Photoshop's Export As and Save As offer: format,
// JPEG quality, size, colour mode (CMYK through a chosen profile, TIFF
// only), depth, metadata keep/strip, embed profile and resolution. The
// engine's `export_image*` doors do the work (`paged-raster`); this is
// only the form.

import { useState } from "react";

import type { ExportOptions, RasterFormat } from "../../engine";
import { defineMessages, t } from "@paged-media/strings";
import { color, font, space } from "@paged-media/panel-kit";

import { mono, note, row } from "./styles";

const M = defineMessages("image.exportAs", {
  title: "Export as",
  format: "Format",
  quality: "Quality",
  size: "Size",
  scale: "Scale",
  colour: "Colour",
  rgb: "RGB",
  gray: "Grayscale",
  cmyk: "CMYK",
  depth: "Depth",
  bits8: "8 bits/channel",
  bits16: "16 bits/channel",
  compression: "Compression",
  none: "None",
  lzw: "LZW",
  deflate: "ZIP (Deflate)",
  intent: "Intent",
  perceptual: "Perceptual",
  relative: "Relative colorimetric",
  saturation: "Saturation",
  absolute: "Absolute colorimetric",
  profile: "CMYK profile",
  chooseProfile: "Choose…",
  clearProfile: "Clear",
  sourceProfile: "The source's own, or none",
  resolution: "Resolution",
  ppi: "pixels/inch",
  keepMetadata: "Keep metadata (EXIF, XMP, IPTC)",
  embedProfile: "Embed colour profile",
  sourceCarries: "The source carries: {list}.",
  sourceCarriesNothing: "The source carries no metadata.",
  export: "Export",
  cancel: "Cancel",
  webpNote: "WebP is written lossless: there is no lossy WebP encoder.",
  cmykNote:
    "CMYK is written as TIFF, converted through the chosen profile (or the " +
    "source's own CMYK profile); without one, the naive formula is used and " +
    "no profile is embedded.",
  rgbNote:
    "The pixels are sRGB, so the embedded profile is sRGB. Metadata is " +
    "written with an upright orientation; the image was turned on open.",
});

const dialogStyle = {
  border: `1px solid ${color.border}`,
  borderRadius: 4,
  padding: space[2],
  margin: `${space[2]} 0`,
} as const;

const title = { fontWeight: 600, marginBottom: space[1] } as const;

const numberStyle = { width: 72, font: `11px ${font.mono}` } as const;

/** What the bytes the session opened carry (lengths; 0 = absent). */
export interface SourceMetadata {
  icc: number;
  exif: number;
  xmp: number;
  iptc: number;
}

/** The formats a mode allows: CMYK is a TIFF affair. */
export function formatsFor(mode: ExportOptions["mode"]): RasterFormat[] {
  return mode === "cmyk" ? ["tiff"] : ["png", "jpeg", "webp", "tiff"];
}

/** 16 bits only where the format holds them (PNG, TIFF) and not CMYK. */
export function sixteenAllowed(
  format: RasterFormat,
  mode: ExportOptions["mode"],
): boolean {
  return (format === "png" || format === "tiff") && mode !== "cmyk";
}

export function ExportAsDialog({
  width,
  height,
  ppi,
  sixteenBit,
  metadata,
  profileName,
  busy,
  onExport,
  onPickProfile,
  onClearProfile,
  onCancel,
}: {
  width: number;
  height: number;
  /** The image's resolution (null = none declared). */
  ppi: number | null;
  /** The session holds 16 bits per channel. */
  sixteenBit: boolean;
  metadata: SourceMetadata | null;
  /** The picked CMYK profile's name, or null. */
  profileName: string | null;
  busy: boolean;
  onExport: (options: ExportOptions) => void;
  onPickProfile: () => void;
  onClearProfile: () => void;
  onCancel: () => void;
}) {
  const [format, setFormat] = useState<RasterFormat>("png");
  const [quality, setQuality] = useState(90);
  const [scale, setScale] = useState(100);
  const [mode, setMode] = useState<ExportOptions["mode"]>("rgb");
  const [bits, setBits] = useState<8 | 16>(sixteenBit ? 16 : 8);
  const [compression, setCompression] =
    useState<ExportOptions["compression"]>("lzw");
  const [intent, setIntent] = useState<ExportOptions["intent"]>(
    "relativeColorimetric",
  );
  const [res, setRes] = useState<number>(ppi ?? 72);
  const [keepMetadata, setKeepMetadata] = useState(true);
  const [embedProfile, setEmbedProfile] = useState(true);

  const outW = Math.max(1, Math.round((width * scale) / 100));
  const outH = Math.max(1, Math.round((height * scale) / 100));
  const can16 = sixteenAllowed(format, mode);
  const carried = metadata
    ? (
        [
          ["ICC", metadata.icc],
          ["EXIF", metadata.exif],
          ["XMP", metadata.xmp],
          ["IPTC", metadata.iptc],
        ] as const
      )
        .filter(([, n]) => n > 0)
        .map(([name]) => name)
    : [];

  const pickMode = (m: ExportOptions["mode"]) => {
    setMode(m);
    if (!formatsFor(m).includes(format)) setFormat("tiff");
  };

  const options = (): ExportOptions => ({
    format,
    quality,
    ...(scale === 100 ? {} : { width: outW, height: outH }),
    ppi: res > 0 ? res : null,
    keepMetadata,
    embedProfile,
    mode,
    bits: can16 ? bits : 8,
    compression,
    intent,
  });

  return (
    <section
      role="dialog"
      aria-label={t(M.title)}
      data-image-export-dialog
      style={dialogStyle}
    >
      <div style={title}>{t(M.title)}</div>
      <div style={row}>
        <label htmlFor="pg-export-mode">{t(M.colour)}</label>
        <select
          id="pg-export-mode"
          data-export-mode
          value={mode}
          onChange={(e) => pickMode(e.target.value as ExportOptions["mode"])}
        >
          <option value="rgb">{t(M.rgb)}</option>
          <option value="gray">{t(M.gray)}</option>
          <option value="cmyk">{t(M.cmyk)}</option>
        </select>
      </div>
      <div style={row}>
        <label htmlFor="pg-export-format">{t(M.format)}</label>
        <select
          id="pg-export-format"
          data-export-format
          value={format}
          onChange={(e) => setFormat(e.target.value as RasterFormat)}
        >
          {formatsFor(mode).map((f) => (
            <option key={f} value={f}>
              {f.toUpperCase()}
            </option>
          ))}
        </select>
      </div>
      {format === "jpeg" && (
        <div style={row}>
          <label htmlFor="pg-export-quality">{t(M.quality)}</label>
          <input
            id="pg-export-quality"
            type="range"
            min={1}
            max={100}
            data-export-quality
            value={quality}
            onChange={(e) => setQuality(Number(e.target.value))}
          />
          <span style={mono}>{quality}</span>
        </div>
      )}
      {format === "tiff" && (
        <div style={row}>
          <label htmlFor="pg-export-compression">{t(M.compression)}</label>
          <select
            id="pg-export-compression"
            data-export-compression
            value={compression}
            onChange={(e) =>
              setCompression(e.target.value as ExportOptions["compression"])
            }
          >
            <option value="lzw">{t(M.lzw)}</option>
            <option value="deflate">{t(M.deflate)}</option>
            <option value="none">{t(M.none)}</option>
          </select>
        </div>
      )}
      <div style={row}>
        <label htmlFor="pg-export-bits">{t(M.depth)}</label>
        <select
          id="pg-export-bits"
          data-export-bits
          value={can16 ? bits : 8}
          disabled={!can16}
          onChange={(e) => setBits(Number(e.target.value) === 16 ? 16 : 8)}
        >
          <option value={8}>{t(M.bits8)}</option>
          <option value={16}>{t(M.bits16)}</option>
        </select>
      </div>
      <div style={row}>
        <label htmlFor="pg-export-scale">{t(M.scale)}</label>
        <input
          id="pg-export-scale"
          type="number"
          min={1}
          max={1000}
          data-export-scale
          value={scale}
          style={numberStyle}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (v > 0) setScale(v);
          }}
        />
        <span style={mono} data-export-size>
          {outW} × {outH} px
        </span>
      </div>
      <div style={row}>
        <label htmlFor="pg-export-ppi">{t(M.resolution)}</label>
        <input
          id="pg-export-ppi"
          type="number"
          min={1}
          data-export-ppi
          value={Number(res.toFixed(2))}
          style={numberStyle}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (v > 0) setRes(v);
          }}
        />
        <span style={mono}>{t(M.ppi)}</span>
      </div>
      {mode === "cmyk" && (
        <>
          <div style={row}>
            <span>{t(M.profile)}</span>
            <span style={mono} data-export-profile>
              {profileName ?? t(M.sourceProfile)}
            </span>
            <button
              type="button"
              data-export-pick-profile
              onClick={onPickProfile}
            >
              {t(M.chooseProfile)}
            </button>
            {profileName !== null && (
              <button
                type="button"
                data-export-clear-profile
                onClick={onClearProfile}
              >
                {t(M.clearProfile)}
              </button>
            )}
          </div>
          <div style={row}>
            <label htmlFor="pg-export-intent">{t(M.intent)}</label>
            <select
              id="pg-export-intent"
              data-export-intent
              value={intent}
              onChange={(e) =>
                setIntent(e.target.value as ExportOptions["intent"])
              }
            >
              <option value="relativeColorimetric">{t(M.relative)}</option>
              <option value="perceptual">{t(M.perceptual)}</option>
              <option value="saturation">{t(M.saturation)}</option>
              <option value="absoluteColorimetric">{t(M.absolute)}</option>
            </select>
          </div>
        </>
      )}
      <div style={row}>
        <label>
          <input
            type="checkbox"
            data-export-keep-metadata
            checked={keepMetadata}
            onChange={(e) => setKeepMetadata(e.target.checked)}
          />{" "}
          {t(M.keepMetadata)}
        </label>
      </div>
      <div style={row}>
        <label>
          <input
            type="checkbox"
            data-export-embed-profile
            checked={embedProfile}
            onChange={(e) => setEmbedProfile(e.target.checked)}
          />{" "}
          {t(M.embedProfile)}
        </label>
      </div>
      <div style={{ ...note, marginTop: 0 }} data-export-source-metadata>
        {carried.length > 0
          ? t(M.sourceCarries, { list: carried.join(", ") })
          : t(M.sourceCarriesNothing)}
      </div>
      <div style={{ ...row, borderBottom: "none", justifyContent: "flex-end" }}>
        <button type="button" data-dialog-cancel onClick={onCancel}>
          {t(M.cancel)}
        </button>
        <button
          type="button"
          data-export-apply
          disabled={busy}
          onClick={() => onExport(options())}
        >
          {t(M.export)}
        </button>
      </div>
      <div style={note} data-export-note>
        {format === "webp"
          ? t(M.webpNote)
          : mode === "cmyk"
            ? t(M.cmykNote)
            : t(M.rgbNote)}
      </div>
    </section>
  );
}
