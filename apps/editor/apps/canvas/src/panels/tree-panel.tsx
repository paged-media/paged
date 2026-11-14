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

// The Tree panel (`paged.tree`) is the document's accessible object tree
// (editor ADR "An accessible object tree", D-13 of ADR 1201): the spreads
// and their page items as a virtualized WAI-ARIA tree, synchronised with the
// canvas selection both ways. The component lives in `ui/A11yObjectTree`;
// the panel is where the cockpit docks it, and `paged.view.objectTree`
// (Alt+Shift+O) brings it up from the canvas.

import { A11yObjectTree } from "../ui/A11yObjectTree";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PanelProps = any;

export function TreePanel(_: PanelProps) {
  return <A11yObjectTree />;
}
