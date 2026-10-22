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

// A translated sentence with elements inside it: the message keeps its
// `{name}` placeholders for the parts that are elements (a name in bold),
// so a language can put them where its word order needs them.

import { Fragment, type ReactNode } from "react";

/** `text` with each `{name}` that `parts` names replaced by that node. */
export function richText(
  text: string,
  parts: Readonly<Record<string, ReactNode>>,
): ReactNode[] {
  return text.split(/(\{\w+\})/).map((piece, i) => {
    const name = /^\{(\w+)\}$/.exec(piece)?.[1];
    return (
      <Fragment key={i}>
        {name !== undefined && Object.hasOwn(parts, name) ? parts[name] : piece}
      </Fragment>
    );
  });
}
