#!/usr/bin/env node
import { serve } from "@hono/node-server";
import app from "./index.js";

// Node / VPS fallback entry. Cloudflare Workers uses `src/index.ts` (default export) directly.
const port = Number(process.env.PORT ?? 8787);

serve({ fetch: app.fetch, port }, (info) => {
  console.error(`x402-json-repair-mcp listening on http://localhost:${info.port}  (MCP: POST /mcp)`);
});
