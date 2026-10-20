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

// @paged-media/panel-kit — the controls every panel of the editor and the
// built-in modules shares, one implementation each (docs/adr/PM-0002:
// internal; importable by the built-ins and the editor, never by
// platform/extensions). Record: docs/migration/shared-foundations.md, C10.

export {
  chrome,
  color,
  font,
  radius,
  space,
  status,
  type Tone,
} from "./tokens";
export {
  ARMED_TITLE,
  CONFIRM_MS,
  ConfirmButton,
  useConfirm,
  type Confirm,
  type ConfirmButtonProps,
} from "./confirm";
export {
  About,
  Disclosure,
  useDisclosure,
  type DisclosureProps,
  type DisclosureState,
} from "./disclosure";
export {
  createDebouncer,
  useDebouncedValue,
  type Debouncer,
  type Timers,
} from "./debounce";
export {
  Refusal,
  StatusLine,
  statusLineStyle,
  useActionFeedback,
} from "./feedback";
export {
  ChoiceGroup,
  ChoiceRow,
  IconButton,
  Segment,
  Tab,
  type ChoiceGroupProps,
  type ChoiceRowProps,
  type IconButtonProps,
  type SegmentProps,
  type TabProps,
} from "./controls";
export {
  FieldInput,
  FieldSelect,
  FieldTextarea,
  LabelledBy,
  NamedAs,
  useFieldName,
  useRowLabelId,
  type FieldName,
} from "./labels";
export { humanize, refusalText } from "./text";
export { enumMemberLabel, humaniseIdentifier } from "./enum-labels";
