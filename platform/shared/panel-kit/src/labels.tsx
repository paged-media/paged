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

// A row's label names the controls of the row.
//
// Panels lay a field out as a label beside its control (a grid row, a
// stacked row), and the label was a plain span: the control had no
// accessible name, and assistive technology read "edit text" or "combo
// box" for every field of the panel. A row now gives its label an id and
// wraps its controls in `LabelledBy`; a field with no visible label (an
// icon chip, a cell under a sublabel) wraps its control in `NamedAs`. A
// control without a name of its own takes one from the nearest of them
// (`useFieldName`). One row fixes every control in it, and one control
// fixes every row it is used in.

import * as React from "react";

type Naming = { id: string } | { name: string };
const FieldNaming = React.createContext<Naming | undefined>(undefined);

/** Name the controls inside by the element with id `id` (the row's
 *  visible label). */
export function LabelledBy(props: {
  id: string;
  children?: React.ReactNode;
}): React.ReactElement {
  return <FieldNaming value={{ id: props.id }}>{props.children}</FieldNaming>;
}

/** Name the controls inside `name`, where no visible label does. With
 *  `fallback`, only where nothing above names them already (a field that
 *  names itself unless its row does). */
export function NamedAs(props: {
  name: string;
  fallback?: boolean;
  children?: React.ReactNode;
}): React.ReactElement {
  const above = React.useContext(FieldNaming);
  if (props.fallback && above) return <>{props.children}</>;
  return (
    <FieldNaming value={{ name: props.name }}>{props.children}</FieldNaming>
  );
}

/** The naming attributes of a control: its own, or else the nearest
 *  `LabelledBy` / `NamedAs` above it. Spread on the control. */
export interface FieldName {
  "aria-label"?: string;
  "aria-labelledby"?: string;
}

export function useFieldName(own?: FieldName): FieldName {
  const naming = React.useContext(FieldNaming);
  if (own?.["aria-labelledby"] || own?.["aria-label"]) {
    return {
      "aria-label": own["aria-label"],
      "aria-labelledby": own["aria-labelledby"],
    };
  }
  if (!naming) return {};
  return "id" in naming
    ? { "aria-labelledby": naming.id }
    : { "aria-label": naming.name };
}

/** The id of the row label naming the controls here, if a `LabelledBy`
 *  does (for a cell that adds its own sublabel to it). */
export function useRowLabelId(): string | undefined {
  const naming = React.useContext(FieldNaming);
  return naming && "id" in naming ? naming.id : undefined;
}

// ------------------------------------------------------------ native fields

/** A native `<select>` named by its row (a panel's own select in a
 *  labelled row). Everything else is the element's own. */
export function FieldSelect(
  props: React.ComponentProps<"select">,
): React.ReactElement {
  const named = useFieldName(props);
  return <select {...props} {...named} />;
}

/** A native `<input>` named by its row. */
export function FieldInput(
  props: React.ComponentProps<"input">,
): React.ReactElement {
  const named = useFieldName(props);
  return <input {...props} {...named} />;
}

/** A native `<textarea>` named by its row. */
export function FieldTextarea(
  props: React.ComponentProps<"textarea">,
): React.ReactElement {
  const named = useFieldName(props);
  return <textarea {...props} {...named} />;
}
