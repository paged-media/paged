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

// The words of print output: the working profile, the standard's
// readiness and why a print PDF is not PDF/X-4 (plan E10).

import { defineMessages } from "@paged-media/strings";

export const PRINT = defineMessages("shell.printOutput", {
  noProfile: "No CMYK profile",
  notLoaded: "{profile} · not loaded",
  readyX4: "Ready · X-4",
  readyPdf17: "Ready · PDF 1.7",
  noIntentNoProfile:
    "No output intent: the document has no CMYK working space, so the print PDF is PDF 1.7. Choose a profile in Color settings for PDF/X-4.",
  noIntentNotLoaded:
    "No output intent: {profile} is named but not loaded, so the print PDF is PDF 1.7. Load the profile in Color settings for PDF/X-4.",
});
