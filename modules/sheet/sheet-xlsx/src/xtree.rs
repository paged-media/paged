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

//! The writable XML tree of the worksheet children and table parts the
//! authoring rewrites (`<dataValidations>`, `<autoFilter>`, `<sortState>`,
//! `<sheetProtection>`, `tableN.xml`). It lives in `paged_ooxml::tree`, shared
//! with doc and slide; the name stays here for this crate's callers.

pub use paged_ooxml::tree::XNode;
