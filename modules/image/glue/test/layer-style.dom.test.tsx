// The Layer Style dialog, the Global Light and Scale Effects dialogs and
// the Styles section as components (the DOM lane, WP5.4): every effect's
// checkbox adds or switches it, every pane edits its own effect and hands
// the next style over, Use Global Light edits the document's light,
// Blending Options' switches hand their bits over, and the Styles section
// applies, saves and deletes presets. [image.layers.styles]

import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { PLAIN_LAYER_PARITY, type LayerInfo } from "../src/engine";
import {
  EFFECT_KINDS,
  DEFAULT_STYLE_OPTIONS,
  builtInPresets,
  emptyStyle,
  setEffectEnabled,
  type LayerStyle,
  type StyleOptions,
} from "../src/layer-style";
import {
  GlobalLightDialog,
  LayerStyleDialog,
  ScaleEffectsDialog,
  StylesSection,
} from "../src/panels/sections/layer-style";
import type { LayerStylePane } from "../src/session";

afterEach(() => cleanup());

const layer: LayerInfo = {
  index: 0,
  id: 1,
  name: "Shape",
  visible: true,
  locked: false,
  opacity: 1,
  blend: "normal",
  kind: "pixels",
  hasMask: false,
  maskEnabled: true,
  clipped: false,
  group: null,
  ...PLAIN_LAYER_PARITY,
  locks: { ...PLAIN_LAYER_PARITY.locks },
};

function dialog(style: LayerStyle | null, pane: LayerStylePane) {
  const onStyle = mock((_s: LayerStyle | null) => {});
  const onPane = mock((_p: LayerStylePane) => {});
  const onOptions = mock((_o: StyleOptions) => {});
  const onGlobalLight = mock((_a: number, _b: number) => {});
  const onMoreBlending = mock(() => {});
  const onClose = mock(() => {});
  const view = render(
    <LayerStyleDialog
      layer={layer}
      style={style}
      options={DEFAULT_STYLE_OPTIONS}
      light={{ angle: 120, altitude: 30 }}
      pane={pane}
      disabled={false}
      onPane={onPane}
      onStyle={onStyle}
      onOptions={onOptions}
      onGlobalLight={onGlobalLight}
      onUsePattern={() => ({ name: "Pattern", id: "Pattern" })}
      onMoreBlending={onMoreBlending}
      onClose={onClose}
    />,
  );
  const q = (sel: string) => {
    const el = view.container.querySelector(sel);
    if (!el) throw new Error(`no ${sel}`);
    return el as HTMLInputElement;
  };
  return {
    view,
    q,
    onStyle,
    onPane,
    onOptions,
    onGlobalLight,
    onMoreBlending,
    onClose,
  };
}

const last = <T,>(m: { mock: { calls: T[][] } }): T => m.mock.calls.at(-1)![0]!;

describe("the Layer Style dialog [image.layers.styles]", () => {
  it("every effect's checkbox adds it with its defaults, and every pick names its pane", () => {
    for (const k of EFFECT_KINDS) {
      const d = dialog(null, "blending");
      fireEvent.click(d.q(`[data-image-style-enable="${k}"]`));
      const next = last(d.onStyle);
      expect(next).not.toBeNull();
      fireEvent.click(d.q(`[data-image-style-pick="${k}"]`));
      expect(last(d.onPane)).toBe(k);
      cleanup();
    }
  });

  it("each pane edits its own effect", () => {
    const all = EFFECT_KINDS.reduce(
      (s, k) => setEffectEnabled(s, k, true, { name: "P", id: "P" }),
      emptyStyle(),
    );
    const cases: [
      LayerStylePane,
      string,
      string,
      (s: LayerStyle) => unknown,
      unknown,
    ][] = [
      [
        "dropShadow",
        '[data-image-style-number="dropShadow.distance"]',
        "9",
        (s) => s.dropShadows[0]!.distance,
        9,
      ],
      [
        "innerShadow",
        '[data-image-style-number="innerShadow.spread"]',
        "40",
        (s) => s.innerShadows[0]!.spread,
        40,
      ],
      [
        "outerGlow",
        '[data-image-style-number="outerGlow.size"]',
        "12",
        (s) => s.outerGlow!.size,
        12,
      ],
      [
        "innerGlow",
        '[data-image-style-choice="innerGlow.source"]',
        "center",
        (s) => s.innerGlow!.source,
        "center",
      ],
      [
        "bevel",
        '[data-image-style-choice="bevel.style"]',
        "pillow_emboss",
        (s) => s.bevel!.style,
        "pillow_emboss",
      ],
      [
        "satin",
        '[data-image-style-number="satin.distance"]',
        "20",
        (s) => s.satin!.distance,
        20,
      ],
      [
        "colorOverlay",
        '[data-image-style-number="colorOverlay.opacity"]',
        "50",
        (s) => s.colorOverlays[0]!.opacity,
        50,
      ],
      [
        "gradientOverlay",
        '[data-image-style-choice="gradientOverlay.style"]',
        "radial",
        (s) => s.gradientOverlays[0]!.fill.style,
        "radial",
      ],
      [
        "patternOverlay",
        '[data-image-style-number="patternOverlay.scale"]',
        "50",
        (s) => s.patternOverlay!.fill.scale,
        50,
      ],
      [
        "stroke",
        '[data-image-style-choice="stroke.position"]',
        "inside",
        (s) => s.strokes[0]!.position,
        "inside",
      ],
    ];
    for (const [pane, sel, value, read, want] of cases) {
      const d = dialog(all, pane);
      expect(
        d.view.container.querySelector(`[data-image-style-pane="${pane}"]`),
      ).not.toBeNull();
      fireEvent.change(d.q(sel), { target: { value } });
      expect(read(last(d.onStyle)!)).toEqual(want);
      cleanup();
    }
  });

  it("with Use Global Light the angle edits the document's light", () => {
    const s = setEffectEnabled(emptyStyle(), "dropShadow", true);
    const d = dialog(s, "dropShadow");
    fireEvent.change(d.q('[data-image-style-number="dropShadow.angle"]'), {
      target: { value: "45" },
    });
    expect(d.onGlobalLight.mock.calls.at(-1)).toEqual([45, 30]);
    expect(d.onStyle).not.toHaveBeenCalled();
  });

  it("repeatable effects add instances, an effect can be removed, the style cleared", () => {
    const s = setEffectEnabled(emptyStyle(), "stroke", true);
    const d = dialog(s, "stroke");
    fireEvent.click(d.q('[data-image-style-add="stroke"]'));
    expect(last(d.onStyle)!.strokes.length).toBe(2);
    fireEvent.click(d.q('[data-image-style-remove="stroke"]'));
    expect(last(d.onStyle)!.strokes.length).toBe(0);
    fireEvent.click(d.q("[data-image-style-clear]"));
    expect(last(d.onStyle)).toBeNull();
    fireEvent.click(d.q("[data-image-style-close]"));
    expect(d.onClose).toHaveBeenCalledTimes(1);
  });

  it("Blending Options' style switches hand their options over", () => {
    const d = dialog(null, "blending");
    fireEvent.click(d.q('[data-image-style-check="options.blendInterior"]'));
    expect(last(d.onOptions).blendInterior).toBe(true);
    fireEvent.click(d.q('[data-image-style-check="options.maskHidesEffects"]'));
    expect(last(d.onOptions).maskHidesEffects).toBe(true);
    fireEvent.click(d.q("[data-image-style-more-blending]"));
    expect(d.onMoreBlending).toHaveBeenCalledTimes(1);
  });
});

describe("the Global Light and Scale Effects dialogs [image.layers.styles]", () => {
  it("apply what was set", () => {
    const onApply = mock((_a: number, _b: number) => {});
    const g = render(
      <GlobalLightDialog
        light={{ angle: 120, altitude: 30 }}
        disabled={false}
        onApply={onApply}
        onClose={() => {}}
      />,
    );
    fireEvent.change(
      g.container.querySelector(
        '[data-image-style-number="globalLight.angle"]',
      )!,
      { target: { value: "90" } },
    );
    fireEvent.click(
      g.container.querySelector("[data-image-global-light-apply]")!,
    );
    expect(onApply.mock.calls.at(-1)).toEqual([90, 30]);
    cleanup();
    const onScale = mock((_p: number) => {});
    const sc = render(
      <ScaleEffectsDialog
        disabled={false}
        onApply={onScale}
        onClose={() => {}}
      />,
    );
    fireEvent.change(
      sc.container.querySelector(
        '[data-image-style-number="scaleEffects.percent"]',
      )!,
      { target: { value: "50" } },
    );
    fireEvent.click(
      sc.container.querySelector("[data-image-scale-effects-apply]")!,
    );
    expect(onScale.mock.calls.at(-1)).toEqual([50]);
  });
});

describe("the Styles section [image.layers.styles]", () => {
  it("applies, saves, deletes; copies, pastes and clears", () => {
    const presets = [
      ...builtInPresets(),
      { id: "style-mine", name: "Mine", style: emptyStyle() },
    ];
    const calls: string[] = [];
    const view = render(
      <StylesSection
        presets={presets}
        hasStyle
        hasClipboard
        disabled={false}
        onApply={(n) => calls.push(`apply ${n}`)}
        onSave={(n) => calls.push(`save ${n}`)}
        onDelete={(n) => calls.push(`delete ${n}`)}
        onCopy={() => calls.push("copy")}
        onPaste={() => calls.push("paste")}
        onClear={() => calls.push("clear")}
      />,
    );
    const q = (sel: string) => view.container.querySelector(sel)!;
    fireEvent.click(q('[data-image-style-preset="Drop Shadow"]'));
    expect(q('[data-image-style-preset-delete="Drop Shadow"]')).toBeNull();
    fireEvent.click(q('[data-image-style-preset-delete="Mine"]'));
    fireEvent.change(q("[data-image-style-preset-name]"), {
      target: { value: "Fancy" },
    });
    fireEvent.click(q("[data-image-style-preset-save]"));
    fireEvent.click(q("[data-image-style-copy]"));
    fireEvent.click(q("[data-image-style-paste]"));
    fireEvent.click(q("[data-image-style-clear-active]"));
    expect(calls).toEqual([
      "apply Drop Shadow",
      "delete Mine",
      "save Fancy",
      "copy",
      "paste",
      "clear",
    ]);
  });
});
