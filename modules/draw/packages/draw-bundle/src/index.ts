// @paged-media/draw-bundle — the paged.draw plugin bundle.

import { defineBundle } from "@paged-media/plugin-sdk";
import type { PluginManifest } from "@paged-media/plugin-api";

import { activate } from "./activate";
import manifestJson from "../manifest.json";

export const drawBundle = defineBundle({
  manifest: manifestJson as PluginManifest,
  activate,
});

export { activate };
