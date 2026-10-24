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

// Word's status bar (doc ADR 608, editor ADR 298): page X of Y, the word
// count (the selection's of the document's while text is selected) and the
// zoom. Language and Track Changes join in waves 3 and 4.

import type { BundleHost, StatusItemProps } from "@paged-media/plugin-api";
import { subscribeOf, useLive } from "@paged-media/react-live";
import { useStrings } from "@paged-media/strings";
import { useEffect, useState } from "react";

import { WORD } from "../messages.js";
import type { WordStore } from "./word-state.js";

export function makePageStatus(store: WordStore) {
  function PageStatus(_props: StatusItemProps) {
    const strings = useStrings();
    const page = useLive(store, subscribeOf).get().page;
    if (!page) return null;
    return (
      <span data-word-status="page">
        {strings.t(WORD.page, { page: page.index + 1, pages: page.count })}
      </span>
    );
  }
  return PageStatus;
}

export function makeWordsStatus(store: WordStore) {
  function WordsStatus(_props: StatusItemProps) {
    const strings = useStrings();
    const words = useLive(store, subscribeOf).get().words;
    if (!words) return null;
    return (
      <span
        data-word-status="words"
        data-words-total={words.total}
        data-words-selected={words.selected ?? undefined}
      >
        {words.selected === null
          ? strings.t(WORD.words, { count: words.total })
          : strings.t(WORD.wordsOf, {
              selected: words.selected,
              total: words.total,
            })}
      </span>
    );
  }
  return WordsStatus;
}

/** How often the zoom readout looks at the camera: the viewport door has
 *  no camera event, and a readout a quarter second behind a zoom is one
 *  nobody can see lag. */
const ZOOM_POLL_MS = 250;

export function makeZoomStatus(host: BundleHost) {
  function ZoomStatus(_props: StatusItemProps) {
    const strings = useStrings();
    const [scale, setScale] = useState(() => host.viewport.camera().scale);
    useEffect(() => {
      const timer = setInterval(
        () => setScale(host.viewport.camera().scale),
        ZOOM_POLL_MS,
      );
      return () => clearInterval(timer);
    }, []);
    return (
      <span data-word-status="zoom">
        {strings.t(WORD.zoom, { percent: Math.round(scale * 100) })}
      </span>
    );
  }
  return ZoomStatus;
}
