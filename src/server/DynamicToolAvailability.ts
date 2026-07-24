import type { McpServer, RegisteredTool } from "@modelcontextprotocol/server";

import {
  buildCapabilityInventory,
  type AvailabilityPolicy,
} from "../application/CapabilityInventory.js";
import type { BinarySessionPort } from "../application/BinarySession.js";
import type { ClientFeatureAvailability } from "../contracts/toolOutputSchemaPrimitives.js";

interface ToolAvailabilityController {
  /** Apply current session, policy, host, provider, and client availability. */
  synchronize(): boolean;
}

/**
 * Track public SDK tool handles and keep their visible state synchronized with
 * the same availability projection returned by `binary_session`.
 */
export const installDynamicToolAvailability = (
  server: McpServer,
  session: BinarySessionPort,
  policy: () => AvailabilityPolicy,
): ToolAvailabilityController => {
  const tools = new Map<string, RegisteredTool>();
  const originalRegisterTool = server.registerTool.bind(server);
  const originalSendToolListChanged = server.sendToolListChanged.bind(server);
  let synchronizing = false;
  const controller: ToolAvailabilityController = {
    synchronize: () => {
      if (synchronizing) return false;
      synchronizing = true;
      try {
        const availability = new Map<string, boolean>(
          buildCapabilityInventory(
            session.status(),
            policy(),
            clientFeatures(server),
          ).map((item) => [item.name, item.available]),
        );
        let changed = false;
        for (const [name, tool] of tools) {
          const enabled = availability.get(name) === true;
          if (tool.enabled === enabled) continue;
          changed = true;
          if (enabled) tool.enable();
          else tool.disable();
        }
        return changed;
      } finally {
        synchronizing = false;
      }
    },
  };

  const wrappedRegisterTool = (...args: unknown[]): unknown => {
    const name = args[0];
    if (typeof name !== "string")
      throw new TypeError("MCP tool registration requires a string name");
    const registered: unknown = Reflect.apply(
      originalRegisterTool,
      server,
      args,
    );
    if (!isRegisteredTool(registered))
      throw new TypeError(`MCP SDK did not return a tool handle for ${name}`);
    tools.set(name, registered);
    return registered;
  };
  if (!Reflect.set(server, "registerTool", wrappedRegisterTool))
    throw new TypeError("Unable to install dynamic MCP tool registration");
  if (
    !Reflect.set(server, "sendToolListChanged", () => {
      if (controller.synchronize()) originalSendToolListChanged();
    })
  )
    throw new TypeError("Unable to install dynamic MCP tool notifications");

  return controller;
};

const clientFeatures = (server: McpServer): ClientFeatureAvailability => {
  const capabilities = server.server.getClientCapabilities();
  return {
    elicitation_form: capabilities?.elicitation?.form !== undefined,
    elicitation_url: capabilities?.elicitation?.url !== undefined,
    roots: capabilities?.roots !== undefined,
    sampling: capabilities?.sampling !== undefined,
  };
};

const isRegisteredTool = (value: unknown): value is RegisteredTool => {
  if (typeof value !== "object" || value === null) return false;
  return (
    typeof Reflect.get(value, "enabled") === "boolean" &&
    typeof Reflect.get(value, "enable") === "function" &&
    typeof Reflect.get(value, "disable") === "function"
  );
};
