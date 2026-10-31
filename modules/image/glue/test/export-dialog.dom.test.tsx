// FILE ▸ EXPORT AS… as a component (the DOM lane, ADR 468): what the form
// says is what reaches the session — format, quality, scale, colour mode,
// depth, compression, metadata and profile; CMYK narrows the formats to
// TIFF; 16 bits only where the format holds them; WebP says it is
// lossless; the source's metadata row names what it carries.

import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import type { ExportOptions } from "../src/engine";
import { exportSpec } from "../src/engine";
import {
  ExportAsDialog,
  formatsFor,
  sixteenAllowed,
} from "../src/panels/sections/export-dialog";

afterEach(() => cleanup());

function harness(profileName: string | null = null) {
  const onExport = mock((_o: ExportOptions) => {});
  const onPickProfile = mock(() => {});
  const onClearProfile = mock(() => {});
  const onCancel = mock(() => {});
  const view = render(
    <ExportAsDialog
      width={400}
      height={200}
      ppi={300}
      sixteenBit={false}
      metadata={{ icc: 3000, exif: 120, xmp: 0, iptc: 40 }}
      profileName={profileName}
      busy={false}
      onExport={onExport}
      onPickProfile={onPickProfile}
      onClearProfile={onClearProfile}
      onCancel={onCancel}
    />,
  );
  const q = (sel: string) =>
    view.container.querySelector(sel) as HTMLInputElement | null;
  const last = () => onExport.mock.calls.at(-1)![0];
  return { view, q, onExport, onPickProfile, onClearProfile, onCancel, last };
}

describe("[image.codec.core-codecs] Export As dialog", () => {
  it("hands the defaults over: PNG, 8-bit RGB, metadata kept, profile embedded, the image's ppi", () => {
    const h = harness();
    fireEvent.click(h.q("[data-export-apply]")!);
    expect(h.last()).toEqual({
      format: "png",
      quality: 90,
      ppi: 300,
      keepMetadata: true,
      embedProfile: true,
      mode: "rgb",
      bits: 8,
      compression: "lzw",
      intent: "relativeColorimetric",
    });
    expect(h.q("[data-export-source-metadata]")!.textContent).toContain(
      "ICC, EXIF, IPTC",
    );
  });

  it("JPEG shows quality, scale resizes, metadata can be stripped", () => {
    const h = harness();
    fireEvent.change(h.q("[data-export-format]")!, {
      target: { value: "jpeg" },
    });
    fireEvent.change(h.q("[data-export-quality]")!, {
      target: { value: "55" },
    });
    fireEvent.change(h.q("[data-export-scale]")!, { target: { value: "50" } });
    expect(h.q("[data-export-size]")!.textContent).toBe("200 × 100 px");
    fireEvent.click(h.q("[data-export-keep-metadata]")!);
    fireEvent.click(h.q("[data-export-embed-profile]")!);
    // 16 bits are not JPEG's: the depth control is off.
    expect(h.q("[data-export-bits]")!.disabled).toBe(true);
    fireEvent.click(h.q("[data-export-apply]")!);
    const o = h.last();
    expect(o).toMatchObject({
      format: "jpeg",
      quality: 55,
      width: 200,
      height: 100,
      keepMetadata: false,
      embedProfile: false,
      bits: 8,
    });
  });

  it("CMYK is a TIFF affair with a profile picker and an intent", () => {
    const h = harness("Coated FOGRA39.icc");
    fireEvent.change(h.q("[data-export-mode]")!, { target: { value: "cmyk" } });
    const formats = Array.from(
      (h.q("[data-export-format]") as unknown as HTMLSelectElement).options,
    ).map((o) => o.value);
    expect(formats).toEqual(["tiff"]);
    expect(h.q("[data-export-profile]")!.textContent).toBe(
      "Coated FOGRA39.icc",
    );
    fireEvent.click(h.q("[data-export-pick-profile]")!);
    expect(h.onPickProfile).toHaveBeenCalledTimes(1);
    fireEvent.click(h.q("[data-export-clear-profile]")!);
    expect(h.onClearProfile).toHaveBeenCalledTimes(1);
    fireEvent.change(h.q("[data-export-intent]")!, {
      target: { value: "perceptual" },
    });
    fireEvent.change(h.q("[data-export-compression]")!, {
      target: { value: "deflate" },
    });
    fireEvent.click(h.q("[data-export-apply]")!);
    expect(h.last()).toMatchObject({
      format: "tiff",
      mode: "cmyk",
      intent: "perceptual",
      compression: "deflate",
      bits: 8,
    });
  });

  it("16-bit TIFF; WebP says it is lossless; Cancel cancels", () => {
    const h = harness();
    fireEvent.change(h.q("[data-export-format]")!, {
      target: { value: "tiff" },
    });
    fireEvent.change(h.q("[data-export-bits]")!, { target: { value: "16" } });
    fireEvent.click(h.q("[data-export-apply]")!);
    expect(h.last()).toMatchObject({ format: "tiff", bits: 16 });
    fireEvent.change(h.q("[data-export-format]")!, {
      target: { value: "webp" },
    });
    expect(h.q("[data-export-note]")!.textContent).toMatch(/lossless/);
    fireEvent.click(h.q("[data-dialog-cancel]")!);
    expect(h.onCancel).toHaveBeenCalledTimes(1);
  });

  it("[images-graphics.codecs-long-tail] GIF, BMP, TGA and JPEG XL are offered and say what they drop", () => {
    const h = harness();
    const options = Array.from(
      (h.q("[data-export-format]") as unknown as HTMLSelectElement).options,
    );
    expect(options.map((o) => o.value)).toEqual([
      "png",
      "jpeg",
      "webp",
      "tiff",
      "gif",
      "bmp",
      "tga",
      "jxl",
    ]);
    expect(options.at(-1)!.textContent).toBe("JPEG XL");
    for (const [format, note] of [
      ["gif", /256 colours/],
      ["bmp", /no metadata/],
      ["tga", /no metadata/],
      ["jxl", /lossless/],
    ] as const) {
      fireEvent.change(h.q("[data-export-format]")!, {
        target: { value: format },
      });
      expect(h.q("[data-export-note]")!.textContent).toMatch(note);
    }
    // JPEG XL holds 16 bits.
    fireEvent.change(h.q("[data-export-bits]")!, { target: { value: "16" } });
    fireEvent.click(h.q("[data-export-apply]")!);
    expect(h.last()).toMatchObject({ format: "jxl", bits: 16 });
  });

  it("the rules and the engine's spec string", () => {
    expect(formatsFor("rgb")).toEqual([
      "png",
      "jpeg",
      "webp",
      "tiff",
      "gif",
      "bmp",
      "tga",
      "jxl",
    ]);
    expect(formatsFor("cmyk")).toEqual(["tiff"]);
    expect(sixteenAllowed("png", "rgb")).toBe(true);
    expect(sixteenAllowed("tiff", "cmyk")).toBe(false);
    expect(sixteenAllowed("webp", "rgb")).toBe(false);
    expect(sixteenAllowed("jxl", "rgb")).toBe(true);
    expect(sixteenAllowed("gif", "rgb")).toBe(false);
    expect(
      exportSpec({
        format: "tiff",
        quality: 120,
        width: 10.4,
        height: 5,
        ppi: 300,
        keepMetadata: false,
        embedProfile: true,
        mode: "cmyk",
        bits: 16,
        compression: "deflate",
        intent: "perceptual",
      }),
    ).toBe(
      "format=tiff;quality=100;meta=0;icc=1;mode=cmyk;bits=16;compression=deflate;intent=perceptual;width=10;height=5;ppi=300",
    );
  });
});
