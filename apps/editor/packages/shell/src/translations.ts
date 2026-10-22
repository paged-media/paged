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

// The shell's German, registered when the shell loads (plan E10). It
// loads every message file too, so the catalogue never names a key the
// running code has not defined.

import { defineTranslations } from "@paged-media/strings";

import de from "../locales/de.json";
import "./messages";
import "./actions/messages";
import "./ai/messages";
import "./catalog/messages";
import "./chrome/messages";
import "./cockpit/messages";
import "./components/messages";
import "./lib/messages";
import "./registries/messages";
import "./state/messages";

defineTranslations("de", de);
