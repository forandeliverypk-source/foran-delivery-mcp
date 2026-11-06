#!/usr/bin/env node
/**
 * Foran Delivery MCP Server
 * Copyright (c) 2026 Foran Private Limited. MIT License.
 *
 *   stdio (Claude Desktop, Claude Code, Cursor …):  npx foran-delivery-mcp
 *   HTTP  (ChatGPT, Claude.ai connectors …):         npx foran-delivery-mcp --http   → POST /mcp
 */
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerTools } from "./tools.js";

export const VERSION = "1.1.0";

const INSTRUCTIONS = `Foran Delivery is a quick-commerce service for groceries (Mart) and restaurant food (Bites) from local stores, live in Bahria Town Karachi and Hyderabad, Pakistan. Prices are in Pakistani Rupees (Rs).
How to help a customer:
1. Ask which area they are in (city = bahria_town_karachi or hyderabad, or use foran_find_location).
2. Use foran_search_products / foran_list_stores / foran_categories to find items. One order = one store, so keep a basket to a single store.
3. To order, the customer logs in with foran_login (their own Foran phone + password). Use the returned session_key for cart and order tools.
4. Add items with foran_cart_add, pick a saved address with foran_my_addresses, then call foran_place_order WITHOUT confirm, show the summary, and only after the customer says yes call it again with confirm=true.
5. Customer sends a list, product names or photos (even items not in the app)? Use foran_custom_order: one store, catalogue items by item_id, other items by name with an honest estimated_price_rs; quote first, confirm=true only after a yes. It lands in the Foran admin as a "Claude order". Foran staff log in with foran_staff_login to order for WhatsApp customers.
6. "Where is my order?" → foran_order_status (live stage, timeline, rider) or foran_track_order (order_id + phone). How Foran works / how to buy → foran_buying_guide.
Never invent prices, stock or delivery promises; delivery is usually 40-60 minutes. Foran gives 4% cashback to Foran Money on every delivered order, and new customers get free delivery on their first order with code FORANDELIVERY. Support: WhatsApp +92 333 998 8891.`;

export function buildServer(): McpServer {
  const server = new McpServer(
    { name: "foran-delivery", title: "Foran Delivery", version: VERSION, websiteUrl: "https://www.forandelivery.com" } as any,
    { instructions: INSTRUCTIONS },
  );
  registerTools(server);
  return server;
}

async function runStdio() {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
  console.error(`Foran Delivery MCP ${VERSION} running on stdio`);
}

async function runHttp() {
  const port = Number(process.env.PORT || 8095);
  const host = process.env.HOST || "127.0.0.1";
  const allowedHosts = (process.env.ALLOWED_HOSTS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!process.env.FORAN_MCP_SECRET || process.env.FORAN_MCP_SECRET.length < 32) {
    console.error("WARNING: set FORAN_MCP_SECRET (32+ chars) so customer sessions survive restarts.");
  }

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "20mb" })); // photos for custom orders

  // Host header allow-list (DNS-rebinding protection) when configured.
  app.use((req, res, next) => {
    if (!allowedHosts.length) return next();
    const h = String(req.headers.host || "").split(":")[0].toLowerCase();
    if (allowedHosts.includes(h) || h === "127.0.0.1" || h === "localhost") return next();
    res.status(403).json({ error: "Host not allowed" });
  });

  // CORS for browser-based MCP clients / inspectors.
  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  // Simple per-IP rate limit (120 requests / minute).
  const hits = new Map<string, { n: number; t: number }>();
  app.use("/mcp", (req, res, next) => {
    const ip = String(req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim();
    const now = Date.now();
    const h = hits.get(ip);
    if (!h || now - h.t > 60_000) hits.set(ip, { n: 1, t: now });
    else if (++h.n > 120) return res.status(429).json({ error: "Too many requests, slow down." });
    if (hits.size > 50_000) hits.clear();
    next();
  });

  app.get("/", (_req, res) => {
    res.type("html").send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Foran Delivery MCP</title><style>body{font-family:system-ui,sans-serif;max-width:640px;margin:48px auto;padding:0 16px;color:#16181d;line-height:1.55}code{background:#f5f6f8;padding:2px 6px;border-radius:6px}h1{color:#D21E24}</style>
<h1>Foran Delivery MCP</h1><p>Order groceries and food from Foran Delivery (Bahria Town Karachi &amp; Hyderabad) inside Claude, ChatGPT and other AI assistants.</p>
<p>MCP endpoint: <code>https://${String(_req.headers.host || "mcp.forandelivery.com")}/mcp</code> (Streamable HTTP)</p>
<p>Setup guide &amp; source: <a href="https://github.com/forandeliverypk-source/foran-delivery-mcp">github.com/forandeliverypk-source/foran-delivery-mcp</a> · <a href="https://www.forandelivery.com">forandelivery.com</a></p>`);
  });
  app.get("/health", (_req, res) => res.json({ ok: true, name: "foran-delivery-mcp", version: VERSION }));

  // Stateless Streamable HTTP: a fresh server per request. Customer state lives in the encrypted session_key.
  app.post("/mcp", async (req, res) => {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { transport.close(); server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error("mcp error", e);
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  });
  const notAllowed = (_req: express.Request, res: express.Response) =>
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server: use POST /mcp)." }, id: null });
  app.get("/mcp", notAllowed);
  app.delete("/mcp", notAllowed);

  app.listen(port, host, () => console.error(`Foran Delivery MCP ${VERSION} listening on http://${host}:${port}/mcp`));
}

const useHttp = process.argv.includes("--http") || process.env.MCP_TRANSPORT === "http";
(useHttp ? runHttp() : runStdio()).catch((e) => {
  console.error(e);
  process.exit(1);
});
