// contributeTool — register a tool COMPLETELY: the rail contribution,
// its activation command, and the guarded single-key shortcut.
//
// Why this exists: the host builds activation commands/keybindings
// only for the STARTUP tool set (`buildToolbarContributions` over the
// `tools` prop) — tools registered later get a rail slot but no
// shortcut (plugin-draw BREAKAGE_LOG B-15). The SDK closes the gap
// with the same class-wide rule the host uses: a tool single-key
// shortcut is inert while a text caret is active, so typing "p" in a
// story never switches tools.

import type {
  BundleHost,
  Disposable,
  PagedEditor,
  ToolContribution,
} from "@paged-media/plugin-api";

import { DisposableStore } from "./disposables";

/** The host's text-suppression guard, replicated for bundle-owned
 *  keybindings: active only while no content selection (text caret)
 *  exists. */
function contentSelectionInactive(state: unknown): boolean {
  const editor = state as PagedEditor | null;
  return editor?.contentSelection?.contentSelection == null;
}

export function contributeTool(
  host: BundleHost,
  tool: ToolContribution,
): Disposable {
  const store = new DisposableStore();
  store.add(host.contribute.tool(tool));
  // Activation command — bundle-namespaced (`<tool.id>.activate`
  // keeps it inside the manifest namespace since tool ids already
  // are), mirroring the host's `paged.tool.activate.<id>` pattern.
  const commandId = `${tool.id}.activate`;
  store.add(
    host.contribute.command({
      id: commandId,
      title: `Tool: ${tool.title}`,
      category: "Tools",
      icon: tool.icon,
      handler: (paged: unknown) => {
        (paged as PagedEditor).tool.setBaseTool(tool.id);
      },
    }),
  );
  if (tool.shortcut) {
    store.add(
      host.contribute.keybinding({
        key: tool.shortcut,
        command: commandId,
        when: contentSelectionInactive,
      }),
    );
  }
  return store;
}
