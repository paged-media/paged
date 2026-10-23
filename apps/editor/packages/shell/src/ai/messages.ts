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
