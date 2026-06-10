// The contribution surface a bundle registers against — OWNED by
// this package since the M1.1(a) vendoring pass (2026-06-06): the
// shapes live in ./editor (hand-written, narrow handles + 1:1
// contribution mirrors); the EDITOR asserts compatibility against
// them through its dev link (apps/canvas/src/plugin-api-compat.ts).
// Nothing enters this surface speculatively — additions cite a real
// bundle's need and get API review.

export type {
  // Registries handed to bundles via BundleHost.
  ShellRegistries,
  ToolRegistry,
  PanelRegistry,
  CommandRegistry,
  KeybindingRegistry,
  OverlayRegistry,
  EditContextRegistry,
  ObjectTypeRegistry,
  ImporterRegistry,
  ExporterRegistry,
  // Tools — the rail + gesture spine.
  ToolContribution,
  ToolId,
  ToolGroupId,
  ToolSectionId,
  ToolOptionsSpec,
  ToolOptionField,
  CursorSpec,
  CssCursorToken,
  // Gesture handler contract.
  GestureHandler,
  CanvasPointerEvent,
  OverlayContext,
  OverlayPrimitive,
  DeactivateReason,
  // Panels — expert-leaf React components in v0.
  PanelContribution,
  PanelProps,
  PanelApi,
  // Overlays.
  OverlayContribution,
  OverlayProps,
  OverlayPageRect,
  // Commands + keybindings.
  CommandContribution,
  KeybindingContribution,
  // Document IO — importers + exporters (K-2 / S-06).
  ImporterContribution,
  ImportRequest,
  ExporterContribution,
  ExportResult,
  // Shared base types.
  DockEdge,
  VisibilityPredicate,
  // The editor handle a bundle works against.
  PagedEditor,
  PagedClient,
  // Tool-preview signal shapes (the v0 overlay surface).
  ToolPreviewShape,
  ToolPreviewPolyline,
  ToolPreviewPath,
  MarqueeRectPageLocal,
} from "./editor";
