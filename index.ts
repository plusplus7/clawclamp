import path from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { resolveClawClampConfig, clawClampConfigSchema } from "./src/config.js";
import { createClawClampHttpHandler } from "./src/http.js";
import { createClawClampService } from "./src/guard.js";

const plugin = {
  id: "clawclamp",
  name: "Clawclamp",
  description: "Cedar-based authorization guard with tool audit logging.",
  configSchema: clawClampConfigSchema,
  register(api: OpenClawPluginApi) {
    const config = resolveClawClampConfig(api.pluginConfig);
    const stateDir = api.runtime.state.resolveStateDir();
    const service = createClawClampService({ api, config, stateDir });

    api.on(
      "before_tool_call",
      async (event, ctx) => service.handleBeforeToolCall(event, ctx),
      { priority: -10 },
    );
    api.on("after_tool_call", async (event, ctx) => service.handleAfterToolCall(event, ctx));

    const assetsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "assets");
    const gatewayToken =
      typeof api.config.gateway?.auth?.token === "string" ? api.config.gateway.auth.token : undefined;
    api.registerHttpRoute({
      path: "/plugins/clawclamp",
      auth: "plugin",
      match: "prefix",
      handler: createClawClampHttpHandler({
        stateDir,
        config,
        assetsDir,
        gatewayToken,
        onPolicyUpdate: async () => {
          await service.resetCedarling();
        },
      }),
    });
  },
};

export default plugin;
