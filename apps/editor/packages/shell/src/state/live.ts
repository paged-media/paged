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

// The shell's registries as render values (apps/editor ADR 229). The
// mechanism is @paged-media/react-live's `useLive`, shared with the modules;
// this file names the shell's two uses of it.

import {
  onChangeOf,
  onDidChangeOf,
  useLive,
  type Listen,
} from "@paged-media/react-live";

export { useLive, onChangeOf, onDidChangeOf, type Listen };

/** A registry as a render value: `useRegistryView(menus).list()` reads the
 *  live list, and a memo over it (the compiler's included) recomputes when
 *  the registry changes. Keep the registry itself for effects and
 *  handlers. */
export function useRegistryView<
  T extends { onChange(handler: () => void): { dispose(): void } },
>(registry: T): T {
  return useLive(registry, onChangeOf as Listen<T>);
}
