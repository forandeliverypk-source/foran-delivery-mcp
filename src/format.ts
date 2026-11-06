/**
 * Foran Delivery MCP Server
 * Copyright (c) 2026 Foran Private Limited. MIT License.
 *
 * Small, privacy-safe views of API objects. Only fields a customer needs are
 * passed to the AI model (no store owner emails, no internal ids beyond what
 * the tools need).
 */

export const WEB = "https://www.forandelivery.com";

const r = (n: number) => Math.round(n * 100) / 100;

export function finalPrice(p: any): number {
  const price = Number(p.price) || 0;
  const disc = Number(p.discount) || 0;
  if (!disc) return price;
  return r(p.discount_type === "amount" ? Math.max(0, price - disc) : price * (1 - disc / 100));
}

export function product(p: any) {
  const final = finalPrice(p);
  const out = {
    item_id: p.id,
    name: p.name,
    unit: p.unit_type || p.unit?.unit || undefined,
    price_rs: final,
    original_price_rs: final !== Number(p.price) ? Number(p.price) : undefined,
    in_stock: p.stock === undefined || p.stock === null ? true : Number(p.stock) > 0,
    store_id: p.store_id,
    store: p.store_name || p.store?.name,
    has_options: (Array.isArray(p.food_variations) && p.food_variations.length > 0) || (Array.isArray(p.variations) && p.variations.length > 0),
    max_per_order: p.maximum_cart_quantity || undefined,
    image: p.image_full_url || undefined,
    link: `${WEB}/p/${p.id}/${p.slug || ""}`.replace(/\/$/, ""),
  };
  return out;
}

export function productDetail(p: any) {
  const base = product(p);
  const options: any[] = [];
  for (const v of p.food_variations || []) {
    options.push({
      group: v.name,
      required: v.required === "on" || v.required === true,
      select: v.type === "multi" ? `${v.min || 0}-${v.max || "any"}` : "one",
      choices: (v.values || []).map((x: any) => ({ label: x.label, extra_rs: Number(x.optionPrice) || 0 })),
    });
  }
  for (const v of p.variations || []) {
    if (v?.type) options.push({ variant: v.type, price_rs: Number(v.price) || 0, stock: v.stock });
  }
  return {
    ...base,
    description: p.description ? String(p.description).slice(0, 600) : undefined,
    category: (p.category_ids || []).map((c: any) => c.name).filter(Boolean).join(" > ") || undefined,
    delivery_time: p.delivery_time || undefined,
    rating: p.avg_rating ? `${Number(p.avg_rating).toFixed(1)} (${p.rating_count})` : undefined,
    options: options.length ? options : undefined,
  };
}

export function store(s: any) {
  return {
    store_id: s.id,
    name: s.name,
    address: s.address,
    open_now: s.open === undefined ? undefined : Boolean(Number(s.open)) && s.active !== false,
    delivery_time: s.delivery_time || undefined,
    minimum_order_rs: Number(s.minimum_order) || 0,
    distance_km: s.distance !== undefined && s.distance !== null ? r(Number(s.distance) / 1000) : undefined,
    rating: s.avg_rating ? Number(s.avg_rating).toFixed(1) : undefined,
    free_delivery: s.free_delivery || undefined,
    link: `${WEB}/s/${s.id}`,
  };
}

export function cartRow(c: any) {
  const it = c.item || {};
  return {
    cart_id: c.id,
    item_id: c.item_id,
    name: it.name,
    unit: it.unit_type || undefined,
    quantity: Number(c.quantity),
    unit_price_rs: Number(c.price),
    line_total_rs: r(Number(c.price) * Number(c.quantity)),
    store_id: it.store_id,
    store: it.store_name,
    options: Array.isArray(c.variation) && c.variation.length ? c.variation : undefined,
  };
}

export function order(o: any) {
  return {
    order_id: o.id,
    status: o.order_status,
    placed_at: o.created_at,
    store: o.store?.name,
    total_rs: Number(o.order_amount),
    delivery_charge_rs: o.delivery_charge !== undefined ? Number(o.delivery_charge) : undefined,
    payment: o.payment_method,
    payment_status: o.payment_status,
    items_count: o.details_count,
    track_link: `${WEB}/track/${o.id}`,
  };
}

export function address(a: any) {
  return {
    address_id: a.id,
    label: a.address_type,
    address: [a.house && `House ${a.house}`, a.road && `Street ${a.road}`, a.address].filter(Boolean).join(", "),
    contact: a.contact_person_name,
    latitude: Number(a.latitude),
    longitude: Number(a.longitude),
  };
}

export function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

export function fail(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

export function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371, dLat = ((bLat - aLat) * Math.PI) / 180, dLng = ((bLng - aLng) * Math.PI) / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return r(2 * R * Math.asin(Math.sqrt(x)));
}
