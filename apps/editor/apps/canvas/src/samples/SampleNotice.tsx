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

// Editor ADR 1243, amendment 1 — the sample publications are other
// publishers' work, shown for illustration. Each one names its publisher (the
// catalog's `credit`), and one line under the list says what they are and
// where they come from. Text beside the pictures, never part of one.

import type { CSSProperties } from "react";
import { defineMessages, useStrings } from "@paged-media/strings";

const M = defineMessages("app.samples", {
  credit: "© {publisher}",
  notice:
    "These sample publications are used for illustrative and demonstration purposes only. They come from archive.org and remain their publishers’ property; their type is set in Google Fonts standing in for the publishers’ own.",
});

/** The publisher of one sample, as its catalog entry names it. */
export function SampleCredit({
  publisher,
  style,
}: {
  publisher?: string;
  style?: CSSProperties;
}) {
  const strings = useStrings();
  if (!publisher) return null;
  return (
    <span style={style} data-sample-credit>
      {strings.t(M.credit, { publisher })}
    </span>
  );
}

/** What the samples are and where they come from, under their list. */
export function SampleNotice({ style }: { style?: CSSProperties }) {
  const strings = useStrings();
  return (
    <p style={style} data-samples-notice>
      {strings.t(M.notice)}
    </p>
  );
}
