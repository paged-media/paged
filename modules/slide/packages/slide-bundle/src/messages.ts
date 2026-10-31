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

export const COMMENTS = defineMessages("slide.comments", {
  title: "Comments",
  empty: "No slide selected.",
  heading: "Slide {number} · comments",
  none: "No comments on this slide.",
  newPlaceholder: "Add a comment",
  add: "Comment",
  replyPlaceholder: "Reply",
  reply: "Reply",
  resolve: "Resolve",
  reopen: "Reopen",
  resolved: "Resolved",
  delete: "Delete",
  deleteReply: "Delete reply",
  yourName: "Your name",
  defaultAuthor: "paged user",
  noDeck: "Comments are kept for decks opened from PowerPoint.",
  showResolved: "Show resolved",
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
  addComment: "Add a comment",
  replyComment: "Reply to a comment",
  resolveComment: "Resolve or reopen a comment",
  deleteComment: "Delete a comment",
  previousSlide: "Previous slide",
  nextSlide: "Next slide",
  insertShape: "Insert a shape",
});

/** The Shapes panel (Insert ▸ Shapes) and its categories, PowerPoint's. */
export const SHAPES = defineMessages("slide.shapes", {
  title: "Shapes",
  empty: "Go to a slide to insert shapes.",
  insert: "Insert {name}",
  lines: "Lines",
  rectangles: "Rectangles",
  basicShapes: "Basic Shapes",
  blockArrows: "Block Arrows",
  equation: "Equation Shapes",
  flowchart: "Flowchart",
  starsAndBanners: "Stars and Banners",
  callouts: "Callouts",
  actionButtons: "Action Buttons",
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
  insertShapes: "Insert shape…",
  previousSlide: "Previous slide",
  nextSlide: "Next slide",
  addComment: "New comment",
});

/** The slide show, the presenter view and the slide sorter (show/,
 *  views/; slide ADR 716). */
export const SHOW = defineMessages("slide.show", {
  fromBeginning: "Slide show from the beginning",
  fromCurrent: "Slide show from the current slide",
  presenterView: "Presenter view",
  rehearseTimings: "Rehearse timings",
  slideSorter: "Slide sorter",
  title: "Slide show",
  endOfShow: "End of slide show. Click or press a key to exit.",
  slideOf: "Slide {at} of {of}",
  goTo: "Go to slide {number}",
  next: "Next",
  nextSlide: "Next slide",
  previousSlide: "Previous slide",
  endPreview: "End of slide show",
  notes: "Notes",
  noNotes: "No notes for this slide.",
  zoomIn: "Make the notes larger",
  zoomOut: "Make the notes smaller",
  pause: "Pause the timer",
  resume: "Resume the timer",
  reset: "Reset the timer",
  black: "Black screen",
  grid: "See all slides",
  laser: "Laser pointer",
  pen: "Pen",
  erase: "Erase the ink",
  end: "End show",
  recording: "Recording · slide {time} · total {total}",
  noAudience:
    "The audience window did not open; the presenter view is on this screen.",
  hidden: "Hidden",
  normalView: "Normal",
  selected: "{count} selected",
  hide: "Hide",
  unhide: "Unhide",
  transition: "Transition",
  noTransition: "None",
  sorterEmpty: "No slides. Open a PowerPoint deck with File ▸ Open.",
  noWebGpu:
    "Transitions need WebGPU, which this browser does not offer: the show cuts between slides.",
});

/** Animations (slide ADR 714): the Animations pane, its timeline and its
 *  commands. Effect names are PowerPoint's and stay English. */
export const ANIM = defineMessages("slide.anim", {
  title: "Animations",
  empty: "Go to a slide to animate its shapes.",
  heading: "Slide {number} · {count} animations",
  none: "No animations on this slide. Select a shape and add an effect.",
  selectShape: "Select a shape to add an effect to it.",
  add: "Add effect",
  entrance: "Entrance",
  emphasis: "Emphasis",
  exit: "Exit",
  motion: "Motion Paths",
  search: "Search effects",
  effectOptions: "Effect options",
  direction: "Direction",
  byParagraph: "By paragraph",
  start: "Start",
  onClick: "On Click",
  withPrevious: "With Previous",
  afterPrevious: "After Previous",
  duration: "Duration (s)",
  delay: "Delay (s)",
  repeat: "Repeat",
  repeatNone: "None",
  repeatUntilClick: "Until Next Click",
  rewind: "Rewind when done playing",
  trigger: "Trigger",
  triggerSequence: "As part of click sequence",
  triggerOn: "On click of {shape}",
  moveUp: "Move earlier",
  moveDown: "Move later",
  remove: "Remove",
  preview: "Preview",
  painter: "Animation Painter",
  painterArmed:
    "Click a shape to give it these animations (the command again cancels).",
  timeline: "Animation Pane",
  seconds: "{s} s",
  readOnly:
    "This effect is kept as the deck wrote it; its timing cannot be changed here.",
  shape: "Shape {name}",
  paragraph: "paragraph {n}",
  previewAnimations: "Preview animations",
  animationPainter: "Animation Painter",
  animationPane: "Animation pane",
});

/** The typed twins' titles (anim/contribute.ts), worded as the manifest's
 *  objectModel commands are, like OUTPUT_MODEL's. */
export const ANIM_MODEL = defineMessages("slide.animModel", {
  addAnimation: "Add an animation",
  removeAnimation: "Remove an animation",
  setAnimationTiming: "Set an animation's timing",
  moveAnimation: "Move an animation",
  listAnimations: "List a slide's animations",
  previewAnimations: "Preview a slide's animations",
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
  "Previous slide": "Previous slide",
  "Next slide": "Next slide",
  "New comment": "New comment",
  "Slide Show": "Slide Show",
  "From Beginning": "From Beginning",
  "From Current Slide": "From Current Slide",
  "Presenter View": "Presenter View",
  "Rehearse Timings": "Rehearse Timings",
  "Slide Sorter": "Slide Sorter",
  "Shapes…": "Shapes…",
  Animations: "Animations",
  "Animation Pane": "Animation Pane",
  "Preview Animations": "Preview Animations",
  "Animation Painter": "Animation Painter",
  "Export…": "Export…",
  "Save as template…": "Save as template…",
  "Custom Shows…": "Custom Shows…",
  "Add Section": "Add Section",
  Design: "Design",
  Themes: "Themes",
  "Browse for Themes…": "Browse for Themes…",
});

/** The palette category of this bundle's commands (an identity, labelled
 *  through the shell). */
defineMessages("commandCategory", {
  Slide: "Slide",
});

export const DECK = defineMessages("slide.deck", {
  format: "PowerPoint presentation (.pptx)",
  templateFormat: "PowerPoint template (.potx)",
  untitled: "Presentation",
  fromTemplate:
    "Opened the template “{name}” as a new presentation. Export it as a deck, or save it as a template again with File ▸ Save as template.",
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

export const CHARTS = defineMessages("slide.charts", {
  title: "Chart data",
  done: "Done",
  fullScreen: "Full screen",
  backToSlide: "Back to slide",
  refused: "The workbook did not take that entry.",
});

/** The typed twins' titles (output/commands.ts), worded as the manifest's
 *  objectModel commands are: what a script or the palette's typed list
 *  reads, not the Export view's button labels. */
export const OUTPUT_MODEL = defineMessages("slide.outputModel", {
  saveAsTemplate: "Save as template",
  customShows: "Custom shows",
  exportPdf: "Export PDF (slides, handouts, notes pages)",
  exportOutline: "Export the outline",
  exportVideo: "Create a video (MP4)",
  setCustomShow: "Set a custom show",
  deleteCustomShow: "Delete a custom show",
  playCustomShow: "Play a custom show",
  sections: "List the sections",
  renameSection: "Rename a section",
  moveSection: "Move a section",
  deleteSection: "Remove a section",
});

/** File ▸ Export, custom shows and sections (output/, slide ADR 720). */
export const OUTPUT = defineMessages("slide.output", {
  title: "Export",
  export: "Export…",
  saveAsTemplate: "Save as template…",
  customShows: "Custom shows…",
  addSection: "Add section",
  untitledSection: "Untitled Section",
  pdf: "Create PDF",
  pdfLayout: "Layout",
  layoutSlides: "Full page slides",
  layoutHandouts: "Handouts",
  layoutNotes: "Notes pages",
  perPage: "Slides per page",
  paper: "Paper",
  includeHidden: "Include hidden slides",
  exportPdf: "Export PDF",
  outline: "Outline",
  outlineRtf: "Outline (.rtf)",
  outlineTxt: "Outline (.txt)",
  template: "PowerPoint template (.potx)",
  templateHint:
    "A template opens as a new, untitled presentation built on this one.",
  video: "Create a video",
  resolution: "Resolution",
  fps: "Frames per second",
  secondsPerSlide: "Seconds on each slide",
  recordedTimings: "Use recorded timings",
  exportVideo: "Create video",
  cancel: "Cancel",
  running: "{done} of {total}",
  saved: "Saved {file}",
  failed: "The export failed: {reason}",
  replaced:
    "{count} characters of the notes are not in the PDF's standard font and print as “?”.",
  busy: "An export is running.",
  noGpu: "Without WebGPU the video's transitions are cuts.",
  showsTitle: "Custom shows",
  showsEmpty: "No custom shows. Name one and pick its slides.",
  showName: "Name",
  newShow: "New show",
  play: "Show",
  rename: "Rename",
  delete: "Delete",
  inShow: "In the show",
  moveUp: "Move up",
  moveDown: "Move down",
  section: "Section",
  renameSection: "Rename section",
  removeSection: "Remove section",
  sectionUp: "Move section up",
  sectionDown: "Move section down",
  sectionSlides: "{count} slides",
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

/** Slide W4's content verbs: pictures and icons, the format painter, the
 *  SmartArt text pane (content-commands.ts). */
export const CONTENT = defineMessages("slide.content", {
  insertPicture: "Insert picture…",
  insertIcon: "Insert icon…",
  insertVideo: "Insert video…",
  insertAudio: "Insert audio…",
  copyFormat: "Copy formatting",
  pasteFormat: "Paste formatting",
  smartArtText: "SmartArt text pane",
  smartArtPoints: "Read a SmartArt diagram's text",
  setSmartArtText: "Set a SmartArt point's text",
});

/** The SmartArt text pane (panels/smartart-panel.tsx). */
export const SMARTART = defineMessages("slide.smartart", {
  title: "Text Pane",
  empty: "Select a SmartArt graphic to edit its text.",
  heading: "Type your text here",
  point: "Point {number}",
  hint: "Enter writes the text; Shift+Enter starts a new paragraph. Points are edited, not added: the diagram keeps its layout.",
});

/** Design ▸ Themes and the deck's document styles (slide ADRs 713, 719;
 *  panels/design-panel.tsx). */
export const DESIGN = defineMessages("slide.design", {
  title: "Design",
  openDesign: "Design",
  themes: "Themes",
  variants: "Variants",
  thisPresentation: "This presentation",
  browse: "Browse for Themes…",
  listThemes: "List the themes",
  applyTheme: "Apply a theme",
  apply: "Apply {name}",
  variant: "Variant: {name}",
  current: "{name}",
  fonts: "{major} / {minor}",
  empty: "Open a PowerPoint deck to change its theme.",
  missing: "{count} references missing",
  remap: "Remap",
  remapReference: "Remap a theme reference",
  remapTo: "Replace {id} with",
  none: "(none)",
  refused: "The theme could not be applied.",
  note: "A theme recolours every theme colour of the deck and sets its heading and body fonts, in one undo step.",
});

defineTranslations("de", de);

/** The Slide Master view and the layout verbs (slide ADR 712). */
export const MASTERS = defineMessages("slide.masters", {
  slideMaster: "Slide master",
  closeMaster: "Close master view",
  empty: "This deck has no slide masters.",
  master: "Slide master",
  layout: "Layout",
  usedBy: "{count, plural, one {Used by # slide} other {Used by # slides}}",
  unused: "Not used",
  rename: "Rename",
  preserve: "Preserve",
  deleteLayout: "Delete layout",
  insertPlaceholder: "Insert placeholder",
  placeholders: "Placeholders",
  deletePlaceholder: "Delete placeholder",
  textSize: "Text size",
  textStyle: "Font style",
  apply: "Apply",
  changeLayout: "Change layout",
  resetSlide: "Reset slide",
  newSlideFrom: "New slide from layout",
  listLayouts: "List the masters and layouts",
  renameLayout: "Rename a master or layout",
  setPreserve: "Preserve a master or layout",
  deleteLayoutTyped: "Delete a layout no slide uses",
  insertPlaceholderTyped: "Insert a placeholder on a layout",
  setPlaceholderStyle: "Set a layout placeholder's text style",
  phBody: "Content",
  phTitle: "Title",
  phPic: "Picture",
  phChart: "Chart",
  phTbl: "Table",
  phMedia: "Media",
  phDt: "Date",
  phFtr: "Footer",
  phSldNum: "Slide number",
});
