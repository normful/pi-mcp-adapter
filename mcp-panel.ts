import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { McpConfig, McpPanelCallbacks } from "./types.js";
import type { MetadataCache, ServerCacheEntry, CachedTool } from "./metadata-cache.js";

interface PanelTheme {
  border: string;
  title: string;
  selected: string;
  needsAuth: string;
  placeholder: string;
  description: string;
  hint: string;
}

const DEFAULT_THEME: PanelTheme = {
  border: "2",
  title: "2",
  selected: "36",
  needsAuth: "33",
  placeholder: "2;3",
  description: "2",
  hint: "2",
};

function fg(code: string, text: string): string {
  if (!code) return text;
  return `\x1b[${code}m${text}\x1b[0m`;
}

const RAINBOW_COLORS = [
  "38;2;178;129;214",
  "38;2;215;135;175",
  "38;2;254;188;56",
  "38;2;228;192;15",
  "38;2;137;210;129",
  "38;2;0;175;175",
  "38;2;23;143;185",
];

function rainbowProgress(filled: number, total: number): string {
  const dots: string[] = [];
  for (let i = 0; i < total; i++) {
    const color = RAINBOW_COLORS[i % RAINBOW_COLORS.length];
    dots.push(fg(color, i < filled ? "●" : "○"));
  }
  return dots.join(" ");
}

function fuzzyScore(query: string, text: string): number {
  const lq = query.toLowerCase();
  const lt = text.toLowerCase();
  if (lt.includes(lq)) return 100 + (lq.length / lt.length) * 50;
  let score = 0;
  let qi = 0;
  let consecutive = 0;
  for (let i = 0; i < lt.length && qi < lq.length; i++) {
    if (lt[i] === lq[qi]) {
      score += 10 + consecutive;
      consecutive += 5;
      qi++;
    } else {
      consecutive = 0;
    }
  }
  return qi === lq.length ? score : 0;
}

type ConnectionStatus = "connected" | "idle" | "failed" | "needs-auth" | "connecting";

interface ToolState {
  name: string;
  description: string;
}

interface ServerState {
  name: string;
  expanded: boolean;
  source: "user" | "project" | "import";
  importKind?: string;
  connectionStatus: ConnectionStatus;
  tools: ToolState[];
  hasCachedData: boolean;
}

interface VisibleItem {
  type: "server" | "tool";
  serverIndex: number;
  toolIndex?: number;
}

class McpPanel {
  private servers: ServerState[] = [];
  private cursorIndex = 0;
  private nameQuery = "";
  private descSearchActive = false;
  private descQuery = "";
  private inactivityTimeout: ReturnType<typeof setTimeout> | null = null;
  private visibleItems: VisibleItem[] = [];
  private tui: { requestRender(): void };
  private t = DEFAULT_THEME;

  private static readonly MAX_VISIBLE = 12;
  private static readonly INACTIVITY_MS = 60_000;

  constructor(
    config: McpConfig,
    cache: MetadataCache | null,
    private callbacks: McpPanelCallbacks,
    tui: { requestRender(): void },
    private done: () => void,
  ) {
    this.tui = tui;

    for (const [serverName, definition] of Object.entries(config.mcpServers)) {
      const serverCache = cache?.servers?.[serverName];

      const tools: ToolState[] = [];
      if (serverCache) {
        for (const tool of serverCache.tools ?? []) {
          tools.push({
            name: tool.name,
            description: tool.description ?? "",
          });
        }
      }

      const status = callbacks.getConnectionStatus(serverName);

      this.servers.push({
        name: serverName,
        expanded: false,
        source: "user",
        connectionStatus: status,
        tools,
        hasCachedData: !!serverCache,
      });
    }

    this.rebuildVisibleItems();
    this.resetInactivityTimeout();
  }

  private resetInactivityTimeout(): void {
    if (this.inactivityTimeout) clearTimeout(this.inactivityTimeout);
    this.inactivityTimeout = setTimeout(() => {
      this.cleanup();
      this.done();
    }, McpPanel.INACTIVITY_MS);
  }

  private cleanup(): void {
    if (this.inactivityTimeout) {
      clearTimeout(this.inactivityTimeout);
      this.inactivityTimeout = null;
    }
  }

  private rebuildVisibleItems(): void {
    const query = this.descSearchActive ? this.descQuery : this.nameQuery;
    const mode = this.descSearchActive ? "desc" : "name";

    this.visibleItems = [];
    for (let si = 0; si < this.servers.length; si++) {
      const server = this.servers[si];
      this.visibleItems.push({ type: "server", serverIndex: si });
      if (server.expanded || query) {
        for (let ti = 0; ti < server.tools.length; ti++) {
          const tool = server.tools[ti];
          if (query) {
            const score = mode === "name"
              ? Math.max(
                  fuzzyScore(query, tool.name),
                  fuzzyScore(query, server.name) * 0.6,
                )
              : fuzzyScore(query, tool.description);
            if (score === 0) continue;
          }
          this.visibleItems.push({ type: "tool", serverIndex: si, toolIndex: ti });
        }
      }
    }

    if (query) {
      this.visibleItems = this.visibleItems.filter((item) => {
        if (item.type === "server") {
          return this.visibleItems.some(
            (other) => other.type === "tool" && other.serverIndex === item.serverIndex,
          );
        }
        return true;
      });
    }
  }

  handleInput(data: string): void {
    this.resetInactivityTimeout();

    if (matchesKey(data, "ctrl+c")) {
      this.cleanup();
      this.done();
      return;
    }

    // Modal description search mode
    if (this.descSearchActive) {
      if (matchesKey(data, "escape") || matchesKey(data, "return")) {
        this.descSearchActive = false;
        this.descQuery = "";
        this.rebuildVisibleItems();
        this.cursorIndex = Math.min(this.cursorIndex, Math.max(0, this.visibleItems.length - 1));
        return;
      }
      if (matchesKey(data, "backspace")) {
        if (this.descQuery.length > 0) {
          this.descQuery = this.descQuery.slice(0, -1);
          this.rebuildVisibleItems();
          this.cursorIndex = Math.min(this.cursorIndex, Math.max(0, this.visibleItems.length - 1));
        }
        return;
      }
      if (matchesKey(data, "up")) { this.moveCursor(-1); return; }
      if (matchesKey(data, "down")) { this.moveCursor(1); return; }
      if (data.length === 1 && data.charCodeAt(0) >= 32) {
        this.descQuery += data;
        this.rebuildVisibleItems();
        this.cursorIndex = Math.min(this.cursorIndex, Math.max(0, this.visibleItems.length - 1));
        return;
      }
      return;
    }

    if (matchesKey(data, "escape")) {
      if (this.nameQuery) {
        this.nameQuery = "";
        this.rebuildVisibleItems();
        this.cursorIndex = Math.min(this.cursorIndex, Math.max(0, this.visibleItems.length - 1));
        return;
      }
      this.cleanup();
      this.done();
      return;
    }

    if (matchesKey(data, "up")) { this.moveCursor(-1); return; }
    if (matchesKey(data, "down")) { this.moveCursor(1); return; }

    if (matchesKey(data, "return")) {
      const item = this.visibleItems[this.cursorIndex];
      if (!item) return;
      const server = this.servers[item.serverIndex];
      if (item.type === "server") {
        if (server.connectionStatus === "needs-auth") {
          return;
        }
        server.expanded = !server.expanded;
        this.rebuildVisibleItems();
        this.cursorIndex = Math.min(this.cursorIndex, Math.max(0, this.visibleItems.length - 1));
      }
      return;
    }

    if (matchesKey(data, "ctrl+r")) {
      const item = this.visibleItems[this.cursorIndex];
      if (!item) return;
      const server = this.servers[item.serverIndex];
      if (server.connectionStatus === "connecting") return;
      server.connectionStatus = "connecting";
      this.callbacks.reconnect(server.name).then(() => {
        server.connectionStatus = this.callbacks.getConnectionStatus(server.name);
        if (server.connectionStatus === "connected") {
          const entry = this.callbacks.refreshCacheAfterReconnect(server.name);
          if (entry) {
            this.rebuildServerTools(server, entry);
          }
          server.hasCachedData = true;
        }
        this.tui.requestRender();
      }).catch(() => {
        server.connectionStatus = "failed";
        this.tui.requestRender();
      });
      return;
    }

    if (data === "?") {
      this.descSearchActive = true;
      this.descQuery = "";
      this.rebuildVisibleItems();
      this.cursorIndex = Math.min(this.cursorIndex, Math.max(0, this.visibleItems.length - 1));
      return;
    }

    // Backspace removes from name query
    if (matchesKey(data, "backspace")) {
      if (this.nameQuery.length > 0) {
        this.nameQuery = this.nameQuery.slice(0, -1);
        this.rebuildVisibleItems();
        this.cursorIndex = Math.min(this.cursorIndex, Math.max(0, this.visibleItems.length - 1));
      }
      return;
    }

    // All other printable chars → always-on name search
    if (data.length === 1 && data.charCodeAt(0) >= 32) {
      this.nameQuery += data;
      this.rebuildVisibleItems();
      this.cursorIndex = Math.min(this.cursorIndex, Math.max(0, this.visibleItems.length - 1));
      return;
    }
  }

  private moveCursor(delta: number): void {
    if (this.visibleItems.length === 0) return;
    this.cursorIndex = Math.max(0, Math.min(this.visibleItems.length - 1, this.cursorIndex + delta));
  }

  private rebuildServerTools(server: ServerState, entry: ServerCacheEntry): void {
    const newTools: ToolState[] = [];
    for (const tool of entry.tools ?? []) {
      newTools.push({
        name: tool.name,
        description: tool.description ?? "",
      });
    }
    server.tools = newTools;
    this.rebuildVisibleItems();
  }

  render(width: number): string[] {
    const innerW = width - 2;
    const lines: string[] = [];
    const t = this.t;
    const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
    const italic = (s: string) => `\x1b[3m${s}\x1b[23m`;

    const row = (content: string) =>
      fg(t.border, "│") + truncateToWidth(" " + content, innerW, "…", true) + fg(t.border, "│");
    const emptyRow = () => fg(t.border, "│") + " ".repeat(innerW) + fg(t.border, "│");
    const divider = () => fg(t.border, "├" + "─".repeat(innerW) + "┤");

    const titleText = " MCP Servers ";
    const borderLen = innerW - visibleWidth(titleText);
    const leftB = Math.floor(borderLen / 2);
    const rightB = borderLen - leftB;
    lines.push(fg(t.border, "╭" + "─".repeat(leftB)) + fg(t.title, titleText) + fg(t.border, "─".repeat(rightB) + "╮"));

    lines.push(emptyRow());

    const cursor = fg(t.selected, "│");
    const searchIcon = fg(t.border, "◎");
    if (this.descSearchActive) {
      lines.push(row(`${searchIcon}  ${fg(t.needsAuth, "desc:")} ${this.descQuery}${cursor}`));
    } else if (this.nameQuery) {
      lines.push(row(`${searchIcon}  ${this.nameQuery}${cursor}`));
    } else {
      lines.push(row(`${searchIcon}  ${fg(t.placeholder, italic("search..."))}`));
    }

    lines.push(emptyRow());
    lines.push(divider());

    if (this.servers.length === 0) {
      lines.push(emptyRow());
      lines.push(row(fg(t.hint, italic("No MCP servers configured."))));
      lines.push(emptyRow());
    } else {
      const maxVis = McpPanel.MAX_VISIBLE;
      const total = this.visibleItems.length;
      const startIdx = Math.max(0, Math.min(this.cursorIndex - Math.floor(maxVis / 2), total - maxVis));
      const endIdx = Math.min(startIdx + maxVis, total);

      lines.push(emptyRow());

      for (let i = startIdx; i < endIdx; i++) {
        const item = this.visibleItems[i];
        const isCursor = i === this.cursorIndex;
        const server = this.servers[item.serverIndex];

        if (item.type === "server") {
          lines.push(row(this.renderServerRow(server, isCursor)));
        } else if (item.toolIndex !== undefined) {
          lines.push(row(this.renderToolRow(server.tools[item.toolIndex], isCursor, innerW)));
        }
      }

      lines.push(emptyRow());

      if (total > maxVis) {
        const prog = Math.round(((this.cursorIndex + 1) / total) * 10);
        lines.push(row(`${rainbowProgress(prog, 10)}  ${fg(t.hint, `${this.cursorIndex + 1}/${total}`)}`));
        lines.push(emptyRow());
      }
    }

    lines.push(divider());
    lines.push(emptyRow());

    const toolCount = this.servers.reduce((sum, s) => sum + s.tools.length, 0);
    lines.push(row(fg(t.description, `${toolCount} tools across ${this.servers.length} servers`)));

    lines.push(emptyRow());
    const hints = [
      italic("↑↓") + " navigate",
      italic("⏎") + " expand",
      italic("ctrl+r") + " reconnect",
      italic("?") + " desc search",
      italic("esc") + " close",
      italic("ctrl+c") + " quit",
    ];
    const gap = "  ";
    const gapW = 2;
    const maxW = innerW - 2;
    let curLine = "";
    let curW = 0;
    for (const hint of hints) {
      const hw = visibleWidth(hint);
      const needed = curW === 0 ? hw : gapW + hw;
      if (curW > 0 && curW + needed > maxW) {
        lines.push(row(fg(t.hint, curLine)));
        curLine = hint;
        curW = hw;
      } else {
        curLine += (curW > 0 ? gap : "") + hint;
        curW += needed;
      }
    }
    if (curLine) lines.push(row(fg(t.hint, curLine)));

    lines.push(fg(t.border, "╰" + "─".repeat(innerW) + "╯"));

    return lines;
  }

  private renderServerRow(server: ServerState, isCursor: boolean): string {
    const t = this.t;
    const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;

    const expandIcon = server.expanded ? "▾" : "▸";
    const prefix = isCursor ? fg(t.selected, expandIcon) : fg(t.border, server.expanded ? expandIcon : "·");

    const nameStr = isCursor ? bold(fg(t.selected, server.name)) : server.name;
    const importLabel = server.source === "import" ? fg(t.description, ` (${server.importKind ?? "import"})`) : "";

    let statusIcon = fg(t.description, "○");
    if (server.connectionStatus === "connected") statusIcon = fg(t.selected, "✓");
    else if (server.connectionStatus === "failed") statusIcon = fg(t.needsAuth, "✗");
    else if (server.connectionStatus === "needs-auth") statusIcon = fg(t.needsAuth, "🔑");
    else if (server.connectionStatus === "connecting") statusIcon = fg(t.needsAuth, "⟳");

    let toolInfo = "";
    if (server.tools.length > 0) {
      toolInfo = fg(t.description, `${server.tools.length} tools`);
    } else if (!server.hasCachedData) {
      toolInfo = fg(t.description, "(not cached)");
    }

    return `${prefix} ${statusIcon} ${nameStr}${importLabel}  ${toolInfo}`;
  }

  private renderToolRow(tool: ToolState, isCursor: boolean, innerW: number): string {
    const t = this.t;
    const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;

    const cursor = isCursor ? fg(t.selected, "▸") : " ";
    const nameStr = isCursor ? bold(fg(t.selected, tool.name)) : tool.name;

    const prefixLen = 5 + visibleWidth(tool.name);
    const maxDescLen = Math.max(0, innerW - prefixLen - 8);
    const descStr =
      maxDescLen > 5 && tool.description
        ? fg(t.description, "— " + truncateToWidth(tool.description, maxDescLen, "…"))
        : "";

    return `  ${cursor} ${nameStr} ${descStr}`;
  }

  invalidate(): void {}

  dispose(): void {
    this.cleanup();
  }
}

export function createMcpPanel(
  config: McpConfig,
  cache: MetadataCache | null,
  callbacks: McpPanelCallbacks,
  tui: { requestRender(): void },
  done: () => void,
): McpPanel & { dispose(): void } {
  return new McpPanel(config, cache, callbacks, tui, done);
}
