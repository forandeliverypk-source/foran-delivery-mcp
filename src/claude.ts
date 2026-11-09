/**
 * Foran Delivery MCP Server
 * Copyright (c) 2026 Foran Private Limited. MIT License.
 *
 * Claude orders: custom orders made from what a customer sends (product names,
 * shopping lists, photos). Mixes catalogue items and free-text custom items with
 * an estimated price. Saved in the Foran admin panel as a PENDING order with
 * source "Claude order", so the team confirms prices and dispatches it.
 *
 * Two ways in:
 *   - a logged-in customer (session_key from foran_login): the order goes on their account;
 *   - Foran staff (staff_session from foran_staff_login): order for any customer, e.g. from WhatsApp.
 * Plus live order status and a buying guide.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, API_BASE, ForanApiError } from "./api.js";
import { open, seal } from "./session.js";
import * as f from "./format.js";

const CLAUDE_KEY = process.env.FORAN_CLAUDE_KEY || "";
const STAFF_KEY = process.env.FORAN_STAFF_KEY || "";
const STAFF_TOKEN = "foran-staff";
const TIMEOUT_MS = 30000;

/** call the private Claude-order endpoints of the Foran admin API */
async function claudeApi(method: "GET" | "POST", path: string, body?: Record<string, unknown>, query?: Record<string, unknown>): Promise<any> {
  if (CLAUDE_KEY.length < 32) throw new Error("Claude orders are not switched on for this server yet (FORAN_CLAUDE_KEY missing).");
  const url = new URL(API_BASE + path);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: { Accept: "application/json", "Content-Type": "application/json", "X-Foran-Claude-Key": CLAUDE_KEY, "User-Agent": "foran-delivery-mcp/1.1" },
      body: body ? JSON.stringify(body) : undefined,
      signal: ac.signal,
    });
  } catch (e: any) {
    throw new ForanApiError(0, `Could not reach Foran (${e?.name === "AbortError" ? "timeout" : "network error"}). Please try again.`);
  } finally {
    clearTimeout(t);
  }
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok || !data?.ok) {
    const msg = data?.errors?.map((e: any) => e.message).join("; ") || `Foran API error (HTTP ${res.status}).`;
    throw new ForanApiError(res.status, msg);
  }
  return data;
}

/** Delivery charge + total for a cart, exactly as the Foran team's order screen will show it. Never throws. */
export async function quoteDelivery(storeId: number, lines: { item_id: number; quantity: number }[], lat: number, lng: number): Promise<any | null> {
  if (CLAUDE_KEY.length < 32 || !lines.length) return null;
  try {
    const d = await claudeApi("POST", "/api/v1/foran/claude-order", {
      store_id: storeId, customer_name: "Quote", customer_phone: "03000000000", address: "quote",
      latitude: lat, longitude: lng, items: lines, confirm: false,
    });
    return d.quote;
  } catch { return null; }
}

function isStaff(staffSession?: string): boolean {
  if (!staffSession) return false;
  try { return open(staffSession).token === STAFF_TOKEN; } catch { return false; }
}

function safe<A>(fn: (a: A) => Promise<any>) {
  return async (a: A) => {
    try { return await fn(a); } catch (e: any) { return f.fail(e?.message || "Something went wrong. Please try again."); }
  };
}

// ---------------------------------------------------------------- buying guide
const GUIDE = {
  how_to_order: [
    "1. Tell us your area: Bahria Town Karachi (Precincts 2, 10, 19, 27, 31, 35, Sports City) or Hyderabad (Palm Enclaves, Saima Downtown, Isra Village, Qasimabad, Latifabad, Saddar, Cantonment).",
    "2. Pick a store near you. One order = one store, so all items in a basket come from the same store. A store has groceries, dairy, meat, fruit & veg, household and often pharmacy items together.",
    "3. Add items in the Foran app, on www.forandelivery.com, through Claude, or just send your list / photos on WhatsApp +92 333 998 8891.",
    "4. Check the summary (items, delivery charge, total) and confirm. Pay cash on delivery or with Foran Money.",
    "5. Track the order live; the Foran Rider calls when nearby. Delivery is usually 40-60 minutes.",
  ],
  can_i_order_things_not_in_the_app: "Yes. Send the product name or a photo. Foran makes a custom order, buys it from a nearby store and confirms the final price with you before delivery.",
  delivery_charge: "Depends on the store and distance (shown before you confirm). Groceries (Mart) start from Rs 195 in Bahria Town Karachi and Rs 150 in Hyderabad. First order: free delivery with code FORANDELIVERY. Orders of Rs 2,999 or more (items) get free delivery.",
  mcp_fee: "Orders placed through Claude or another AI assistant (the Foran MCP) have an MCP fee of Rs 150, shown in the summary before you confirm. It replaces the processing fee charged in the Foran app.",
  minimum_order: "Each store has a small minimum order (about Rs 300-550), shown on the store page.",
  payment: ["Cash on delivery", "Foran Money (wallet): top up by sending JazzCash / Easypaisa / NayaPay to 0333-9988891 and WhatsApp the screenshot to the same number."],
  rewards: "4% cashback in Foran Money on every delivered order from Foran stores.",
  hours: "9 AM to 3 AM, every day (each store has its own hours).",
  fresh_and_loose_items: "Loose items (milk, yogurt, vegetables, meat) are sold by weight or litre; 1 kg of milk is about 1 litre. Ask if you want a packaged brand instead (Milkpak, Olper's, Dayfresh...).",
  changes_and_cancellation: "You can cancel or change an order until the store starts packing it. Contact WhatsApp +92 333 998 8891.",
  refunds: "Wrong, missing, damaged or expired item? Tell Foran within 24 hours (a photo helps); Foran returns the payment or gives a refund (see foran_policy refund).",
  tips_for_customers: [
    "Share a map pin or exact house / street / precinct so the rider finds you fast.",
    "Keep your phone on: the rider calls on arrival.",
    "For cash on delivery, keep change ready.",
    "Big monthly ration? Order Rs 2,999+ from one store for free delivery.",
  ],
  contact: { whatsapp: "+92 333 998 8891", email: "contact@forandelivery.com", website: "https://www.forandelivery.com" },
};

const STATUS_HELP: Record<string, string> = {
  pending: "Received. Waiting for the store to confirm (usually a few minutes).",
  confirmed: "The store confirmed the order.",
  accepted: "A Foran Rider has been assigned.",
  processing: "The store is packing the order.",
  handover: "Packed and handed to the rider.",
  picked_up: "On the way to the customer.",
  delivered: "Delivered. On Foran stores, 4% cashback goes to Foran Money.",
  canceled: "Cancelled.",
  failed: "Delivery failed. Foran will contact the customer.",
};

export function registerClaudeTools(server: McpServer) {
  server.registerTool("foran_buying_guide", {
    title: "How to buy from Foran",
    description: "Practical guide to buying from Foran Delivery: how ordering works, one-store rule, delivery charges, free delivery, minimum order, payment, Foran Money top-up, cashback, custom orders from photos/lists, cancellation and refunds. Use it whenever a customer asks how Foran works or how to order.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, safe(async () => f.json(GUIDE)));

  server.registerTool("foran_staff_login", {
    title: "Foran staff login",
    description: "For the Foran team only. Unlock staff tools (custom orders for any customer, e.g. from WhatsApp, and order status for any order) with the Foran staff key. Returns a staff_session valid for 7 days. Only use a key the user typed in this conversation.",
    inputSchema: { staff_key: z.string().min(8) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, safe(async (a: any) => {
    if (STAFF_KEY.length < 12) throw new Error("Staff access is not set up on this server.");
    const ok = a.staff_key.length === STAFF_KEY.length && (await import("node:crypto")).timingSafeEqual(Buffer.from(a.staff_key), Buffer.from(STAFF_KEY));
    if (!ok) throw new Error("Wrong staff key.");
    return f.json({ staff: true, staff_session: seal(STAFF_TOKEN, "Foran staff"), note: "Pass staff_session to foran_custom_order and foran_order_status." });
  }));

  const itemSchema = z.object({
    item_id: z.number().int().optional().describe("Catalogue item_id from foran_search_products (must be from the chosen store). Omit for a custom item."),
    name: z.string().max(150).optional().describe("For custom items: what the customer asked for, e.g. 'Panadol Extra 10 tablets', 'Lays Masala large'."),
    quantity: z.number().min(0.01).max(500).describe("How many. Custom items may use decimals with unit, e.g. 2.5 + unit 'kg'."),
    unit: z.string().max(30).optional().describe("Custom items: kg, litre, dozen, pack…"),
    estimated_price_rs: z.number().min(0).max(500000).optional().describe("Custom items: your honest estimate of the price PER unit in Rs (Pakistan retail). Required for custom items. It is marked as an estimate; the Foran team confirms it."),
    note: z.string().max(300).optional().describe("Brand, size, colour, 'same as photo', substitutes allowed…"),
    variant: z.string().max(100).optional().describe("Catalogue grocery variant name, if the product has variants."),
    image_index: z.number().int().min(0).max(9).optional().describe("Which of `images` shows this item (0-based)."),
  });

  server.registerTool("foran_custom_order", {
    title: "Custom order (Claude order)",
    description: "Create a Foran order from what the customer sent: product names, a shopping list, or photos. Mix catalogue items (item_id) with custom items that are not in the app (name + estimated_price_rs). All items must be bought from ONE store: pick the nearest open store that has most items (foran_list_stores / foran_search_products). The order lands in the Foran admin panel as a pending 'Claude order' with the photos attached; the team confirms custom prices before dispatch.\n" +
      "Who can use it: a logged-in customer (session_key; the order goes on their account) or Foran staff (staff_session; any customer name + phone, e.g. a WhatsApp customer).\n" +
      "ALWAYS call first WITHOUT confirm: it returns the quote (items, delivery charge, MCP fee Rs 150, total, warnings). Show it to the user, and only after a clear yes call again with the same inputs and confirm=true. Cash on delivery.",
    inputSchema: {
      session_key: z.string().optional().describe("Customer mode: session_key from foran_login."),
      staff_session: z.string().optional().describe("Staff mode: staff_session from foran_staff_login."),
      store_id: z.number().int().describe("The one store to buy from."),
      customer_name: z.string().max(100).optional().describe("Staff mode: customer's name (e.g. WhatsApp profile name)."),
      customer_phone: z.string().max(20).optional().describe("Staff mode: customer's mobile, e.g. 03001234567."),
      address: z.string().min(3).max(500).describe("Full delivery address as given: house, street, precinct/area, city."),
      house: z.string().max(100).optional(),
      road: z.string().max(150).optional().describe("Street / lane / block."),
      latitude: z.number().min(-90).max(90).optional().describe("Map pin (from foran_find_location or a shared WhatsApp location). Without it the minimum delivery charge is used and the team confirms the address."),
      longitude: z.number().min(-180).max(180).optional(),
      address_id: z.number().int().optional().describe("Customer mode: a saved address_id from foran_my_addresses (fills address + pin)."),
      items: z.array(itemSchema).min(1).max(60),
      images: z.array(z.object({
        url: z.string().url().optional().describe("Public https link to the photo."),
        base64: z.string().optional().describe("Image file as base64 (jpg/png/webp, max ~6 MB)."),
      })).max(10).optional().describe("Photos the customer sent (product photos, a handwritten list, a prescription)."),
      note: z.string().max(1000).optional().describe("Anything else for the team / rider."),
      channel: z.string().max(40).optional().describe("Where the request came from, e.g. 'WhatsApp', 'Claude chat', 'Instagram DM'."),
      confirm: z.boolean().default(false).describe("true ONLY after the user approved the quote."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, safe(async (a: any) => {
    const staff = isStaff(a.staff_session);
    let name = a.customer_name, phone = a.customer_phone, userId: number | undefined;
    let address = a.address, house = a.house, road = a.road, lat = a.latitude, lng = a.longitude;
    if (!staff) {
      if (!a.session_key) throw new Error("Log in first: the customer uses foran_login (session_key), or Foran staff use foran_staff_login (staff_session).");
      const token = open(a.session_key).token;
      if (token === STAFF_TOKEN) throw new Error("Pass the staff session as staff_session, not session_key.");
      const info = await api.get("/api/v1/customer/info", { token });
      userId = info.id;
      name = [info.f_name, info.l_name].filter(Boolean).join(" ") || name;
      phone = info.phone || phone;
      if (a.address_id) {
        const list = await api.get("/api/v1/customer/address/list", { token }, { limit: 50, offset: 1 });
        const ad = (list.addresses || list || []).find((x: any) => x.id == a.address_id);
        if (!ad) throw new Error("Address not found. Use an address_id from foran_my_addresses.");
        address = ad.address; house = ad.house || house; road = ad.road || road;
        lat = Number(ad.latitude); lng = Number(ad.longitude);
        if (ad.contact_person_number) phone = ad.contact_person_number;
      }
    }
    if (!name || !phone) throw new Error("Customer name and phone number are needed.");
    for (const it of a.items) {
      if (!it.item_id && (!it.name || it.estimated_price_rs === undefined)) {
        throw new Error(`Custom item "${it.name || "?"}" needs a name and estimated_price_rs.`);
      }
    }
    const body = {
      store_id: a.store_id, customer_name: name, customer_phone: phone, customer_user_id: userId,
      address, house, road, latitude: lat, longitude: lng,
      items: a.items.map((it: any) => ({
        item_id: it.item_id, name: it.name, quantity: it.quantity, unit: it.unit,
        price: it.item_id ? undefined : it.estimated_price_rs, note: it.note, variant: it.variant, image_index: it.image_index,
      })),
      images: a.images, note: a.note,
      channel: a.channel || (staff ? "Foran team" : "Claude chat"),
      placed_by: staff ? "Foran staff via Claude" : "customer via Claude",
      confirm: Boolean(a.confirm),
    };
    const d = await claudeApi("POST", "/api/v1/foran/claude-order", body);
    if (!d.placed) {
      return f.json({ status: "NOT PLACED YET — show this quote and ask to confirm.", quote: d.quote, photos_attached: (a.images || []).length, next: "If the user says yes, call foran_custom_order again with the same inputs and confirm=true." });
    }
    return f.json({
      status: "ORDER PLACED (Claude order, pending confirmation by the Foran team)",
      order_id: d.order_id, ...(staff ? { admin_link: d.admin_link } : {}),
      quote: d.quote, photos_attached: d.quote?.attachments_saved ?? 0,
      track_link: `${f.WEB}/track/${d.order_id}`,
      next_steps: "Foran confirms custom prices and the store, then a rider delivers in about 40-60 minutes. Ask for status any time with the order number.",
    });
  }));

  server.registerTool("foran_order_status", {
    title: "Live order status",
    description: "Real-time status of a Foran order: stage with plain-language meaning, timeline, store, rider name and phone, items, delivery charge, total and payment. Customers: pass session_key (only their own orders). Staff: pass staff_session plus order_id or the customer's phone (latest 5 orders). Use this whenever someone asks 'where is my order?'.",
    inputSchema: {
      order_id: z.number().int().optional(),
      phone: z.string().optional().describe("Staff only: customer's mobile to list their latest orders."),
      session_key: z.string().optional(),
      staff_session: z.string().optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, safe(async (a: any) => {
    const staff = isStaff(a.staff_session);
    if (!staff) {
      if (!a.session_key) throw new Error("Customers: log in with foran_login (or use foran_track_order with order_id + phone). Staff: foran_staff_login.");
      if (!a.order_id) throw new Error("Which order number?");
      const token = open(a.session_key).token;
      // proves the order belongs to this customer before showing staff-level detail
      await api.get("/api/v1/customer/order/track", { token }, { order_id: a.order_id });
    }
    if (!a.order_id && !a.phone) throw new Error("Pass order_id or phone.");
    const d = await claudeApi("GET", "/api/v1/foran/claude-order/status", undefined, { order_id: a.order_id, phone: staff ? a.phone : undefined });
    const orders = (d.orders || []).map((o: any) => ({
      ...o,
      what_it_means: STATUS_HELP[o.status] || o.status_text,
      rider: o.rider ? (staff ? o.rider : { name: o.rider.name, phone: o.rider.phone }) : "Not assigned yet",
    }));
    return f.json(orders.length === 1 ? orders[0] : { orders });
  }));
}
