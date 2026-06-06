// contributePanel — register a panel through the contract surface.
//
// Since the B-15 host-side fix (2026-06-06) the HOST derives the
// `paged.panel.show.<id>` / `paged.panel.hide.<id>` command pair from
// the registry for every registration path — this helper no longer
// builds bundle-namespaced duplicates. It remains the recommended
// door (future capability stamping), and `host.shell.openPanel`
// stays available for programmatic opens.

import type {
  BundleHost,
  Disposable,
  PanelContribution,
} from "@paged-media/plugin-api";

export function contributePanel(
  host: BundleHost,
  panel: PanelContribution,
): Disposable {
  return host.contribute.panel(panel);
}
