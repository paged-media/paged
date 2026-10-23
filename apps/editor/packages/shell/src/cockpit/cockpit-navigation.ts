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

// Cockpit — filmstrip/document-map navigation hand-off. The camera
// fit math (page layout + fit) lives app-side; the app registers a
// navigator from inside the provider tree (CanvasAppIntegration) and
// the shell's chrome calls it, through the editor's scope (plan task E1).

import { scoped, useScoped, type EditorScope } from "../state/editor-scope";

export type PageNavigator = (pageIndices: number[]) => void;

const NAVIGATOR = scoped("pageNavigator", () => ({
  current: null as PageNavigator | null,
}));

export function setCockpitPageNavigator(
  scope: EditorScope,
  fn: PageNavigator | null,
): void {
  scope.get(NAVIGATOR).current = fn;
}

export function navigateToPages(
  scope: EditorScope,
  pageIndices: number[],
): void {
  scope.get(NAVIGATOR).current?.(pageIndices);
}

/** Navigate in the editor this component is mounted in. */
export function usePageNavigation(): (pageIndices: number[]) => void {
  const navigator = useScoped(NAVIGATOR);
  return (pageIndices) => navigator.current?.(pageIndices);
}
