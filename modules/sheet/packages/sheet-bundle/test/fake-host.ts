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

// The one fake `BundleHost` of this package's suites. A test spells out the
// doors it drives; the compiler holds each of them to the contract, so a
// door or a member the contract renames, removes or re-types fails
// `bun run typecheck` here instead of drifting behind an
// `as unknown as BundleHost`.
//
// The fake is exactly what the test gives it, at run time too: a door the
// test leaves out is absent. The bundle still asks whether some doors and
// members are there (`typeof host.document.frameChain`), and those suites
// drive both answers.

import type { BundleHost } from "@paged-media/plugin-api";

/** The doors a test provides: any of the host's surfaces, each with any of
 *  its members, typed as the contract types them. */
export type FakeHostParts = {
  readonly [K in Exclude<keyof BundleHost, "editor">]?: BundleHost[K] extends (
    ...args: never[]
  ) => unknown
    ? BundleHost[K]
    : Partial<BundleHost[K]>;
} & {
  /** The raw editor behind the host: any of its parts, each with any of
   *  its members (a test gives the client one method, not all of it). */
  readonly editor?: {
    readonly [K in keyof BundleHost["editor"]]?: Partial<
      BundleHost["editor"][K]
    >;
  };
};

/** A `BundleHost` made of `parts` and nothing else. */
export function fakeBundleHost(parts: FakeHostParts = {}): BundleHost {
  return parts as BundleHost;
}
