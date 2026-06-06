// contributePanel — register a panel COMPLETELY: the panel
// contribution plus namespaced show/hide commands routed through
// `host.shell` (the cockpit owns placement; bundle panels have no
// mode slot, so the command pair — reachable from the palette and
// bindable to keys — is their entry path). Mirrors the host's own
// `paged.panel.show.<id>` convention under the bundle's namespace.

import type {
  BundleHost,
  Disposable,
  PanelContribution,
} from "@paged-media/plugin-api";

import { DisposableStore } from "./disposables";

export function contributePanel(
  host: BundleHost,
  panel: PanelContribution,
): Disposable {
  const store = new DisposableStore();
  store.add(host.contribute.panel(panel));
  store.add(
    host.contribute.command({
      id: `${panel.id}.show`,
      title: `Show: ${panel.title}`,
      category: "View",
      icon: panel.icon,
      handler: () => {
        host.shell.openPanel(panel.id);
      },
    }),
  );
  store.add(
    host.contribute.command({
      id: `${panel.id}.hide`,
      title: `Hide: ${panel.title}`,
      category: "View",
      handler: () => {
        host.shell.closePanel(panel.id);
      },
    }),
  );
  return store;
}
