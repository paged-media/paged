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

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import type { Config } from "tailwindcss";
import plugin from "tailwindcss/plugin";
import animate from "tailwindcss-animate";

// shadcn-flavoured Tailwind config for @paged-media/shell. Apps that
// consume the shell extend this config (typically via the workspace
// package import) and append their own content globs so Tailwind
// scans the app's JSX in addition to shell's.

// The editor's root element (plan task E1, packages/shell
// state/editor-root.tsx). `:where()` keeps the scope at no specificity, so
// a utility class still wins over a preflight rule as it did unscoped.
const EDITOR = ":where([data-paged-editor])";

/** One preflight selector, scoped to the editor's root: `html`, `:host`
 *  and `body` become the root itself, `*` the root and everything in it,
 *  a bare pseudo-element the root's and its descendants', anything else
 *  a descendant of the root. */
function scopeSelector(selector: string): string {
  const s = selector.trim();
  if (s === "html" || s === ":host" || s === "body") return EDITOR;
  if (s === "*") return `${EDITOR}, ${EDITOR} *`;
  if (s.startsWith("::")) return `${EDITOR}${s}, ${EDITOR} *${s}`;
  return `${EDITOR} ${s}`;
}

/**
 * Tailwind's preflight, scoped to the editor's root: the editor mounts
 * into a host's page (docs/composable-editor.md §8), so its reset must
 * not restyle the host's own elements. The rules are Tailwind's own,
 * read from the installed package as its `preflight` core plugin reads
 * them, with each selector scoped; that core plugin is off below.
 */
/** The part of the plugin API this uses: Tailwind hands its plugins the
 *  postcss it runs with (not in the published `PluginAPI` type). */
interface PostcssApi {
  postcss: {
    parse(css: string): {
      walkRules(
        fn: (rule: {
          selectors: string[];
          walkDecls(prop: string, fn: (decl: { remove(): void }) => void): void;
        }) => void,
      ): void;
      nodes: unknown[];
    };
  };
}

const scopedPreflight = plugin((api) => {
  const { addBase } = api;
  const { postcss } = api as unknown as PostcssApi;
  const require = createRequire(import.meta.url);
  const css = postcss.parse(
    readFileSync(require.resolve("tailwindcss/src/css/preflight.css"), "utf8"),
  );
  css.walkRules((rule) => {
    // `html` and `body` both become the root: the root keeps html's
    // line-height, which body's `line-height: inherit` would undo (on the
    // page, body inherited it from html).
    if (rule.selectors.length === 1 && rule.selectors[0]?.trim() === "body")
      rule.walkDecls("line-height", (decl) => decl.remove());
    rule.selectors = rule.selectors.map(scopeSelector);
  });
  addBase(css.nodes as never);
});

const config: Config = {
  darkMode: ["class"],
  // Preflight comes scoped to the editor's root (`scopedPreflight`).
  corePlugins: { preflight: false },
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      fontFamily: {
        // The brand four-role system's two app faces (theme.css owns
        // the stacks; fontsource loads the files in globals.css).
        sans: "var(--font-sans)",
        mono: "var(--font-mono)",
      },
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        // Resolved design-system roles (theme.css layer 2) — chrome
        // neutrals, status signals, overlay cues. Usable as
        // `bg-chrome-rail`, `text-status-error`, etc.
        chrome: {
          rail: "var(--chrome-rail-bg)",
          panel: "var(--chrome-panel-bg)",
          border: "var(--chrome-border)",
          divider: "var(--chrome-divider)",
          icon: "var(--chrome-icon)",
          "icon-active": "var(--chrome-icon-active)",
          "slot-active": "var(--chrome-slot-active)",
          menu: "var(--chrome-menu-text)",
          label: "var(--chrome-label)",
        },
        status: {
          approved: "var(--status-approved)",
          review: "var(--status-review)",
          progress: "var(--status-progress)",
          draft: "var(--status-draft)",
          error: "var(--status-error)",
          info: "var(--status-info)",
        },
        overlay: {
          selection: "var(--overlay-selection)",
          guide: "var(--overlay-guide)",
          snap: "var(--overlay-snap)",
          target: "var(--overlay-target)",
        },
        elevated: "var(--elevated)",
        surround: "var(--canvas-surround)",
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
      },
    },
  },
  plugins: [scopedPreflight, animate],
};

export default config;
