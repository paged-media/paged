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

// The words of recorded actions: their commands, the skip reasons and a
// step's replay verdict (plan E10).

import { defineMessages } from "@paged-media/strings";

export const ACTIONS = defineMessages("shell.actions", {
  startRecording: "Actions: start recording",
  stopRecording: "Actions: stop recording",
  playRecent: "Actions: play most recent",
  defaultName: "Action {n}",
  skipDisabled: "turned off",
  skipFailed: "failed while recording",
  skipDocumentBound: "carries ids from the recorded document",
  skipUnserializable: "payload could not be saved",
  verdictContextual: "selection",
  verdictPortable: "portable",
  verdictDocumentBound: "doc ids",
  verdictUnserializable: "not saved",
  verdictContextualTitle:
    "No payload — replays against whatever is selected at replay time.",
  verdictPortableTitle: "Payload carries no document ids — replays anywhere.",
  verdictDocumentBoundTitle:
    "Payload embeds ids minted by the recorded document. Skipped unless you allow document-bound steps.",
  verdictUnserializableTitle:
    "The payload could not be saved (a function, blob or cycle). This step can never replay.",
  // Editor ADR 1240 — the run plan, its refusals and its undo statement.
  stepName: "Step {n} “{title}”",
  thePage: "the page",
  needsSelection: "a selection, and nothing is selected",
  needsOneObject: "exactly one selected object",
  needsText: "a text selection",
  refuseNoDocument: "No document is open.",
  refuseRole:
    "This session may only fill the template's fields; running an action needs editing rights.",
  refuseContext: "{step} was recorded in {recorded}; you are in {current}.",
  refuseMissingCommand:
    "{step} needs the command {command}, which this editor does not have.",
  refuseNotOffered: "{step} is turned off in this editor.",
  refuseMissingObject:
    "{step} acts on {address}, which is not in this document.",
  refuseSelection: "{step} needs {needs}.",
  refuseArgs: "{step} cannot take its values: {why}",
  refuseAtRun: "Stopped before {step}: {why}",
  contextDiffers: "it was recorded in {recorded}; you are in {current}",
  refuseNoObjects: "the object model is not available here",
  undoOne: "Runs as one undo step: one Undo takes it all back.",
  undoSeveral:
    "Takes up to {count, plural, one {# undo step} other {# undo steps}}: {steps} make their own.",
  undoEach:
    "Each write is its own undo step here: up to {count, plural, one {# step} other {# steps}}.",
  setProperty: "Set {path} to {value}",
  runAction: "Run action: {name}",
  runActionDone: "run “{name}”",
  reviewInPanel: "Review",
  needsReview:
    "it takes more than one undo step, so it runs only from its preview",
  saveToDocument: "Save action to the document",
  scriptEditorOnly:
    "an editor command ({command}): a paged.* script cannot run it",
  documentFull: "The document's actions are larger than a label holds.",
});
