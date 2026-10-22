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

// The contents of a region that holds commands and host components: the
// header's right-hand cluster when a profile lists it, and the actions bar
// (docs/composable-editor.md §5.2). A command id renders as a button that
// invokes it and greys while it does not apply (ADR 249); a group renders
// its items together; `host` leaves a slot the embedding host fills
// (plan task E5). An id no command answers to renders nothing.

import { Fragment } from "react";

import { Button } from "../components/ui/button";
import type { RegionItem } from "../profile/types";
import { entryApplies } from "../registries/types";
import { useRegistryView } from "../state/live";
import { useOptionalPaged } from "../state/paged-editor";
import { useRegistries } from "../state/registries-context";

export function RegionItems({
  items,
  primary,
}: {
  items: readonly RegionItem[];
  /** The command rendered as the region's primary button. */
  primary?: string;
}) {
  const commands = useRegistryView(useRegistries().commands);
  const paged = useOptionalPaged();

  const render = (item: RegionItem, key: string) => {
    if (typeof item === "string") {
      const command = commands.get(item);
      if (!command || commands.offered?.(item) === false) return null;
      return (
        <Button
          key={key}
          size="sm"
          variant={item === primary ? "default" : "ghost"}
          data-region-command={item}
          disabled={!entryApplies(undefined, item, commands, () => paged)}
          onClick={() => void commands.invoke(item)}
        >
          {command.title}
        </Button>
      );
    }
    switch (item.kind) {
      case "separator":
        return (
          <span
            key={key}
            aria-hidden
            style={{
              width: 1,
              alignSelf: "stretch",
              background: "var(--chrome-border)",
            }}
          />
        );
      case "spacer":
        return <span key={key} aria-hidden style={{ flex: 1 }} />;
      case "host":
        return <div key={key} data-host-component={item.id} />;
      case "group":
        return (
          <div
            key={key}
            role="group"
            data-region-group={item.id}
            style={{ display: "flex", alignItems: "center", gap: 4 }}
          >
            {item.items.map((child, i) => render(child, `${key}.${i}`))}
          </div>
        );
    }
  };

  return <Fragment>{items.map((item, i) => render(item, String(i)))}</Fragment>;
}

/** The actions bar: a row of host actions and commands, full width. */
export function ActionsBar({ items }: { items: readonly RegionItem[] }) {
  return (
    <div
      data-actions-bar
      role="toolbar"
      aria-label="Actions"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 12px",
        borderBottom: "1px solid var(--chrome-border)",
        background: "var(--pg-bg)",
      }}
    >
      <RegionItems items={items} />
    </div>
  );
}
