// A do-nothing DataToolsApi for surface tests that do not exercise the data
// tools (sheet ADR 517); tests that do pass their own members over it.

import type { DataToolsApi } from "../src/data-tools";

export function dataToolsStub(over: Partial<DataToolsApi> = {}): DataToolsApi {
  const fail = { ok: false as const, message: "stub" };
  return {
    entryAlert: () => null,
    answerEntryAlert: () => {},
    cellPrompt: () => null,
    validationListOpen: () => false,
    openCellDropdown: () => false,
    chooseListItem: () => {},
    invalidCircles: () => null,
    toggleInvalidCircles: () => false,
    cellProtectionAt: () => null,
    dataCard: () => null,
    openDataCard: () => false,
    closeDataCard: () => {},
    validationDraft: () => null,
    applyValidation: () => fail,
    clearValidationOnSelection: () => fail,
    filterButtons: () => null,
    filterValues: () => null,
    applyFilter: () => fail,
    toggleAutofilter: () => fail,
    sortFilterColumn: () => fail,
    sortDialogInfo: () => null,
    sortWith: () => fail,
    hideSelection: () => fail,
    groupSelection: () => fail,
    canGoalSeek: () => false,
    goalSeek: () => fail,
    ...over,
  };
}
