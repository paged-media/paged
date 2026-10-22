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

// The words the editor and the built-in modules show (plan E4, E10).
//
// Each package defines its English messages beside the code that shows
// them (`defineMessages`), so the English source is where the code is and
// a key cannot drift from its text. A locale catalogue (JSON, by key)
// overrides the English; a key it lacks falls back to the English, never
// to the key. A message takes `{name}` parameters and one plural form,
// `{count, plural, one {# field} other {# fields}}`.
//
// Components read the catalogue through `useStrings()`. Code that is not a
// component (a refusal turned into a sentence) reads the active catalogue,
// which the editor sets when it mounts: two editors on one page share it.

import {
  createContext,
  createElement,
  useContext,
  type ReactNode,
} from "react";

import de from "../locales/de.json";

export type Params = Readonly<Record<string, string | number>>;

/** A locale's messages, by key. */
export type Catalogue = Readonly<Record<string, string>>;

/** Translations packages register beside their English (`defineTranslations`),
 *  by language. */
const shipped = new Map<string, Record<string, string>>([["de", { ...de }]]);

/**
 * A package's translation of its messages into `locale`, registered when the
 * package loads, as its English is (`defineMessages`): each package keeps its
 * own locale files beside its code, and the editor's catalogue for a
 * language is all of them together.
 */
export function defineTranslations(locale: string, catalogue: Catalogue): void {
  const into = shipped.get(locale) ?? {};
  for (const [key, text] of Object.entries(catalogue)) {
    const known = into[key];
    if (known !== undefined && known !== text)
      throw new Error(
        `strings: ${locale} ${key} is translated twice differently`,
      );
    into[key] = text;
  }
  shipped.set(locale, into);
}

/** The locales the editor ships, by language: every package's translations
 *  registered so far. */
export const BUILT_IN_LOCALES: Readonly<Record<string, Catalogue>> = new Proxy(
  {},
  {
    get: (_t, locale: string) => shipped.get(locale),
    has: (_t, locale: string) => shipped.has(locale),
    ownKeys: () => [...shipped.keys()],
    getOwnPropertyDescriptor: (_t, locale: string) =>
      shipped.has(locale)
        ? { enumerable: true, configurable: true, value: shipped.get(locale) }
        : undefined,
  },
);

/** The English source of every defined message, by key. */
const english = new Map<string, string>();

/**
 * Defines a package's messages under `namespace`, with their English text.
 * Answers the keys, so a call site names a key the compiler checks:
 * `const M = defineMessages("form", { empty: "No fields." })` then
 * `t(M.empty)`.
 */
export function defineMessages<K extends string>(
  namespace: string,
  messages: Readonly<Record<K, string>>,
): Readonly<Record<K, string>> {
  const keys = {} as Record<K, string>;
  for (const [name, text] of Object.entries(messages) as [K, string][]) {
    const key = `${namespace}.${name}`;
    const known = english.get(key);
    if (known !== undefined && known !== text)
      throw new Error(`strings: ${key} is defined twice with different text`);
    english.set(key, text);
    keys[name] = key;
  }
  return keys;
}

/** Every defined key with its English text (the extraction source). */
export function englishSource(): Catalogue {
  return Object.fromEntries(
    [...english].sort(([a], [b]) => a.localeCompare(b)),
  );
}

export interface Strings {
  readonly locale: string;
  /** The message for `key` in this locale, else its English text. */
  t(key: string, params?: Params): string;
}

/** `{count, plural, one {…} other {…}}`, then `{name}` parameters. */
export function format(
  text: string,
  params: Params | undefined,
  locale: string,
): string {
  if (!params) return text;
  const plural =
    /\{(\w+),\s*plural,\s*((?:\s*(?:=\d+|zero|one|two|few|many|other)\s*\{[^{}]*\})+)\s*\}/g;
  let out = text.replace(plural, (_all, name: string, forms: string) => {
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
  out = out.replace(/\{(\w+)\}/g, (all, name: string) =>
    name in params ? String(params[name]) : all,
  );
  return out;
}

/** The strings of `locale`: its catalogue over the English source. */
export function createStrings(
  locale = "en",
  catalogue: Catalogue = {},
): Strings {
  return {
    locale,
    t(key, params) {
      const text = catalogue[key] ?? english.get(key) ?? key;
      return format(text, params, locale);
    },
  };
}

let active: Strings = createStrings();

/** The catalogue code outside a component reads; the editor sets it. */
export function activeStrings(): Strings {
  return active;
}

export function setActiveStrings(strings: Strings): void {
  active = strings;
}

/** `t` against the active catalogue. */
export function t(key: string, params?: Params): string {
  return active.t(key, params);
}

const StringsContext = createContext<Strings | null>(null);

/** Puts `strings` in front of the components below it, and makes it the
 *  active catalogue for code that is not a component. */
export function StringsProvider({
  strings,
  children,
}: {
  strings: Strings;
  children?: ReactNode;
}) {
  setActiveStrings(strings);
  return createElement(StringsContext.Provider, { value: strings }, children);
}

/** The strings of the editor this component is in (the active ones
 *  outside a provider). */
export function useStrings(): Strings {
  return useContext(StringsContext) ?? active;
}

/**
 * A locale's catalogue: `messages` when the host hands them over, else the
 * one the editor ships (`BUILT_IN_LOCALES`), else
 * `<assetBase>/locales/<locale>.json` (an `assetBase` always fetches). English needs none. A catalogue that
 * cannot be fetched leaves the English in place and says why.
 */
export async function loadLocale(
  locale: string,
  options: {
    messages?: Catalogue;
    assetBase?: string;
    fetch?: typeof fetch;
  } = {},
): Promise<{ strings: Strings; problem: string | null }> {
  if (options.messages)
    return { strings: createStrings(locale, options.messages), problem: null };
  if (locale === "en" || locale.startsWith("en-"))
    return { strings: createStrings(locale), problem: null };
  const shipped =
    BUILT_IN_LOCALES[locale] ?? BUILT_IN_LOCALES[locale.split("-")[0]!];
  if (shipped && options.assetBase === undefined)
    return { strings: createStrings(locale, shipped), problem: null };
  const base = (options.assetBase ?? "").replace(/\/$/, "");
  const url = `${base}/locales/${locale}.json`;
  try {
    const res = await (options.fetch ?? fetch)(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return {
      strings: createStrings(locale, (await res.json()) as Catalogue),
      problem: null,
    };
  } catch (err) {
    return {
      strings: createStrings(locale),
      problem: `no ${locale} catalogue at ${url} (${(err as Error).message}); the English stays`,
    };
  }
}
