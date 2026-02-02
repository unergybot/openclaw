import type { OpenClawPluginApi } from "../../src/plugins/types.js";

import { createBestBoxTool } from "./src/bestbox-tool.js";

export default function register(api: OpenClawPluginApi) {
  api.registerTool(createBestBoxTool(api), { optional: false });
}
