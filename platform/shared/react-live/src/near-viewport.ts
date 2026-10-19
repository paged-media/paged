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

// Which items of a long list have come near the viewport, from ONE
// IntersectionObserver on a React 19.3 Fragment ref (apps/editor ADR 240).
//
// A list renders its items inside `<Fragment ref={near.observe}>`; the observer
// watches every top-level element of the fragment, the ones added later
// included (FragmentInstance.observeUsing), so no item needs a ref of its
// own. Each item's element names itself with `data-near="<key>"`. An item
// counts as near once it has intersected the viewport (with `rootMargin` of
// look-ahead) and stays near: a thumbnail decoded or rendered once is kept.
// The first `eager` items count as near from the start, so what the list
// shows on its first paint never waits for the observer, and a renderer
// without one (a test DOM) shows the list's head.

import { useCallback, useState, type FragmentInstance } from "react";

/** What this uses of react-dom's FragmentInstance (React 19.3); typed here
 *  so the package needs no react-dom types of its own. */
interface ObservedFragment {
  observeUsing(observer: IntersectionObserver): void;
  unobserveUsing(observer: IntersectionObserver): void;
}

export interface NearViewportOptions {
  /** Items counted as near before the observer reports (default 12). */
  eager?: number;
  /** The observer's look-ahead margin (default "300px"). */
  rootMargin?: string;
}

export interface NearViewport {
  /** The ref callback for the `<Fragment>` around the items (named so
   *  the React Compiler does not take the object for a ref). */
  observe: (fragment: FragmentInstance | null) => (() => void) | undefined;
  /** Whether the item with this key, at this index, is near. */
  has(key: string, index: number): boolean;
}

export function useNearViewport(
  options: NearViewportOptions = {},
): NearViewport {
  const eager = options.eager ?? 12;
  const rootMargin = options.rootMargin ?? "300px";
  const [seen, setSeen] = useState<ReadonlySet<string>>(() => new Set());
  // eslint-disable-next-line no-restricted-syntax -- a ref callback: a new identity detaches the observer and attaches a new one (ADR 229)
  const observe = useCallback(
    (fragment: FragmentInstance | null): (() => void) | undefined => {
      if (!fragment || typeof IntersectionObserver === "undefined") return;
      const observer = new IntersectionObserver(
        (entries) => {
          const keys: string[] = [];
          for (const e of entries) {
            const key = (e.target as HTMLElement).dataset?.near;
            if (e.isIntersecting && key) keys.push(key);
          }
          if (keys.length === 0) return;
          setSeen((prev) => {
            if (keys.every((k) => prev.has(k))) return prev;
            const next = new Set(prev);
            for (const k of keys) next.add(k);
            return next;
          });
        },
        { rootMargin },
      );
      const observed = fragment as unknown as ObservedFragment;
      observed.observeUsing(observer);
      return () => {
        observed.unobserveUsing(observer);
        observer.disconnect();
      };
    },
    [rootMargin],
  );
  return {
    observe,
    has: (key, index) => index < eager || seen.has(key),
  };
}
