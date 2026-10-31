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

// The slide transition shader library (slide ADR 721), without a GPU: the
// manifest against the importer's kind list, the shader files against the
// manifest, the prelude's bindings declared once and never again, the
// generated sources module in step with the .wgsl files, and the mapping
// from a deck's transition XML to render parameters. WGSL validity is
// checked by naga (slide-shaders, cargo) and by Chromium's Tint in the
// browser lane (tests/gpu).

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "bun:test";

import {
  SHADER_SOURCES,
  TRANSITION_MANIFEST,
  assembleShader,
  defaultParams,
  effectAttributes,
  renderKinds,
  resolveTransition,
} from "../src/show/shaders/index.ts";
import { readShaderFiles } from "../scripts/gen-shaders.ts";

const MODULE = resolve(import.meta.dir, "..", "..", "..");

/** A Rust `pub const NAME: &[&str] = &[ … ];` from pptx-core, as strings. */
function rustList(name: string): string[] {
  const src = readFileSync(join(MODULE, "pptx-core", "src", "lib.rs"), "utf8");
  const m = new RegExp(
    `pub const ${name}: &\\[&str\\] = &\\[([\\s\\S]*?)\\];`,
  ).exec(src);
  if (!m) throw new Error(`pptx-core has no ${name}`);
  return [...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
}

const files = readShaderFiles();
const transitionFiles = Object.keys(files).filter((n) => !n.startsWith("_"));
const libraries = Object.keys(files).filter((n) => n.startsWith("_"));

/** What only the prelude may declare. */
const BINDING_PATTERNS: [RegExp, string][] = [
  [/@group\s*\(/, "@group"],
  [/@binding\s*\(/, "@binding"],
  [/\bstruct\s+Uniforms\b/, "struct Uniforms"],
  [/\bvar\s*<\s*uniform\s*>/, "var<uniform>"],
  [/\bvar\s+(u_sampler|from_tex|to_tex)\b/, "a prelude binding name"],
];

/** Lines that redeclare a prelude binding (comments stripped). */
function bindingViolations(src: string): string[] {
  const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  return BINDING_PATTERNS.filter(([re]) => re.test(code)).map(
    ([, what]) => what,
  );
}

describe("slide transition shaders", () => {
  it("[plugin-slide.slideshow] has a manifest entry for every transition kind the importer reads", () => {
    const kinds = new Set(
      Object.values(TRANSITION_MANIFEST.transitions).map((t) => t.kind),
    );
    const missing = rustList("TRANSITION_KINDS").filter((k) => !kinds.has(k));
    expect(missing).toEqual([]);
    const presets = Object.keys(
      TRANSITION_MANIFEST.transitions["p15:prstTrans"]?.preset?.values ?? {},
    );
    expect(
      rustList("PRESET_TRANSITIONS").filter((p) => !presets.includes(p)),
    ).toEqual([]);
    // And nothing the importer cannot produce.
    const known = new Set(rustList("TRANSITION_KINDS"));
    expect([...kinds].filter((k) => !known.has(k))).toEqual([]);
  });

  it("keys every transition by its PowerPoint id, whose local name is its kind", () => {
    for (const [id, t] of Object.entries(TRANSITION_MANIFEST.transitions)) {
      expect(id).toMatch(/^p(14|15|159)?:[A-Za-z]+$/);
      expect(id.split(":")[1]).toBe(t.kind);
    }
  });

  it("has a .wgsl file for every pass, and no shader file the manifest does not use", () => {
    const used = new Set(
      Object.values(TRANSITION_MANIFEST.shaders).flatMap((s) => s.passes),
    );
    expect([...used].filter((p) => !(p in files))).toEqual([]);
    expect(transitionFiles.filter((f) => !used.has(f))).toEqual([]);
    for (const t of Object.values(TRANSITION_MANIFEST.transitions)) {
      const shaders = t.preset
        ? Object.values(t.preset.values)
        : t.shader
          ? [t.shader]
          : [];
      for (const s of shaders)
        expect(TRANSITION_MANIFEST.shaders[s]).toBeDefined();
      for (const k of t.random ?? []) {
        expect(
          Object.values(TRANSITION_MANIFEST.transitions).some(
            (x) => x.kind === k,
          ),
        ).toBe(true);
      }
    }
  });

  it("includes the prelude first in every transition shader, and gives each an fs_main", () => {
    for (const name of transitionFiles) {
      const first = files[name]!.split("\n").find((l) =>
        l.startsWith("// #include"),
      );
      expect({ name, first }).toEqual({
        name,
        first: '// #include "_prelude.wgsl"',
      });
      expect(files[name]).toMatch(/@fragment\s+fn fs_main\s*\(/);
      expect(files[name]).not.toMatch(/@vertex/);
    }
  });

  it("[plugin-slide.slideshow] rejects a shader that redeclares the prelude's bindings", () => {
    for (const name of [
      ...transitionFiles,
      ...libraries.filter((l) => l !== "_prelude"),
    ]) {
      expect({ name, violations: bindingViolations(files[name]!) }).toEqual({
        name,
        violations: [],
      });
    }
    // The check itself catches each form.
    expect(
      bindingViolations("@group(0) @binding(1) var t: texture_2d<f32>;"),
    ).toEqual(["@group", "@binding"]);
    expect(bindingViolations("struct Uniforms { progress: f32 };")).toEqual([
      "struct Uniforms",
    ]);
    expect(bindingViolations("var<uniform> v: f32;")).toEqual(["var<uniform>"]);
    expect(bindingViolations("var from_tex = 1;")).toEqual([
      "a prelude binding name",
    ]);
    expect(bindingViolations("// @group(0) in a comment is fine")).toEqual([]);
  });

  it("declares the bindings and the Uniforms block once, in the prelude", () => {
    const p = files._prelude!;
    expect(p.match(/@group\(0\) @binding\(\d\)/g)).toEqual([
      "@group(0) @binding(0)",
      "@group(0) @binding(1)",
      "@group(0) @binding(2)",
      "@group(0) @binding(3)",
    ]);
    const fields = /struct Uniforms \{([\s\S]*?)\};/
      .exec(p)?.[1]
      ?.replace(/\s+/g, " ")
      .trim();
    expect(fields).toBe(
      "progress: f32, time: f32, resolution: vec2f, direction: u32, params: array<vec4f, 2>,",
    );
    expect(files._fullscreen).toMatch(/@vertex\s+fn vs_main/);
  });

  it("keeps sources.generated.ts in step with the .wgsl files (bun run gen:shaders)", () => {
    expect({ ...SHADER_SOURCES }).toEqual(files);
  });

  it("assembles a shader from its includes, the vertex stage and its own text", () => {
    const code = assembleShader("pageCurlSingle");
    expect(code.indexOf("struct Uniforms")).toBeLessThan(
      code.indexOf("fn page_curl"),
    );
    expect(code.indexOf("fn page_curl")).toBeLessThan(
      code.indexOf("fn vs_main"),
    );
    expect(code.indexOf("fn vs_main")).toBeLessThan(code.indexOf("fn fs_main"));
    expect(code).not.toMatch(/^\/\/ #include "/m);
    expect(code.match(/struct Uniforms/g)).toHaveLength(1);
    expect(() => assembleShader("nope")).toThrow();
  });

  it("gives each shader at most eight params in distinct slots, and maps attributes onto them", () => {
    const codes = TRANSITION_MANIFEST.directions;
    for (const [name, s] of Object.entries(TRANSITION_MANIFEST.shaders)) {
      const slots = Object.values(s.params).map((p) => p.slot);
      expect({ name, slots: new Set(slots).size }).toEqual({
        name,
        slots: slots.length,
      });
      for (const slot of slots) expect(slot >= 0 && slot < 8).toBe(true);
    }
    for (const [id, t] of Object.entries(TRANSITION_MANIFEST.transitions)) {
      const shaders = t.preset
        ? Object.values(t.preset.values)
        : t.shader
          ? [t.shader]
          : [];
      for (const [attr, a] of Object.entries(t.attributes ?? {})) {
        // A preset family shares its attributes: each must reach at least
        // one preset's shader (the renderer ignores names a shader lacks).
        const takers = shaders.filter(
          (s) => a.param in TRANSITION_MANIFEST.shaders[s]!.params,
        );
        const want = t.preset
          ? takers.length > 0
          : takers.length === shaders.length;
        expect({ id, attr, mapped: want }).toEqual({ id, attr, mapped: true });
        if (a.type === "enum")
          expect(a.values?.[a.default ?? ""]).toBeDefined();
      }
      if (t.dir) {
        expect(t.dir.values).toContain(t.dir.default);
        for (const d of t.dir.values) expect(codes[d]).toBeGreaterThan(0);
      }
    }
  });

  it("matches the prelude's DIR_* constants to the manifest's direction codes", () => {
    for (const [name, code] of Object.entries(TRANSITION_MANIFEST.directions)) {
      const m = new RegExp(
        `const DIR_${name.toUpperCase()}: u32 = (\\d+)u;`,
      ).exec(files._prelude!);
      expect({ name, code: Number(m?.[1]) }).toEqual({ name, code });
    }
  });

  it("lists every render key, with each prstTrans preset on its own", () => {
    const keys = renderKinds();
    expect(keys).toContain("prstTrans:curtains");
    expect(keys).toContain("vortex");
    expect(keys).not.toContain("random");
    expect(keys).toHaveLength(new Set(keys).size);
    // 39 effects with a shader of their own (random picks one of them), 12
    // prstTrans presets, morph as a cross-fade.
    expect(keys.length).toBe(39 + 12 + 1);
  });
});

describe("resolveTransition", () => {
  it("encodes dir and keeps the default when the deck gives none", () => {
    expect(resolveTransition({ kind: "push", dir: "r" })).toEqual({
      kind: "push",
      params: { direction: TRANSITION_MANIFEST.directions.r! },
    });
    expect(resolveTransition({ kind: "push" })?.params.direction).toBe(
      TRANSITION_MANIFEST.directions.l,
    );
    // A dir the effect does not take falls back to its default.
    expect(
      resolveTransition({ kind: "push", dir: "in" })?.params.direction,
    ).toBe(TRANSITION_MANIFEST.directions.l);
  });

  it("reads the effect's other attributes from the element XML", () => {
    const fade =
      '<p:transition spd="slow"><p:fade thruBlk="1"/></p:transition>';
    expect(resolveTransition({ kind: "fade", xml: fade })?.params).toEqual({
      thruBlack: 1,
    });
    const split =
      '<p:transition><p:split orient="vert" dir="in"/></p:transition>';
    expect(
      resolveTransition({ kind: "split", dir: "in", xml: split })?.params,
    ).toEqual({
      direction: TRANSITION_MANIFEST.directions.in!,
      vertical: 1,
    });
    const wheel = '<p:transition><p:wheel spokes="8"/></p:transition>';
    expect(resolveTransition({ kind: "wheel", xml: wheel })?.params).toEqual({
      spokes: 8,
    });
  });

  it("reads a PowerPoint 2010 effect out of its mc:AlternateContent wrapper", () => {
    const xml =
      '<mc:AlternateContent xmlns:mc="m"><mc:Choice Requires="p14"><p:transition spd="slow" p14:dur="2000">' +
      '<p14:glitter dir="r" pattern="hexagon"/></p:transition></mc:Choice><mc:Fallback><p:transition spd="slow">' +
      "<p:fade/></p:transition></mc:Fallback></mc:AlternateContent>";
    expect(resolveTransition({ kind: "glitter", dir: "r", xml })).toEqual({
      kind: "glitter",
      params: { direction: TRANSITION_MANIFEST.directions.r!, hexagon: 1 },
    });
    expect(effectAttributes(xml, "glitter")).toEqual({
      dir: "r",
      pattern: "hexagon",
    });
  });

  it("turns a prstTrans preset into its own key, defaulting to fallOver", () => {
    const xml = '<p:transition><p15:prstTrans prst="curtains"/></p:transition>';
    expect(resolveTransition({ kind: "prstTrans", xml })?.kind).toBe(
      "prstTrans:curtains",
    );
    const inv =
      '<p:transition><p15:prstTrans prst="pageCurlSingle" invX="1"/></p:transition>';
    expect(resolveTransition({ kind: "prstTrans", xml: inv })).toEqual({
      kind: "prstTrans:pageCurlSingle",
      params: { invX: 1 },
    });
    expect(resolveTransition({ kind: "prstTrans" })?.kind).toBe(
      "prstTrans:fallOver",
    );
    expect(
      resolveTransition({
        kind: "prstTrans",
        xml: '<p15:prstTrans prst="unknown"/>',
      })?.kind,
    ).toBe("prstTrans:fallOver");
    expect(
      resolveTransition({
        kind: "prstTrans",
        xml: '<p15:prstTrans prst="airplane"/>',
      })?.approximation,
    ).toBeString();
  });

  it("plays morph as a cross-fade and says so", () => {
    const r = resolveTransition({ kind: "morph" });
    expect(r?.kind).toBe("morph");
    expect(r?.approximation).toContain("cross-fades");
  });

  it("returns null for no transition and for an unknown kind", () => {
    expect(resolveTransition({ kind: null })).toBeNull();
    expect(resolveTransition({ kind: "notATransition" })).toBeNull();
  });

  it("accepts namespaced kinds", () => {
    expect(resolveTransition({ kind: "p14:vortex", dir: "u" })?.kind).toBe(
      "vortex",
    );
    expect(defaultParams("p14:vortex")).toEqual({
      direction: TRANSITION_MANIFEST.directions.l!,
    });
  });
});
