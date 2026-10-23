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

// The words paged.slide shows (editor plan E10): the Slides and Notes
// panels, the property panels, the object kinds and typed commands, the
// template fields' refusals and the import/export notices. English beside
// the code; the German in locales/de.json, registered here, which every
// entry point imports.
//
// What stays English: the manifest's titles, the engine's import and export
// diagnostics (it writes them), and the object model's refusals to scripts
// (they name addresses and paths, as the API's outcomes do).

import { defineMessages, defineTranslations } from "@paged-media/strings";

import de from "../locales/de.json" with { type: "json" };

export const SLIDES = defineMessages("slide.slides", {
  title: "Slides",
  layout: "Layout",
  newSlide: "New slide",
  empty: "No slides. Open a PowerPoint deck with File ▸ Open.",
  goTo: "Go to slide {number}",
  duplicateTitle: "Duplicate slide",
  duplicate: "Duplicate",
  deleteTitle: "Delete slide",
  delete: "Delete",
  show: "Show in slideshow",
  hide: "Hide from slideshow",
  unhideButton: "Unhide",
  hideButton: "Hide",
});

export const NOTES = defineMessages("slide.notes", {
  title: "Notes",
  empty: "No slide selected.",
  heading: "Slide {number} · speaker notes",
  previous: "Previous slide",
  next: "Next slide",
  placeholder: "Click to add notes",
});

export const PANELS = defineMessages("slide.panels", {
  slide: "Slide",
  transition: "Transition",
  notes: "Speaker notes",
  placeholder: "Placeholder",
  deck: "Deck",
});

export const MODEL = defineMessages("slide.model", {
  kindSlide: "Slide",
  kindLayout: "Slide layout",
  kindPlaceholder: "Placeholder",
  kindDeck: "Deck",
  newSlide: "New slide",
  importPptx: "Open a PowerPoint deck",
  duplicateSlide: "Duplicate slide",
  exportPptx: "Export as a PowerPoint deck",
});

/** The palette commands (commands.ts). */
export const COMMANDS = defineMessages("slide.commands", {
  newSlide: "New slide",
  duplicateSlide: "Duplicate slide",
  deleteSlide: "Delete slide",
  moveSlideUp: "Move slide up",
  moveSlideDown: "Move slide down",
  importPptx: "Open PowerPoint deck…",
  exportPptx: "Export PowerPoint deck…",
});

/** The menu items this bundle adds (menu.ts): the path stays English (it is
 *  the item's identity) and the shell shows each segment through this. */
defineMessages("menu", {
  Slide: "Slide",
  "Open PowerPoint deck…": "Open PowerPoint deck…",
  "Export PowerPoint deck…": "Export PowerPoint deck…",
  "New slide": "New slide",
  "Duplicate slide": "Duplicate slide",
  "Delete slide": "Delete slide",
  "Move slide up": "Move slide up",
  "Move slide down": "Move slide down",
});

/** The palette category of this bundle's commands (an identity, labelled
 *  through the shell). */
defineMessages("commandCategory", {
  Slide: "Slide",
});

export const DECK = defineMessages("slide.deck", {
  format: "PowerPoint presentation (.pptx)",
  cannotOpen:
    "This host cannot open a native document, so a PowerPoint deck cannot be opened.",
  notFromDeck:
    "This document was not opened from a PowerPoint deck, so it cannot be exported as one yet.",
  fontsUsed: "Fonts used: {fonts}",
  // A ")" right after a "}" ends a message object for the strings guard,
  // which reads these calls as text: the parentheses close in a second
  // literal.
  noFontDoor:
    "This host cannot give the document the fonts the deck embeds ({families}" +
    "); text set in them is drawn in a substitute.",
  fontRefused:
    "The embedded font “{family}” ({style}" +
    ") was not loaded: {reason}. Text set in it is drawn in a substitute.",
});

export const TEMPLATE = defineMessages("slide.template", {
  noSlide: "The deck has no slide {slide}.",
  onNoSlide: "The field's item is on no slide of this deck.",
  notPlaceholder:
    "The field's item is not a placeholder, and the field names none.",
  noPlaceholder: "Slide {slide} has no {type} placeholder.",
  noPlaceholderAt:
    "Slide {slide} has no {type} placeholder with index {index}.",
  deniedDocument:
    "The template does not permit {permission} on the document, which this field needs.",
  deniedTarget:
    "The template does not permit {permission} on {target}, which is outside this field.",
  refused: "the deck refused the value",
  placeholderTextTitle: "Slide placeholder text",
  mustBeText: "A placeholder's text must be text.",
  oneLine: "A title is one line and cannot hold a line break.",
  noText: "The placeholder holds no text (a picture or a chart).",
  shownTitle: "Slide shown",
  yesOrNo: "Whether a slide is shown is yes or no.",
  cannotHide:
    "The template does not let a filler show or hide slides: it must grant document.metadata to the whole document.",
});

defineTranslations("de", de);
