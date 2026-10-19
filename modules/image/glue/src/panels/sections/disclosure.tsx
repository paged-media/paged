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

// The image panel's collapsible section: the shared kit's Disclosure
// (@paged-media/panel-kit), open by default, with the panel's section
// title. Its notes use the kit's `About` directly.

import { Disclosure } from "@paged-media/panel-kit";
import type { ReactNode } from "react";

import { sectionTitle } from "./styles";

/** A collapsible panel section. Open by default: the controls inside are
 *  the panel's working surface, and collapsing is the user's choice. */
export function Section({
  title,
  open = true,
  children,
  ...data
}: {
  title: ReactNode;
  open?: boolean;
  children: ReactNode;
  [data: `data-${string}`]: string | boolean | undefined;
}) {
  return (
    <Disclosure
      summary={title}
      defaultOpen={open}
      summaryStyle={sectionTitle}
      {...data}
    >
      {children}
    </Disclosure>
  );
}
