# Foran Delivery MCP

**Order groceries and food from [Foran Delivery](https://www.forandelivery.com) inside Claude, ChatGPT and any AI assistant that speaks the [Model Context Protocol](https://modelcontextprotocol.io).**

Foran Delivery is a quick-commerce service for groceries (**Mart**) and restaurant food (**Bites**) from trusted local stores. It is live in **Bahria Town Karachi** and **Hyderabad**, Pakistan. Delivery usually takes 40 to 60 minutes.

This is the official customer MCP server. It uses the same customer API as the Foran app and website, so prices, stock, stores and orders are live. It is built for customers. The only extra is a small set of Foran-team tools (custom orders and order status for any customer), locked behind a staff key; there is no admin-panel, store-owner or rider access.

```
Hosted endpoint:  https://mcp.forandelivery.com/mcp   (Streamable HTTP, no install needed)
```

---

## What you can ask

> "What's Foran's delivery time in Bahria Town?"
> "Find Milkpak 1L and eggs near Precinct 10."
> "Which stores in Hyderabad are open right now?"
> "Log me in, add 2 Milkpak 1L and a dozen eggs from Foran Bazar, and deliver to my Home address — cash on delivery."
> "Where is my order 102584?"
> "Here's a photo of my list: Panadol, 2 kg milk, a dozen eggs. Order it to House 29, Precinct 10A."

The assistant always shows the order summary first and only places the order after you say **yes**.

## Fees

Orders placed through this MCP server (Claude, ChatGPT or any AI assistant) carry an **MCP fee of Rs 150**, shown in the order summary before you confirm. It replaces the processing fee charged in the Foran app. Delivery charge, store minimum order and Foran's free-delivery rules apply as usual.

## Tools

| Tool | Login | What it does |
|---|---|---|
| `foran_about` | – | Live areas, hours, delivery time, cashback, first-order promo, contact, app links |
| `foran_find_location` | – | Turn an address or area into coordinates and check delivery coverage |
| `foran_search_products` | – | Search Mart or Bites items near you (price in Rs, stock, store, link) |
| `foran_list_stores` | – | Stores / restaurants that deliver to you: open now, minimum order, distance |
| `foran_store_details` | – | One store plus its popular items |
| `foran_product_details` | – | Full product info, including options needed before adding to cart |
| `foran_categories` | – | Browse categories or the items in one category |
| `foran_policy` | – | Terms, privacy, refund, cancellation, delivery policies |
| `foran_track_order` | optional | Order status and rider position |
| `search` / `fetch` | – | ChatGPT-compatible catalogue search and document fetch |
| `foran_login` | – | Log in with your Foran phone + password, returns a `session_key` |
| `foran_my_account` | ✔ | Name, Foran Money balance, loyalty points |
| `foran_my_addresses` | ✔ | Saved delivery addresses |
| `foran_wallet` | ✔ | Foran Money transactions (cashback, top-ups, payments) |
| `foran_coupons` | ✔ | Coupons you can use |
| `foran_cart_view` / `_add` / `_update` / `_remove` | ✔ | Manage your cart (one store per order) |
| `foran_place_order` | ✔ | Summary first, then place the order with `confirm=true` (cash on delivery or Foran Money) |
| `foran_my_orders` / `foran_order_details` | ✔ | Running orders and history |
| `foran_cancel_order` | ✔ | Cancel a pending order (with confirmation) |
| `foran_buying_guide` | – | How to buy from Foran: one-store rule, delivery charges, free delivery, payment, Foran Money, cashback, refunds |
| `foran_custom_order` | ✔ or staff | **Claude order**: order from a shopping list, product names or photos, mixing catalogue items with custom items (estimated price, confirmed by the Foran team). Quote first, then `confirm=true` |
| `foran_order_status` | ✔ or staff | Live order stage, timeline, rider, items and total |
| `foran_staff_login` | – | Foran team only: unlocks custom orders and status for any customer (e.g. WhatsApp orders) |

## Connect it

### Claude (claude.ai, Claude Desktop, mobile)
1. **Settings → Connectors → Add custom connector**.
2. Name: `Foran Delivery`, URL: `https://mcp.forandelivery.com/mcp`.
3. Turn it on in a chat from the tools menu.

### Claude Code
```bash
claude mcp add --transport http foran-delivery https://mcp.forandelivery.com/mcp
```

### ChatGPT
1. **Settings → Apps & Connectors → Advanced settings →** turn on **Developer mode**.
2. **Create** a connector: name `Foran Delivery`, MCP server URL `https://mcp.forandelivery.com/mcp`, authentication **No authentication** (you log in to Foran inside the chat).
3. In a chat, choose **Developer mode** and enable Foran Delivery.

ChatGPT deep research can use the read-only `search` and `fetch` tools.

### Cursor, Windsurf, VS Code and other clients
Add a remote MCP server with the URL `https://mcp.forandelivery.com/mcp` (transport: Streamable HTTP).

### Run it locally (stdio)
Requires Node.js 20+.
```bash
git clone https://github.com/forandeliverypk-source/foran-delivery-mcp.git
cd foran-delivery-mcp && npm install && npm run build
```
Claude Desktop `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "foran-delivery": {
      "command": "node",
      "args": ["/absolute/path/to/foran-delivery-mcp/dist/index.js"],
      "env": { "FORAN_PHONE": "03001234567", "FORAN_PASSWORD": "your-password" }
    }
  }
}
```
`FORAN_PHONE` / `FORAN_PASSWORD` are optional. They let `foran_login` work without typing your password into the chat.

## Accounts, privacy and safety

- **Create your account** in the Foran app ([Android](https://play.google.com/store/apps/details?id=com.foranuser.userapp) · [iOS](https://apps.apple.com/app/foran-delivery/id6749823888)) or on [forandelivery.com](https://www.forandelivery.com). Add your delivery address there too.
- **Login.** Your password goes only to Foran's own API. It is never stored. You get an encrypted `session_key` (AES-256-GCM) that expires after 7 days. The server keeps no database and does not log your requests or credentials. Note that anything you type in a chat is also visible to your AI provider. Prefer the local `FORAN_PHONE`/`FORAN_PASSWORD` setup if you don't want to type your password into a chat.
- **No surprise orders.** `foran_place_order` and `foran_cancel_order` do nothing until called again with `confirm=true` after you approve the summary.
- **Customer only.** No store, rider or admin endpoints are included.
- Store owners' contact details are never passed to the AI.

## Good to know
- One store per order: everything in a basket comes from the same store.
- 4% cashback to Foran Money on every delivered order. New customers get free delivery on their first order with code `FORANDELIVERY`.
- Payment: cash on delivery, or Foran Money. To top up Foran Money, send JazzCash, Easypaisa or NayaPay to 0333-9988891, then WhatsApp the screenshot to the same number.
- Support: WhatsApp **+92 333 998 8891** · contact@forandelivery.com

## Self-hosting (HTTP)
```bash
cp .env.example .env     # set FORAN_MCP_SECRET to 32+ random characters
npm install && npm run build
node dist/index.js --http   # → http://127.0.0.1:8095/mcp , health: /health
```
A hardened systemd unit is in [`deploy/foran-mcp.service`](deploy/foran-mcp.service). Put it behind HTTPS (for example Cloudflare Tunnel or nginx).

Smoke test (public tools only): `node test/smoke.mjs` (stdio) or `node test/smoke.mjs http://127.0.0.1:8095/mcp`.

## License
MIT © 2026 Foran Private Limited. "Foran" and "Foran Delivery" are trademarks of Foran Private Limited.
