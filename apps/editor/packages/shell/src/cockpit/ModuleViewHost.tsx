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

// Editor ADR 306 — a module view (extensions ADR 345, C5) in place of the
// canvas: the cockpit layout renders it where the document viewport was,
// as it renders an export-style mode's panel, and keeps the viewport
// mounted and hidden behind it (ADR 240).

import type { ViewContribution } from "../registries/view";
import { useRegistries } from "../state/registries-context";

export function ModuleViewHost({ view }: { view: ViewContribution }) {
  const views = useRegistries().views;
  const Render = view.render;
  return (
    <div
      data-paged-module-view={view.id}
      role="region"
      aria-label={view.title}
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        overflow: "auto",
        background: "var(--pg-bg)",
      }}
    >
      <Render id={view.id} close={() => void views.show(null)} />
    </div>
  );
}
