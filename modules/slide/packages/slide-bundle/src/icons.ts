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

// The bundled icons of Insert ▸ Icons (slide ADR 723): a small set drawn
// for paged, our own work, dedicated to the public domain (CC0-1.0) so a
// deck that uses them carries no licence. Each is a 24 × 24 SVG, black
// strokes on nothing, which the engine places as vectors and export writes
// as PowerPoint writes an icon (`asvg:svgBlip` beside a PNG).

export const ICONS_PANEL_ID = "media.paged.slide.panel.icons";

const svg = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 24 24" fill="none" stroke="#000000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

/** The icons, by name (the name is the English label). */
export const ICONS: readonly { name: string; svg: string }[] = [
  { name: "Arrow", svg: svg('<path d="M4 12h15M13 6l6 6-6 6"/>') },
  { name: "Check", svg: svg('<path d="M4 13l5 5L20 6"/>') },
  { name: "Cross", svg: svg('<path d="M5 5l14 14M19 5L5 19"/>') },
  { name: "Plus", svg: svg('<path d="M12 4v16M4 12h16"/>') },
  {
    name: "Star",
    svg: svg(
      '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
    ),
  },
  {
    name: "Heart",
    svg: svg(
      '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>',
    ),
  },
  {
    name: "Home",
    svg: svg('<path d="M3 11l9-7 9 7M5 9.5V20h5v-6h4v6h5V9.5"/>'),
  },
  {
    name: "Mail",
    svg: svg(
      '<rect x="3" y="5" width="18" height="14" rx="1.5"/><path d="M3.5 6l8.5 7 8.5-7"/>',
    ),
  },
  {
    name: "Calendar",
    svg: svg(
      '<rect x="3.5" y="5" width="17" height="15" rx="1.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
    ),
  },
  {
    name: "Clock",
    svg: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.5 2"/>'),
  },
  {
    name: "Person",
    svg: svg(
      '<circle cx="12" cy="8" r="4"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/>',
    ),
  },
  {
    name: "Light bulb",
    svg: svg(
      '<path d="M9 17h6M10 20.5h4M8.5 14.5a6 6 0 1 1 7 0c-.8.6-1.5 1.4-1.5 2.5h-4c0-1.1-.7-1.9-1.5-2.5z"/>',
    ),
  },
  {
    name: "Chart",
    svg: svg('<path d="M4 20h16M7 20v-6M12 20V8M17 20v-9"/>'),
  },
  {
    name: "Globe",
    svg: svg(
      '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.6 3.5 5.4 3.5 8.5s-1 5.9-3.5 8.5c-2.5-2.6-3.5-5.4-3.5-8.5s1-5.9 3.5-8.5z"/>',
    ),
  },
  {
    name: "Lock",
    svg: svg(
      '<rect x="5" y="11" width="14" height="9.5" rx="1.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    ),
  },
  {
    name: "Chat",
    svg: svg('<path d="M4 5h16v11H9l-5 4z"/>'),
  },
];

/** A bundled icon's SVG bytes; null for a name that is not one. */
export function iconBytes(name: string): Uint8Array | null {
  const i = ICONS.find((x) => x.name === name);
  return i ? new TextEncoder().encode(i.svg) : null;
}
