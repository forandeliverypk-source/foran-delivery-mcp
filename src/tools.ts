/**
 * Foran Delivery MCP Server
 * Copyright (c) 2026 Foran Private Limited. MIT License.
 *
 * Customer-only tools. Everything here uses the same public customer API as
 * the Foran app. There are no admin, store-owner or rider capabilities.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, Ctx, ForanApiError, moduleIdFor, zoneFor } from "./api.js";
import { open, seal, normalizePhone } from "./session.js";
import * as f from "./format.js";
import { registerClaudeTools, quoteDelivery } from "./claude.js";

// ---------------------------------------------------------------- shared inputs
const CITY_POINTS = {
  bahria_town_karachi: { lat: 25.0589, lng: 67.3100, label: "Bahria Town Karachi" },
  hyderabad: { lat: 25.3960, lng: 68.3578, label: "Hyderabad" },
} as const;

const where = {
  city: z.enum(["bahria_town_karachi", "hyderabad"]).optional()
    .describe("Foran service city. Use this OR latitude/longitude. Foran is live only in Bahria Town Karachi and Hyderabad."),
  latitude: z.number().min(-90).max(90).optional().describe("Customer latitude (from foran_find_location or a saved address)."),
  longitude: z.number().min(-180).max(180).optional().describe("Customer longitude."),
  module: z.enum(["mart", "bites"]).default("mart").describe("mart = groceries and daily needs; bites = restaurant food."),
};
const sessionKey = z.string().describe("The session_key returned by foran_login.");

type WhereArgs = { city?: keyof typeof CITY_POINTS; latitude?: number; longitude?: number; module?: "mart" | "bites" };

async function ctxFor(a: WhereArgs, token?: string): Promise<Ctx & { label: string }> {
  let lat = a.latitude, lng = a.longitude, label = "";
  if (lat === undefined || lng === undefined) {
    if (!a.city) throw new Error("Tell me the area first: city = bahria_town_karachi or hyderabad, or exact latitude/longitude (use foran_find_location).");
    ({ lat, lng, label } = CITY_POINTS[a.city]);
  }
  const zone = await zoneFor(lat!, lng!);
  return { zoneIds: zone.zoneIds, moduleId: await moduleIdFor(a.module || "mart"), lat, lng, token, label: label || zone.names.join(", ") };
}

/** Wrap a handler: friendly errors instead of stack traces. */
function safe<A>(fn: (a: A) => Promise<any>) {
  return async (a: A) => {
    try {
      return await fn(a);
    } catch (e: any) {
      if (e instanceof ForanApiError) return f.fail(e.message);
      return f.fail(e?.message || "Something went wrong. Please try again.");
    }
  };
}

const RO = { readOnlyHint: true, openWorldHint: true } as const;

// ---------------------------------------------------------------- static facts
const ABOUT = {
  name: "Foran Delivery (Foran Private Limited)",
  what: "Quick-commerce for groceries, daily needs and restaurant food from trusted local stores (kiryana) — Mart and Bites.",
  live_areas: {
    "Bahria Town Karachi": ["Precinct 2", "Precinct 10", "Precinct 19", "Precinct 27", "Precinct 31", "Precinct 35", "Sports City"],
    Hyderabad: ["Palm Enclaves", "Saima Downtown", "Isra Village", "Qasimabad", "Latifabad", "Saddar", "Cantonment"],
  },
  delivery_time: "Usually within 40 to 60 minutes",
  hours: "9 AM to 3 AM, every day",
  rules: [
    "One store per order (all items in a basket come from the same store).",
    "4% cashback on every delivered order, credited to Foran Money (wallet).",
    "First order: free delivery with promo code FORANDELIVERY (new customers).",
    "Payment: cash on delivery, or Foran Money wallet balance.",
    "Foran Money top-up: send via JazzCash, Easypaisa or NayaPay to 0333-9988891, then WhatsApp the screenshot to the same number.",
    "Not satisfied? Foran returns your payment or gives a refund (see refund policy).",
  ],
  contact: { whatsapp: "+92 333 998 8891", email: "contact@forandelivery.com", website: "https://www.forandelivery.com" },
  apps: {
    android: "https://play.google.com/store/apps/details?id=com.foranuser.userapp",
    ios: "https://apps.apple.com/app/foran-delivery/id6749823888",
  },
  new_customers: "Create an account in the Foran app or on www.forandelivery.com, then log in here with the same phone number and password.",
};

const POLICY_PATHS: Record<string, string> = {
  terms: "/api/v1/terms-and-conditions",
  privacy: "/api/v1/privacy-policy",
  refund: "/api/v1/refund-policy",
  cancellation: "/api/v1/cancelation",
  delivery: "/api/v1/shipping-policy",
  about: "/api/v1/about-us",
};

function stripHtml(s: string): string {
  return String(s || "")
    .replace(/<\/(p|h\d|li|div|br)>/gi, "\n").replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n").trim();
}

// ---------------------------------------------------------------- cart helpers
async function cartList(ctx: Ctx): Promise<any[]> {
  const d = await api.get("/api/v1/customer/cart/list", ctx);
  return Array.isArray(d) ? d : d?.carts || [];
}

function buildVariation(p: any, choices: { group: string; choice: string }[] | undefined, variant: string | undefined) {
  let extra = 0;
  if (Array.isArray(p.food_variations) && p.food_variations.length) {
    const out: any[] = [];
    for (const g of p.food_variations) {
      const picked = (choices || []).filter((c) => c.group.toLowerCase() === String(g.name).toLowerCase());
      const labels: string[] = [];
      for (const c of picked) {
        const v = (g.values || []).find((x: any) => String(x.label).toLowerCase() === c.choice.toLowerCase());
        if (!v) throw new Error(`"${c.choice}" is not an option for "${g.name}". Options: ${(g.values || []).map((x: any) => x.label).join(", ")}`);
        labels.push(v.label);
        extra += Number(v.optionPrice) || 0;
      }
      const required = g.required === "on" || g.required === true;
      if (required && !labels.length) throw new Error(`Please choose "${g.name}": ${(g.values || []).map((x: any) => x.label).join(", ")}`);
      if (labels.length) out.push({ name: g.name, values: { label: labels } });
    }
    return { variation: out, extra, variantPrice: undefined as number | undefined };
  }
  if (Array.isArray(p.variations) && p.variations.length) {
    if (!variant) throw new Error(`Please choose a variant: ${p.variations.map((v: any) => v.type).join(", ")}`);
    const v = p.variations.find((x: any) => String(x.type).toLowerCase() === variant.toLowerCase());
    if (!v) throw new Error(`Variant not found. Options: ${p.variations.map((x: any) => x.type).join(", ")}`);
    return { variation: [{ type: v.type, price: Number(v.price) }], extra: 0, variantPrice: Number(v.price) };
  }
  return { variation: [], extra: 0, variantPrice: undefined as number | undefined };
}

// ---------------------------------------------------------------- registration
export function registerTools(server: McpServer) {
  // ---------- public ----------
  server.registerTool("foran_about", {
    title: "About Foran Delivery",
    description: "Facts about Foran Delivery: live areas, delivery time, hours, cashback, first-order promo, payment options, contact and app links. Call this first when a user asks what Foran is or where it delivers.",
    inputSchema: {},
    annotations: { ...RO, openWorldHint: false },
  }, safe(async () => f.json(ABOUT)));

  server.registerTool("foran_find_location", {
    title: "Find a delivery location",
    description: "Turn an address or area name (e.g. 'Precinct 10 Bahria Town', 'Qasimabad Hyderabad') into coordinates and check whether Foran delivers there.",
    inputSchema: { query: z.string().min(2).describe("Address, area or landmark.") },
    annotations: RO,
  }, safe(async ({ query }: { query: string }) => {
    const d = await api.get("/api/v1/config/place-api-autocomplete", {}, { search_text: query });
    const preds: { id: string; text: string }[] = [];
    for (const s of d?.suggestions || []) if (s.placePrediction) preds.push({ id: s.placePrediction.placeId, text: s.placePrediction.text?.text });
    for (const p of d?.predictions || []) preds.push({ id: p.place_id, text: p.description });
    const out: any[] = [];
    for (const p of preds.slice(0, 4)) {
      try {
        const det = await api.get("/api/v1/config/place-api-details", {}, { placeid: p.id });
        const lat = det?.location?.latitude ?? det?.result?.geometry?.location?.lat;
        const lng = det?.location?.longitude ?? det?.result?.geometry?.location?.lng;
        if (lat === undefined) continue;
        let served: string | false = false;
        try { served = (await zoneFor(lat, lng)).names.join(", "); } catch { served = false; }
        out.push({ place: p.text, latitude: lat, longitude: lng, foran_delivers_here: Boolean(served), zone: served || undefined });
      } catch { /* skip */ }
    }
    if (!out.length) return f.fail("No matching place found. Try a nearby landmark, or use city = bahria_town_karachi / hyderabad.");
    return f.json(out);
  }));

  server.registerTool("foran_search_products", {
    title: "Search products",
    description: "Search Foran's catalogue (groceries in Mart, food in Bites) near the customer. Returns item_id, price in Rs, store, stock and a link. Prices include current discounts.",
    inputSchema: {
      query: z.string().min(1).describe("What to look for, e.g. 'milk', 'basmati rice 5kg', 'zinger burger'."),
      ...where,
      store_id: z.number().int().optional().describe("Only items from this store (customers order from one store at a time)."),
      limit: z.number().int().min(1).max(30).default(10),
    },
    annotations: RO,
  }, safe(async (a: any) => {
    const ctx = await ctxFor(a);
    if (a.store_id) {
      const d = await api.get("/api/v1/items/search", ctx, { name: a.query, store_id: a.store_id, limit: a.limit, offset: 1 });
      const items = (d.products || d.items || []).filter((p: any) => !a.store_id || p.store_id == a.store_id);
      return f.json({ area: ctx.label, total: d.total_size, items: items.map(f.product) });
    }
    const d = await api.get("/api/v1/items/search", ctx, { name: a.query, limit: a.limit, offset: 1 });
    return f.json({ area: ctx.label, total: d.total_size, items: (d.products || []).map(f.product) });
  }));

  server.registerTool("foran_list_stores", {
    title: "List stores near the customer",
    description: "Stores (Mart) or restaurants (Bites) that deliver to the customer's area, with open status, minimum order and distance.",
    inputSchema: { ...where, filter: z.enum(["all", "popular", "latest"]).default("all"), limit: z.number().int().min(1).max(50).default(20) },
    annotations: RO,
  }, safe(async (a: any) => {
    const ctx = await ctxFor(a);
    const path = a.filter === "popular" ? "/api/v1/stores/popular" : a.filter === "latest" ? "/api/v1/stores/latest" : "/api/v1/stores/get-stores/all";
    const d = await api.get(path, ctx, { limit: a.limit, offset: 1, type: "all" });
    const list = Array.isArray(d) ? d : d.stores || [];
    return f.json({ area: ctx.label, total: d.total_size ?? list.length, stores: list.map(f.store) });
  }));

  server.registerTool("foran_store_details", {
    title: "Store details",
    description: "Details of one store plus its popular items.",
    inputSchema: { store_id: z.number().int(), ...where },
    annotations: RO,
  }, safe(async (a: any) => {
    const ctx = await ctxFor(a);
    const s = await api.get(`/api/v1/stores/details/${a.store_id}`, ctx);
    let popular: any[] = [];
    try {
      const p = await api.get(`/api/v1/stores/popular-items/${a.store_id}`, ctx);
      popular = (Array.isArray(p) ? p : p.items || p.products || []).slice(0, 12).map(f.product);
    } catch { /* optional */ }
    return f.json({ ...f.store(s), popular_items: popular });
  }));

  server.registerTool("foran_product_details", {
    title: "Product details",
    description: "Full details of one product, including required options (size, flavour, add-ons) needed before adding it to the cart.",
    inputSchema: { item_id: z.number().int(), ...where },
    annotations: RO,
  }, safe(async (a: any) => {
    const ctx = await ctxFor(a);
    const p = await api.get(`/api/v1/items/details/${a.item_id}`, ctx);
    return f.json(f.productDetail(p));
  }));

  server.registerTool("foran_categories", {
    title: "Browse categories",
    description: "List product categories (e.g. Milk & Dairy, Fruits & Vegetables) or, with category_id, the items inside one category.",
    inputSchema: { ...where, category_id: z.number().int().optional(), limit: z.number().int().min(1).max(30).default(15) },
    annotations: RO,
  }, safe(async (a: any) => {
    const ctx = await ctxFor(a);
    if (a.category_id) {
      const d = await api.get(`/api/v1/categories/items/${a.category_id}`, ctx, { limit: a.limit, offset: 1, type: "all" });
      return f.json({ area: ctx.label, total: d.total_size, items: (d.products || []).map(f.product) });
    }
    const d = await api.get("/api/v1/categories", ctx);
    return f.json((Array.isArray(d) ? d : []).map((c: any) => ({ category_id: c.id, name: c.name, has_subcategories: (c.childes || []).length > 0 })));
  }));

  server.registerTool("foran_policy", {
    title: "Foran policies",
    description: "Read a Foran policy: terms, privacy, refund, cancellation, delivery, or about.",
    inputSchema: { policy: z.enum(["terms", "privacy", "refund", "cancellation", "delivery", "about"]) },
    annotations: { ...RO, openWorldHint: false },
  }, safe(async ({ policy }: { policy: string }) => {
    const d = await api.get(POLICY_PATHS[policy]);
    const text = typeof d === "string" ? d : d?.value ?? d?.data ?? JSON.stringify(d);
    return { content: [{ type: "text" as const, text: stripHtml(text).slice(0, 12000) }] };
  }));

  server.registerTool("foran_track_order", {
    title: "Track an order",
    description: "Status of an order. Logged-in customers pass session_key; guest orders need the phone number used on the order.",
    inputSchema: {
      order_id: z.number().int(),
      session_key: z.string().optional().describe("For orders placed with a Foran account."),
      phone: z.string().optional().describe("For guest orders: the contact phone on the order."),
    },
    annotations: RO,
  }, safe(async (a: any) => {
    const ctx: Ctx = a.session_key ? { token: open(a.session_key).token } : {};
    if (!ctx.token && !a.phone) throw new Error("Pass session_key (account orders) or phone (guest orders).");
    const o = await api.get("/api/v1/customer/order/track", ctx, { order_id: a.order_id, contact_number: a.phone ? normalizePhone(a.phone)[0] : undefined });
    const out: any = { ...f.order(o), rider: o.delivery_man ? { name: [o.delivery_man.f_name, o.delivery_man.l_name].filter(Boolean).join(" ") } : null };
    if (o.delivery_man && ["picked_up", "handover", "confirmed", "accepted"].includes(o.order_status)) {
      try {
        const loc = await api.get("/api/v1/delivery-man/last-location", ctx, { order_id: a.order_id });
        if (loc?.latitude) out.rider_location = { latitude: Number(loc.latitude), longitude: Number(loc.longitude), updated_at: loc.updated_at };
      } catch { /* optional */ }
    }
    return f.json(out);
  }));

  // ---------- ChatGPT-compatible search / fetch ----------
  server.registerTool("search", {
    title: "Search Foran",
    description: "Search Foran products in all live areas (Bahria Town Karachi and Hyderabad). Returns ids usable with fetch.",
    inputSchema: { query: z.string().min(1) },
    annotations: RO,
  }, safe(async ({ query }: { query: string }) => {
    const results: any[] = [];
    for (const city of Object.keys(CITY_POINTS) as (keyof typeof CITY_POINTS)[]) {
      try {
        const ctx = await ctxFor({ city, module: "mart" });
        const d = await api.get("/api/v1/items/search", ctx, { name: query, limit: 8, offset: 1 });
        for (const p of d.products || []) {
          const v = f.product(p);
          results.push({ id: `product:${p.id}:${city}`, title: `${p.name} — Rs ${v.price_rs} (${p.store_name}, ${CITY_POINTS[city].label})`, url: v.link });
        }
      } catch { /* one city failing is fine */ }
    }
    return { content: [{ type: "text" as const, text: JSON.stringify({ results }) }] };
  }));

  server.registerTool("fetch", {
    title: "Fetch a Foran product",
    description: "Fetch full details for an id returned by search (format product:<item_id>:<city>).",
    inputSchema: { id: z.string() },
    annotations: RO,
  }, safe(async ({ id }: { id: string }) => {
    const [, itemId, city] = id.split(":");
    const ctx = await ctxFor({ city: (city as any) in CITY_POINTS ? (city as any) : "bahria_town_karachi", module: "mart" });
    const p = await api.get(`/api/v1/items/details/${Number(itemId)}`, ctx);
    const d = f.productDetail(p);
    const doc = { id, title: p.name, text: JSON.stringify(d, null, 2), url: d.link, metadata: { store: p.store_name, price_rs: d.price_rs } };
    return { content: [{ type: "text" as const, text: JSON.stringify(doc) }] };
  }));

  // ---------- customer account ----------
  server.registerTool("foran_login", {
    title: "Log in as a Foran customer",
    description: "Log in with the customer's own Foran phone number and password (the same as the Foran app). Returns a session_key for cart, order and account tools. Only use credentials the customer typed themselves in this conversation. On a local install, credentials may instead come from FORAN_PHONE / FORAN_PASSWORD environment variables (call with no arguments).",
    inputSchema: {
      phone: z.string().optional().describe("Pakistani mobile, e.g. 03001234567 or +923001234567."),
      password: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, safe(async (a: any) => {
    const phone = a.phone || process.env.FORAN_PHONE;
    const password = a.password || process.env.FORAN_PASSWORD;
    if (!phone || !password) throw new Error("Please share your Foran phone number and password. No account yet? Sign up in the Foran app or on www.forandelivery.com.");
    let last: any;
    for (const p of normalizePhone(phone)) {
      try {
        const d = await api.post("/api/v1/auth/login", {}, { login_type: "manual", field_type: "phone", email_or_phone: p, password });
        if (d?.token) {
          let name: string | undefined;
          try { const info = await api.get("/api/v1/customer/info", { token: d.token }); name = [info.f_name, info.l_name].filter(Boolean).join(" "); } catch { /* ignore */ }
          return f.json({ logged_in: true, name, session_key: seal(d.token, name), note: "Keep using this session_key for this customer. It expires in 7 days." });
        }
        last = new Error("Login failed.");
      } catch (e) { last = e; }
    }
    throw last instanceof ForanApiError ? new ForanApiError(last.status, `Login failed: ${last.message}`) : last;
  }));

  server.registerTool("foran_my_account", {
    title: "My Foran account",
    description: "Customer profile: name, phone, Foran Money (wallet) balance, loyalty points and order count.",
    inputSchema: { session_key: sessionKey },
    annotations: { ...RO, openWorldHint: false },
  }, safe(async (a: any) => {
    const i = await api.get("/api/v1/customer/info", { token: open(a.session_key).token });
    return f.json({
      name: [i.f_name, i.l_name].filter(Boolean).join(" "), phone: i.phone, email: i.email || undefined,
      foran_money_rs: Number(i.wallet_balance) || 0, loyalty_points: Number(i.loyalty_point) || 0, orders: i.order_count,
      referral_code: i.ref_code || undefined,
    });
  }));

  server.registerTool("foran_my_addresses", {
    title: "My saved addresses",
    description: "The customer's saved delivery addresses (address_id is needed to place an order). New addresses are added in the Foran app or website.",
    inputSchema: { session_key: sessionKey },
    annotations: { ...RO, openWorldHint: false },
  }, safe(async (a: any) => {
    const d = await api.get("/api/v1/customer/address/list", { token: open(a.session_key).token }, { limit: 50, offset: 1 });
    const list = (d.addresses || d || []).map(f.address);
    if (!list.length) return f.json({ addresses: [], hint: "No saved address. Add one in the Foran app or on www.forandelivery.com, then try again." });
    return f.json({ addresses: list });
  }));

  server.registerTool("foran_wallet", {
    title: "Foran Money history",
    description: "Recent Foran Money (wallet) transactions: cashback, top-ups and payments.",
    inputSchema: { session_key: sessionKey, limit: z.number().int().min(1).max(50).default(15) },
    annotations: { ...RO, openWorldHint: false },
  }, safe(async (a: any) => {
    const d = await api.get("/api/v1/customer/wallet/transactions", { token: open(a.session_key).token }, { limit: a.limit, offset: 1 });
    return f.json((d.data || []).map((t: any) => ({ date: t.created_at, type: t.transaction_type, credit_rs: Number(t.credit) || 0, debit_rs: Number(t.debit) || 0, balance_rs: Number(t.balance) || 0, ref: t.reference || undefined })));
  }));

  server.registerTool("foran_coupons", {
    title: "Available coupons",
    description: "Coupons the logged-in customer can use (code, discount, minimum order).",
    inputSchema: { session_key: sessionKey, module: where.module },
    annotations: { ...RO, openWorldHint: false },
  }, safe(async (a: any) => {
    const d = await api.get("/api/v1/coupon/list", { token: open(a.session_key).token, moduleId: await moduleIdFor(a.module) });
    return f.json((Array.isArray(d) ? d : d.coupons || []).map((c: any) => ({
      code: c.code, title: c.title, discount: c.discount_type === "percent" ? `${c.discount}%` : `Rs ${c.discount}`,
      type: c.coupon_type, min_order_rs: Number(c.min_purchase) || 0, max_discount_rs: Number(c.max_discount) || undefined, expires: c.expire_date,
    })));
  }));

  // ---------- cart ----------
  server.registerTool("foran_cart_view", {
    title: "View cart",
    description: "Show the customer's current Foran cart for Mart or Bites, with line totals and subtotal.",
    inputSchema: { session_key: sessionKey, module: where.module },
    annotations: { ...RO, openWorldHint: false },
  }, safe(async (a: any) => {
    const ctx: Ctx = { token: open(a.session_key).token, moduleId: await moduleIdFor(a.module) };
    const rows = (await cartList(ctx)).map(f.cartRow);
    const subtotal = Math.round(rows.reduce((s, x) => s + x.line_total_rs, 0) * 100) / 100;
    const stores = [...new Set(rows.map((x) => x.store))];
    return f.json({ module: a.module, items: rows, subtotal_rs: subtotal, stores, note: stores.length > 1 ? "Items from more than one store: Foran delivers one store per order. Remove items from the other store(s) before checkout." : undefined });
  }));

  server.registerTool("foran_cart_add", {
    title: "Add to cart",
    description: "Add a product to the customer's cart. All items in one order must come from the same store. If the product has options, pass them (see foran_product_details).",
    inputSchema: {
      session_key: sessionKey,
      item_id: z.number().int(),
      quantity: z.number().int().min(1).max(50).default(1),
      module: where.module,
      options: z.array(z.object({ group: z.string(), choice: z.string() })).optional().describe("Food options, e.g. [{group:'Size', choice:'Large'}]."),
      variant: z.string().optional().describe("Grocery variant name, if the product has variants."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, safe(async (a: any) => {
    const token = open(a.session_key).token;
    const moduleId = await moduleIdFor(a.module);
    const ctx: Ctx = { token, moduleId };
    const p = await api.get(`/api/v1/items/details/${a.item_id}`, ctx);
    if (p.stock !== undefined && p.stock !== null && Number(p.stock) <= 0) throw new Error(`${p.name} is out of stock right now.`);
    const current = await cartList(ctx);
    const other = current.find((c) => c.item?.store_id && c.item.store_id != p.store_id);
    if (other) throw new Error(`Your cart has items from ${other.item.store_name}. Foran delivers one store per order: clear the cart (foran_cart_remove all=true) or pick this item from ${other.item.store_name}.`);
    const v = buildVariation(p, a.options, a.variant);
    const price = (v.variantPrice ?? Number(p.price)) + v.extra;
    const existing = current.find((c) => c.item_id == a.item_id && JSON.stringify(c.variation || []) === JSON.stringify(v.variation));
    if (existing) {
      await api.post("/api/v1/customer/cart/update", ctx, { cart_id: existing.id, price, quantity: Number(existing.quantity) + a.quantity });
    } else {
      await api.post("/api/v1/customer/cart/add", ctx, { item_id: a.item_id, model: "Item", price, quantity: a.quantity, variation: v.variation, add_on_ids: [], add_on_qtys: [] });
    }
    const rows = (await cartList(ctx)).map(f.cartRow);
    return f.json({ added: `${a.quantity} × ${p.name}`, store: p.store_name, cart: rows, subtotal_rs: Math.round(rows.reduce((s, x) => s + x.line_total_rs, 0) * 100) / 100 });
  }));

  server.registerTool("foran_cart_update", {
    title: "Change quantity in cart",
    description: "Set a new quantity for one cart line (cart_id from foran_cart_view). Quantity 0 removes it.",
    inputSchema: { session_key: sessionKey, cart_id: z.number().int(), quantity: z.number().int().min(0).max(50), module: where.module },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, safe(async (a: any) => {
    const ctx: Ctx = { token: open(a.session_key).token, moduleId: await moduleIdFor(a.module) };
    const row = (await cartList(ctx)).find((c) => c.id == a.cart_id);
    if (!row) throw new Error("That cart line was not found. Call foran_cart_view to see current cart_ids.");
    if (a.quantity === 0) await api.del("/api/v1/customer/cart/remove-item", ctx, { cart_id: a.cart_id });
    else await api.post("/api/v1/customer/cart/update", ctx, { cart_id: a.cart_id, price: Number(row.price), quantity: a.quantity });
    const rows = (await cartList(ctx)).map(f.cartRow);
    return f.json({ cart: rows, subtotal_rs: Math.round(rows.reduce((s, x) => s + x.line_total_rs, 0) * 100) / 100 });
  }));

  server.registerTool("foran_cart_remove", {
    title: "Remove from cart",
    description: "Remove one cart line (cart_id) or empty the whole cart (all=true).",
    inputSchema: { session_key: sessionKey, cart_id: z.number().int().optional(), all: z.boolean().default(false), module: where.module },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, safe(async (a: any) => {
    const ctx: Ctx = { token: open(a.session_key).token, moduleId: await moduleIdFor(a.module) };
    if (a.all) await api.del("/api/v1/customer/cart/remove", ctx);
    else if (a.cart_id) await api.del("/api/v1/customer/cart/remove-item", ctx, { cart_id: a.cart_id });
    else throw new Error("Pass cart_id, or all=true to empty the cart.");
    const rows = (await cartList(ctx)).map(f.cartRow);
    return f.json({ cart: rows });
  }));

  // ---------- orders ----------
  server.registerTool("foran_place_order", {
    title: "Place order",
    description: "Check out the current cart to a saved address. First call WITHOUT confirm to get the order summary and show it to the customer. Only after the customer clearly says yes, call again with confirm=true to place the real order. Payment: cash_on_delivery or wallet (Foran Money). Orders placed here carry the MCP fee (Rs 150) instead of the app's processing fee; always show it in the summary.",
    inputSchema: {
      session_key: sessionKey,
      address_id: z.number().int().describe("From foran_my_addresses."),
      module: where.module,
      payment_method: z.enum(["cash_on_delivery", "wallet"]).default("cash_on_delivery"),
      coupon_code: z.string().optional().describe("e.g. FORANDELIVERY for a new customer's first order."),
      note: z.string().max(500).optional().describe("Note for the store / rider."),
      rider_tip_rs: z.number().int().min(0).max(1000).default(0),
      confirm: z.boolean().default(false).describe("true ONLY after the customer approved the summary."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, safe(async (a: any) => {
    const s = open(a.session_key);
    const moduleId = await moduleIdFor(a.module);
    const base: Ctx = { token: s.token, moduleId };
    const carts = await cartList(base);
    if (!carts.length) throw new Error("The cart is empty. Add items with foran_cart_add first.");
    const storeIds = [...new Set(carts.map((c) => c.item?.store_id).filter(Boolean))];
    if (storeIds.length !== 1) throw new Error("The cart has items from more than one store. Foran delivers one store per order — remove the other store's items first.");
    const storeId = Number(storeIds[0]);

    const addrList = await api.get("/api/v1/customer/address/list", base, { limit: 50, offset: 1 });
    const addr = (addrList.addresses || addrList || []).find((x: any) => x.id == a.address_id);
    if (!addr) throw new Error("Address not found. Call foran_my_addresses and use one of its address_id values.");
    const lat = Number(addr.latitude), lng = Number(addr.longitude);
    const zone = await zoneFor(lat, lng);
    const ctx: Ctx = { ...base, zoneIds: zone.zoneIds, lat, lng };

    const store = await api.get(`/api/v1/stores/details/${storeId}`, ctx);
    const distance = store.distance ? Number(store.distance) / 1000 : f.haversineKm(lat, lng, Number(store.latitude), Number(store.longitude));
    const rows = carts.map(f.cartRow);
    const subtotal = Math.round(rows.reduce((t, x) => t + x.line_total_rs, 0) * 100) / 100;
    if (Number(store.minimum_order) > subtotal) throw new Error(`${store.name} needs a minimum order of Rs ${store.minimum_order}. The cart is Rs ${subtotal}.`);
    if (store.open !== undefined && !Number(store.open)) throw new Error(`${store.name} is closed right now. Try another store or later.`);

    const q = await quoteDelivery(storeId, carts.map((c: any) => ({ item_id: Number(c.item_id), quantity: Number(c.quantity) })), lat, lng);
    const summary = {
      store: store.name,
      deliver_to: f.address(addr).address,
      items: rows.map((x) => `${x.quantity} × ${x.name} — Rs ${x.line_total_rs}`),
      items_subtotal_rs: subtotal,
      delivery_charge_rs: q ? q.delivery_charge_rs : undefined,
      mcp_fee_rs: q ? q.mcp_fee_rs : 150,
      mcp_fee_note: "MCP fee for orders placed through Claude / AI assistants (instead of the app's processing fee).",
      estimated_total_rs: q ? Math.round((subtotal + q.delivery_charge_rs + q.mcp_fee_rs + (a.rider_tip_rs || 0)) * 100) / 100 : undefined,
      delivery: q
        ? `${q.delivery_note ? q.delivery_note + ". " : ""}Distance about ${q.distance_km} km. A coupon (e.g. FORANDELIVERY on a first order) can lower it; Foran confirms the final total when the order is placed.`
        : "Delivery fee, discounts and the final total are calculated by Foran when the order is placed.",
      payment: a.payment_method === "wallet" ? "Foran Money (wallet)" : "Cash on delivery",
      coupon: a.coupon_code || undefined,
      rider_tip_rs: a.rider_tip_rs || undefined,
      estimated_time: store.delivery_time || "40-60 min",
    };
    if (!a.confirm) {
      return f.json({ status: "NOT PLACED YET — show this summary to the customer and ask them to confirm.", summary, next: "If the customer says yes, call foran_place_order again with the same inputs and confirm=true." });
    }

    const body: Record<string, unknown> = {
      order_type: "delivery",
      payment_method: a.payment_method,
      store_id: storeId,
      distance: Math.max(0.1, Math.round(distance * 100) / 100),
      address: addr.address,
      latitude: String(lat),
      longitude: String(lng),
      address_type: addr.address_type || "others",
      contact_person_name: addr.contact_person_name || s.name || "",
      contact_person_number: addr.contact_person_number || "",
      road: addr.road ?? "",
      house: addr.house ?? "",
      floor: addr.floor ?? "",
      order_amount: subtotal,
      order_note: [a.note, "(Placed via Foran AI assistant)"].filter(Boolean).join(" "),
      coupon_code: a.coupon_code || undefined,
      dm_tips: a.rider_tip_rs || 0,
      cutlery: 0,
      partial_payment: 0,
      is_buy_now: 0,
      unavailable_item_note: "",
      delivery_instruction: "",
      extra_packaging_amount: 0,
      create_new_user: 0,
      is_prescription: "false",
      donation_amount: 0,
      gift_packaging: "0",
    };
    const d = await api.post("/api/v1/customer/order/place", { ...ctx, mcp: true }, body);
    const orderId = d.order_id;
    let placed: any = { order_id: orderId, total_rs: d.total_ammount ?? d.total_amount };
    try {
      const o = await api.get("/api/v1/customer/order/track", { token: s.token }, { order_id: orderId });
      placed = f.order(o);
    } catch { /* keep minimal */ }
    return f.json({ status: "ORDER PLACED", ...placed, message: d.message, track_link: `${f.WEB}/track/${orderId}`, cashback: "4% cashback goes to Foran Money after delivery." });
  }));

  server.registerTool("foran_my_orders", {
    title: "My orders",
    description: "The customer's running (active) orders or past order history.",
    inputSchema: { session_key: sessionKey, which: z.enum(["running", "history"]).default("running"), limit: z.number().int().min(1).max(30).default(10) },
    annotations: { ...RO, openWorldHint: false },
  }, safe(async (a: any) => {
    const path = a.which === "running" ? "/api/v1/customer/order/running-orders" : "/api/v1/customer/order/list";
    const d = await api.get(path, { token: open(a.session_key).token }, { limit: a.limit, offset: 1 });
    return f.json({ which: a.which, total: d.total_size, orders: (d.orders || []).map(f.order) });
  }));

  server.registerTool("foran_order_details", {
    title: "Order details",
    description: "Items, prices and status of one of the customer's orders.",
    inputSchema: { session_key: sessionKey, order_id: z.number().int() },
    annotations: { ...RO, openWorldHint: false },
  }, safe(async (a: any) => {
    const ctx: Ctx = { token: open(a.session_key).token };
    const o = await api.get("/api/v1/customer/order/track", ctx, { order_id: a.order_id });
    const det = await api.get("/api/v1/customer/order/details", ctx, { order_id: a.order_id });
    const lines = (Array.isArray(det) ? det : det.details || []).map((x: any) => {
      let item: any = x.item_details;
      if (typeof item === "string") { try { item = JSON.parse(item); } catch { item = {}; } }
      return { name: item?.name, quantity: Number(x.quantity), price_rs: Number(x.price), line_total_rs: Number(x.price) * Number(x.quantity) };
    });
    return f.json({ ...f.order(o), items: lines, delivery_address: o.delivery_address?.address });
  }));

  server.registerTool("foran_cancel_order", {
    title: "Cancel order",
    description: "Cancel an order that the store has not started yet (status pending). Ask the customer to confirm first, then call with confirm=true.",
    inputSchema: { session_key: sessionKey, order_id: z.number().int(), reason: z.string().min(3).max(200), confirm: z.boolean().default(false) },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, safe(async (a: any) => {
    const ctx: Ctx = { token: open(a.session_key).token };
    const o = await api.get("/api/v1/customer/order/track", ctx, { order_id: a.order_id });
    if (!["pending", "confirmed"].includes(o.order_status)) {
      throw new Error(`Order ${a.order_id} is "${o.order_status}" and can't be cancelled here. Please WhatsApp Foran on +92 333 998 8891.`);
    }
    if (!a.confirm) return f.json({ status: "NOT CANCELLED YET — ask the customer to confirm.", order: f.order(o), reason: a.reason });
    const d = await api.put("/api/v1/customer/order/cancel", ctx, { order_id: a.order_id, reason: a.reason, _method: "put" });
    return f.json({ status: "CANCELLED", order_id: a.order_id, message: d?.message });
  }));

  registerClaudeTools(server);
}
