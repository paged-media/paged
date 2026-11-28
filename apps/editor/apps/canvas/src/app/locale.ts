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

// The page's language, in this order:
//
//   1. `?locale=` in the URL (a link, a test);
//   2. the user's own choice, kept under `paged.locale` in the page's
//      storage, when there is one;
//   3. the browser's languages (`navigator.languages`, most wanted first),
//      the first one the editor ships a catalogue for, or English when
//      English comes before any of those;
//   4. English.
//
// A locale named by the URL or by the stored choice is taken as given (a
// host may serve its catalogue beside the app); the browser's languages
// only ever pick a catalogue the editor ships.

/** The user's language choice, in the page's storage. */
export const LOCALE_KEY = "paged.locale";

const TAG = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i;
const isEnglish = (tag: string) => /^en(-|$)/i.test(tag);

export interface LocaleSources {
  /** The URL's query string. */
  search: string;
  /** The page's storage; a blocked one reads as no choice. */
  storage: { getItem(key: string): string | null } | null;
  /** The browser's languages, most wanted first. */
  languages: readonly string[];
  /** The languages the editor ships a catalogue for (`de`). */
  shipped: readonly string[];
}

/** The locale the page starts in, and where it came from. */
export function chooseLocale(sources: LocaleSources): {
  locale: string;
  from: "url" | "choice" | "browser" | "default";
} {
  const fromUrl = new URLSearchParams(sources.search).get("locale");
  if (fromUrl && TAG.test(fromUrl)) return { locale: fromUrl, from: "url" };
  const chosen = storedLocale(sources.storage);
  if (chosen) return { locale: chosen, from: "choice" };
  const shipped = new Set(sources.shipped.map((l) => l.toLowerCase()));
  for (const tag of sources.languages) {
    if (!TAG.test(tag)) continue;
    if (isEnglish(tag)) return { locale: tag, from: "browser" };
    const lower = tag.toLowerCase();
    if (shipped.has(lower) || shipped.has(lower.split("-")[0]!))
      return { locale: tag, from: "browser" };
  }
  return { locale: "en", from: "default" };
}

function storedLocale(storage: LocaleSources["storage"]): string | null {
  if (!storage) return null;
  try {
    const value = storage.getItem(LOCALE_KEY);
    return value && TAG.test(value) ? value : null;
  } catch {
    // Storage blocked: no choice was kept.
    return null;
  }
}

/** Does `locale` need a catalogue (anything but English)? */
export function needsCatalogue(locale: string): boolean {
  return !isEnglish(locale);
}
