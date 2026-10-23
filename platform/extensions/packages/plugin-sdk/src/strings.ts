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

// `host.strings` (extensions ADR 333): a bundle's words in the editor's
// language. The editor backs it with its own catalogue (the language the
// host chose, with every bundle's translations); without one, a bundle's
// English answers, formatted the same way.

import type {
  MessageParams,
  PluginManifest,
  StringsSurface,
} from "@paged-media/plugin-api";

/** What the host wires behind `host.strings`. */
export interface StringsBacking {
  /** The editor's language. */
  locale(): string;
  /** Registers a message's English. */
  define(key: string, english: string): void;
  /** Registers a translation. */
  translate(locale: string, key: string, text: string): void;
  /** The message in the editor's language, else its English. */
  t(key: string, params?: MessageParams): string;
}

/** `{count, plural, one {…} other {…}}`, then `{name}` parameters. */
export function formatMessage(
  text: string,
  params: MessageParams | undefined,
  locale: string,
): string {
  if (!params) return text;
  const plural =
    /\{(\w+),\s*plural,\s*((?:\s*(?:=\d+|zero|one|two|few|many|other)\s*\{[^{}]*\})+)\s*\}/g;
  const out = text.replace(plural, (_all, name: string, forms: string) => {
    const n = Number(params[name]);
    const cases = new Map<string, string>();
    for (const m of forms.matchAll(
      /(=\d+|zero|one|two|few|many|other)\s*\{([^{}]*)\}/g,
    ))
      cases.set(m[1]!, m[2]!);
    const chosen =
      cases.get(`=${n}`) ??
      cases.get(new Intl.PluralRules(locale).select(n)) ??
      cases.get("other") ??
      "";
    return chosen.replace(/#/g, new Intl.NumberFormat(locale).format(n));
  });
  return out.replace(/\{(\w+)\}/g, (all, name: string) =>
    name in params ? String(params[name]) : all,
  );
}

/** English only: the posture of a host with no catalogue. */
export function englishStrings(): StringsBacking {
  const english = new Map<string, string>();
  return {
    locale: () => "en",
    define: (key, text) => void english.set(key, text),
    translate: () => {},
    t: (key, params) => formatMessage(english.get(key) ?? key, params, "en"),
  };
}

/** The surface a bundle sees, its keys held to its own namespace. */
export function stringsSurface(
  manifest: PluginManifest,
  backing: StringsBacking,
): StringsSurface {
  const ns = `${manifest.id}.`;
  const defined = new Map<string, string>();
  return {
    get locale() {
      return backing.locale();
    },
    define(messages) {
      const keys = {} as Record<string, string>;
      for (const [name, text] of Object.entries(messages) as [
        string,
        string,
      ][]) {
        const key = `${ns}${name}`;
        const known = defined.get(key);
        if (known !== undefined && known !== text)
          throw new Error(
            `host.strings: ${key} is defined twice with different text`,
          );
        defined.set(key, text);
        backing.define(key, text);
        keys[name] = key;
      }
      return keys as never;
    },
    translate(locale, catalogue) {
      for (const [key, text] of Object.entries(catalogue)) {
        if (!key.startsWith(ns))
          throw new Error(
            `host.strings: ${key} is outside this bundle's namespace (${ns}…)`,
          );
        backing.translate(locale, key, text);
      }
    },
    t: (key, params) => backing.t(key, params),
  };
}
