/**
 * Local MCP server over stdio, for Claude Desktop / Claude Code / any MCP client:
 *   { "command": "npx", "args": ["tsx", "/path/to/shaddai/src/mcp/stdio.ts"] }
 * Reads the same env vars as the web app (BSC_RPC_URLS, SHADDAI_MODE, ...).
 * stdout carries the protocol, so logs go to stderr.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { ShaddaiContext } from '../core/scan.js';
import { createLiveContext, demoContext, loadConfig } from '../server/context.js';
import { createMcpServer } from './server.js';

const cfg = loadConfig();
let live: ShaddaiContext | null = null;
let demo: ShaddaiContext | null = null;

const server = createMcpServer({
  mode: cfg.mode,
  live: () => (live ??= createLiveContext(cfg)),
  demo: () => (demo ??= demoContext()),
});

await server.connect(new StdioServerTransport());
console.error(`Shaddai MCP (${cfg.mode}) ready on stdio.`);
