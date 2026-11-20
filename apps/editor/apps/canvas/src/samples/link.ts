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

// A `?sample=` link and a `?script=` run on one page (editor ADR 1243,
// amendment 2): the script is a tour of the sample, so it waits until the
// sample has opened — or the link has given up — before it starts. Without
// a sample to wait for, it starts at once, as before. The wait is the
// editor's own (a scoped store, created per editor and dropped with it).
import { scoped } from "@paged-media/shell";
import { samplesEnabled } from "./catalog";

/** This editor's sample link: settled once it has opened its sample or given up. */
export interface SampleLinkState {
  readonly settled: Promise<void>;
  settle(): void;
}

export function createSampleLinkState(): SampleLinkState {
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => (settle = resolve));
  return { settled, settle: () => settle() };
}

export const SAMPLE_LINK = scoped("sampleLink", createSampleLinkState);

/** Whether this page's URL asks for a sample this build will open. */
export function sampleLinkPending(
  search: string = globalThis.location?.search ?? "",
): boolean {
  return samplesEnabled() && new URLSearchParams(search).has("sample");
}

/** Resolves once the page's `?sample=` link has opened its sample or given
 *  up; at once when there is none to wait for. */
export function sampleLinkSettled(
  link: SampleLinkState,
  search?: string,
): Promise<void> {
  return sampleLinkPending(search) ? link.settled : Promise.resolve();
}
