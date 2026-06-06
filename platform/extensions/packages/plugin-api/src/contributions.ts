// Curated re-exports: the contribution surface a bundle registers
// against. Source of truth during incubation is `@paged-media/shell`
// (the editor repo); this façade narrows it to the contract subset.
// Nothing enters this list speculatively — a name is added when a
// bundle (paged.draw first) actually needs it, and every gap found
// goes to plugin-draw/BREAKAGE_LOG.md.

export type {
  // Registries handed to bundles via BundleHost.
  ShellRegistries,
  // Tools — the rail + gesture spine.
  ToolContribution,
  ToolRegistry,
  ToolId,
  ToolGroupId,
  ToolSectionId,
  ToolOptionsSpec,
  ToolOptionField,
  CursorSpec,
  // Gesture handler contract (page-resolved pointer events in pt;
  // mutate only through the client).
  GestureHandler,
  CanvasPointerEvent,
  OverlayContext,
  OverlayPrimitive,
  DeactivateReason,
  // Panels — expert-leaf React components in v0.
  PanelContribution,
  PanelRegistry,
  PanelProps,
  PanelApi,
  // Overlays — contributions render into the shared camera-space SVG.
  OverlayContribution,
  OverlayRegistry,
  // Commands + keybindings.
  CommandContribution,
  CommandRegistry,
  KeybindingContribution,
  KeybindingRegistry,
  // The editor handle a bundle works against.
  PagedEditor,
  // Tool-preview signal shapes (the v0 "overlay" rendering surface).
  ToolPreviewShape,
  ToolPreviewPolyline,
} from "@paged-media/shell";
