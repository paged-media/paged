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

// The words of the AI service: whether it is there, its errors in words,
// and the steps of an assistant run (plan E10).

import { defineMessages } from "@paged-media/strings";

export const AI = defineMessages("shell.ai", {
  unavailable:
    "Claude is not available here: this deployment has no AI service.",
  stopped: "Stopped.",
  serviceUnavailable: "The AI service is not available on this deployment.",
  tooManyRequests: "Too many AI requests right now. Try again shortly.",
  overloaded: "Claude is overloaded right now. Try again shortly.",
  noService: "This deployment has no AI service.",
  stepGeneric: "Step {n}: changing the document",
  retrying: "Retrying: {error}",
  overset:
    "{count, plural, one {# story is overset} other {# stories are overset}}",
  checkedPage: "Checked the look of page {page}",
  declined: "Claude declined this request.",
  notUndone:
    "The document changed after Claude's edit, so it was not undone. Use Edit ▸ Undo instead.",
});

// Editor ADR 1234 — Inspect → Propose → Preview → Approve → Apply.
export const PROPOSAL = defineMessages("shell.aiProposal", {
  checks: "Checks",
  checksIntro:
    "Run on this device; nothing leaves it. Each finding is a proposed change you preview and approve.",
  checkSmallText: "Text smaller than {size} pt",
  checkContrast: "Text with too little contrast (WCAG 4.5:1)",
  checkAltText: "Images without alternative text",
  checkSizeOverrides: "Sizes that override their paragraph style",
  minSize: "Smallest size",
  styleContains: "Only paragraph styles named",
  styleContainsPlaceholder: "Caption",
  scope: "Look at",
  scopeSelection: "The selection",
  scopeDocument: "The whole document",
  runChecks: "Run checks",
  checksTitle: "Proposed by the checks",
  claudeTitle: "Proposed by Claude",
  claudeEmpty: "Claude proposes no change.",
  inspecting: "Inspecting…",
  readsSoFar: "{count, plural, one {# read} other {# reads}} so far",
  consentTitle: "Send this request to Claude?",
  consentWhat: "What leaves this device, for this request only:",
  consentRequest: "your request: “{text}”",
  consentObjects:
    "{count, plural, =0 {the document's object addresses} one {the address of # selected object} other {the addresses of # selected objects}}",
  consentValues:
    "the property values Claude reads (sizes, colours, styles, positions)",
  consentText: "the text of the objects it reads",
  consentNoText: "no text: Claude sees sizes, colours and styles only",
  consentWhere:
    "It goes to Anthropic through this editor's AI service and is not kept by the editor.",
  consentNothing:
    "Claude only reads and proposes; nothing changes until you approve.",
  allowText: "Claude may read the text",
  send: "Send to Claude",
  cancel: "Cancel",
  nothingChanged: "Nothing has changed yet.",
  noFindings: "Nothing to change: the checks found no issue.",
  outsideScope: "That is outside what the user allowed Claude to read.",
  textWithheld: "(text withheld by the user)",
  dropped:
    "{count, plural, one {# change outside the selection was} other {# changes outside the selection were}} left out.",
  before: "now",
  after: "proposed",
  cleared: "the style's value",
  needsValue: "Write it to apply this item",
  altTextLabel: "Alternative text for {subject}",
  apply:
    "{count, plural, =0 {Apply} one {Apply # change} other {Apply # changes}}",
  discard: "Discard",
  applied:
    "{count, plural, one {Applied # change} other {Applied # changes}} as {steps, plural, one {one undo step} other {# undo steps}}.",
  undo: "Undo",
  done: "Done",
  undoLabel: "Apply the assistant's proposal",
  notUndone:
    "The document changed after the approval, so it was not undone. Use Edit ▸ Undo instead.",
  smaller: "{size} pt is smaller than {min} pt",
  contrast: "contrast {ratio}:1, needs {need}:1",
  noAltText: "no alternative text",
  overrides: "{size} pt overrides the {size2} pt of {style}",
  image: "the image {name}",
  declined: "Claude declined this request.",
  noProposal: "Claude did not propose a change set.",
  checksOnly:
    "Claude is not available here, so the assistant offers the checks on this device only.",
});
