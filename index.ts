import type {
  ExtensionAPI,
  ExtensionContext,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
import type { McpExtensionState } from "./state.js";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Type } from "@sinclair/typebox";
import {
  showStatus,
  showTools,
  reconnectServers,
  authenticateServer,
  openMcpPanel,
} from "./commands.js";
import { loadMcpConfig } from "./config.js";
import { flushMetadataCache, initializeMcp, updateStatusBar } from "./init.js";
import { loadMetadataCache } from "./metadata-cache.js";
import {
  executeCall,
  executeConnect,
  executeDescribe,
  executeList,
  executeSearch,
  executeStatus,
  executeUiMessages,
} from "./proxy-modes.js";
import { getConfigPathFromArgv } from "./utils.js";

export default function mcpAdapter(pi: ExtensionAPI) {
  let state: McpExtensionState | null = null;
  let initPromise: Promise<McpExtensionState> | null = null;

  pi.registerFlag("mcp-config", {
    description: "Path to MCP config file",
    type: "string",
  });

  // Only activate MCP support if the project has a .pi/mcp.json file
  const projectMcpPath = resolve(process.cwd(), ".pi", "mcp.json");
  if (!existsSync(projectMcpPath)) return;

  const earlyConfigPath = getConfigPathFromArgv();

  const getPiTools = (): ToolInfo[] => pi.getAllTools();

  pi.on("session_start", async (_event, ctx) => {
    initPromise = initializeMcp(pi, ctx);

    initPromise
      .then((s) => {
        state = s;
        initPromise = null;
        updateStatusBar(s);
      })
      .catch((err) => {
        console.error("MCP initialization failed:", err);
        initPromise = null;
      });
  });

  pi.on("session_shutdown", async () => {
    if (initPromise) {
      try {
        state = await initPromise;
      } catch {
        // Initialization failed, nothing to clean up
      }
    }

    if (state) {
      if (state.uiServer) {
        state.uiServer.close("session_shutdown");
        state.uiServer = null;
      }
      flushMetadataCache(state);
      await state.lifecycle.gracefulShutdown();
      state = null;
    }
  });

  pi.registerCommand("mcp", {
    description: "Show MCP server status",
    handler: async (args, ctx) => {
      if (!state && initPromise) {
        try {
          state = await initPromise;
        } catch {
          if (ctx.hasUI) ctx.ui.notify("MCP initialization failed", "error");
          return;
        }
      }
      if (!state) {
        if (ctx.hasUI) ctx.ui.notify("MCP not initialized", "error");
        return;
      }

      const parts = args?.trim()?.split(/\s+/) ?? [];
      const subcommand = parts[0] ?? "";
      const targetServer = parts[1];

      switch (subcommand) {
        case "reconnect":
          await reconnectServers(state, ctx, targetServer);
          break;
        case "tools":
          await showTools(state, ctx);
          break;
        case "status":
        case "":
        default:
          if (ctx.hasUI) {
            await openMcpPanel(state, pi, ctx, earlyConfigPath);
          } else {
            await showStatus(state, ctx);
          }
          break;
      }
    },
  });

  pi.registerCommand("mcp-auth", {
    description: "Authenticate with an MCP server (OAuth)",
    handler: async (args, ctx) => {
      const serverName = args?.trim();
      if (!serverName) {
        if (ctx.hasUI) ctx.ui.notify("Usage: /mcp-auth <server-name>", "error");
        return;
      }

      if (!state && initPromise) {
        try {
          state = await initPromise;
        } catch {
          if (ctx.hasUI) ctx.ui.notify("MCP initialization failed", "error");
          return;
        }
      }
      if (!state) {
        if (ctx.hasUI) ctx.ui.notify("MCP not initialized", "error");
        return;
      }

      await authenticateServer(serverName, state.config, ctx);
    },
  });

  pi.registerTool({
    name: "mcp",
    label: "MCP",
    description:
      "Query and run MCP server tools. Workflow: 1) mcp({}) lists servers. 2) mcp({search:\"keyword\"}) finds tools. 3) mcp({tool:\"name\", args:'{\"key\":\"val\"}'}) runs a tool. mcp({describe:\"name\"}) shows full schema.",
    promptSnippet:
      "Query and run MCP server tools. Workflow: 1) mcp({}) lists servers. 2) mcp({search:\"keyword\"}) finds tools. 3) mcp({tool:\"name\", args:'{\"key\":\"val\"}'}) runs a tool. mcp({describe:\"name\"}) shows full schema.",
    parameters: Type.Object({
      tool: Type.Optional(
        Type.String({
          description: "Tool name to invoke. Use with 'args'.",
        }),
      ),
      args: Type.Optional(
        Type.String({
          description:
            "Tool params as JSON string. Required with 'tool'. Example: '{\"path\": \"file.txt\"}'",
        }),
      ),
      connect: Type.Optional(
        Type.String({
          description:
            "Connect to a server by name. Use mcp({}) to see available servers.",
        }),
      ),
      describe: Type.Optional(
        Type.String({
          description: "Get full schema for a tool by exact name.",
        }),
      ),
      search: Type.Optional(
        Type.String({
          description:
            "Search tool names/descriptions. Use 'server' to narrow scope.",
        }),
      ),
      regex: Type.Optional(
        Type.Boolean({
          description: "Treat 'search' as regex.",
        }),
      ),
      includeSchemas: Type.Optional(
        Type.Boolean({
          description: "Include param schemas in search results.",
        }),
      ),
      server: Type.Optional(
        Type.String({
          description: "Search only this server. Omit for all servers.",
        }),
      ),
      action: Type.Optional(
        Type.String({
          description: "Set 'ui-messages' for UI messages. Omit otherwise.",
        }),
      ),
    }),
    async execute(
      _toolCallId,
      params: {
        tool?: string;
        args?: string;
        connect?: string;
        describe?: string;
        search?: string;
        regex?: boolean;
        includeSchemas?: boolean;
        server?: string;
        action?: string;
      },
      _signal,
      _onUpdate,
      _ctx,
    ) {
      let parsedArgs: Record<string, unknown> | undefined;
      if (params.args) {
        try {
          parsedArgs = JSON.parse(params.args);
          if (
            typeof parsedArgs !== "object" ||
            parsedArgs === null ||
            Array.isArray(parsedArgs)
          ) {
            const gotType = Array.isArray(parsedArgs)
              ? "array"
              : parsedArgs === null
                ? "null"
                : typeof parsedArgs;
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Invalid args: expected a JSON object, got ${gotType}`,
                },
              ],
              isError: true,
              details: { error: "invalid_args_type" },
            };
          }
        } catch (e) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Invalid args JSON: ${e instanceof Error ? e.message : e}`,
              },
            ],
            isError: true,
            details: { error: "invalid_args" },
          };
        }
      }

      if (!state && initPromise) {
        try {
          state = await initPromise;
        } catch {
          return {
            content: [
              { type: "text" as const, text: "MCP initialization failed" },
            ],
            details: { error: "init_failed" },
          };
        }
      }
      if (!state) {
        return {
          content: [{ type: "text" as const, text: "MCP not initialized" }],
          details: { error: "not_initialized" },
        };
      }

      if (params.action === "ui-messages") {
        return executeUiMessages(state);
      }
      if (params.tool) {
        return executeCall(state, params.tool, parsedArgs, params.server);
      }
      if (params.connect) {
        return executeConnect(state, params.connect);
      }
      if (params.describe) {
        return executeDescribe(state, params.describe);
      }
      if (params.search) {
        return executeSearch(
          state,
          params.search,
          params.regex,
          params.server,
          params.includeSchemas,
          getPiTools,
        );
      }
      if (params.server) {
        return executeList(state, params.server);
      }
      return executeStatus(state);
    },
  });
}
