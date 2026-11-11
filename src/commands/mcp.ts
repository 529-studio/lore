import { runMcpServer } from '../mcp/server.js';

/** lore mcp — JSON-RPC MCP server over stdio. stdout = protocol, stderr = logs. */
export function mcpCommand(): void {
  // no db access here: the server resolves the repo lazily per tool call
  runMcpServer();
}
