/**
 * Foran Delivery MCP Server
 * Copyright (c) 2026 Foran Private Limited. MIT License.
 *
 * Thin client for the public Foran customer API (the same API the
 * Foran customer app and www.forandelivery.com use).
 */

export const API_BASE = (process.env.FORAN_API_BASE || "https://admin.forandelivery.com").replace(/\/+$/, "");
const DEFAULT_MODULE = Number(process.env.FORAN_DEFAULT_MODULE || 1);
const TIMEOUT_MS = Number(process.env.FORAN_API_TIMEOUT_MS || 20000);

/** Location / module context sent as headers, exactly like the app does. */
export interface Ctx {
  zoneIds?: number[];
  moduleId?: number;
  lat?: number;
  lng?: number;
  token?: string;
}

export class ForanApiError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
  }
}

function headers(ctx: Ctx = {}): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/json",
    "X-localization": "en",
    "User-Agent": "foran-delivery-mcp/1.0",
  };
  if (ctx.zoneIds?.length) h["zoneId"] = JSON.stringify(ctx.zoneIds);
  // The app always sends a module; Foran API routes are module-checked. Default = Mart (1).
  h["moduleId"] = String(ctx.moduleId ?? DEFAULT_MODULE);
  if (ctx.lat !== undefined && ctx.lng !== undefined) {
    h["latitude"] = String(ctx.lat);
    h["longitude"] = String(ctx.lng);
  }
  if (ctx.token) h["Authorization"] = `Bearer ${ctx.token}`;
  return h;
}

function errorText(body: any, status: number): string {
  if (body && Array.isArray(body.errors) && body.errors.length) {
    return body.errors.map((e: any) => e.message || e.code).join("; ");
  }
  if (body && typeof body.message === "string") return body.message;
  if (status === 401) return "Not logged in or session expired. Please log in again.";
  return `Foran API error (HTTP ${status}).`;
}

async function request(method: string, path: string, ctx: Ctx, query?: Record<string, unknown>, form?: Record<string, unknown>): Promise<any> {
  const url = new URL(API_BASE + path);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const h = headers(ctx);
  let body: string | undefined;
  if (form) {
    h["Content-Type"] = "application/json";
    body = JSON.stringify(form);
  }
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, { method, headers: h, body, signal: ac.signal });
  } catch (e: any) {
    throw new ForanApiError(0, `Could not reach Foran (${e?.name === "AbortError" ? "timeout" : "network error"}). Please try again.`);
  } finally {
    clearTimeout(t);
  }
  const text = await res.text();
  let data: any = text;
  try { data = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  if (!res.ok) throw new ForanApiError(res.status, errorText(data, res.status), data);
  return data;
}

export const api = {
  get: (path: string, ctx: Ctx = {}, query?: Record<string, unknown>) => request("GET", path, ctx, query),
  post: (path: string, ctx: Ctx = {}, form?: Record<string, unknown>, query?: Record<string, unknown>) => request("POST", path, ctx, query, form),
  put: (path: string, ctx: Ctx = {}, form?: Record<string, unknown>) => request("PUT", path, ctx, undefined, form),
  del: (path: string, ctx: Ctx = {}, query?: Record<string, unknown>) => request("DELETE", path, ctx, query),
};

/** Mart = 1, Bites = 2 on Foran. Resolved from /api/v1/module and cached. */
let moduleCache: { at: number; list: any[] } | null = null;
export async function modules(): Promise<any[]> {
  if (moduleCache && Date.now() - moduleCache.at < 10 * 60_000) return moduleCache.list;
  const list = await api.get("/api/v1/module");
  moduleCache = { at: Date.now(), list: Array.isArray(list) ? list : [] };
  return moduleCache.list;
}

export async function moduleIdFor(kind: "mart" | "bites"): Promise<number> {
  const list = await modules();
  const want = kind === "mart" ? "grocery" : "food";
  const m = list.find((x) => x.module_type === want && x.status == 1) || list.find((x) => x.module_type === want);
  return m?.id ?? (kind === "mart" ? 1 : 2);
}

/** Zone ids for a coordinate. Throws a friendly error when outside Foran's service area. */
export async function zoneFor(lat: number, lng: number): Promise<{ zoneIds: number[]; names: string[] }> {
  let d: any;
  try {
    d = await api.get("/api/v1/config/get-zone-id", {}, { lat, lng });
  } catch (e) {
    if (e instanceof ForanApiError && (e.status === 404 || e.status === 403)) {
      throw new ForanApiError(e.status, "Foran does not deliver to this location yet. Live areas: Bahria Town Karachi and Hyderabad.");
    }
    throw e;
  }
  let ids: number[] = [];
  try { ids = JSON.parse(d.zone_id); } catch { ids = []; }
  const names = (d.zone_data || []).map((z: any) => z.name);
  if (!ids.length) throw new ForanApiError(404, "Foran does not deliver to this location yet. Live areas: Bahria Town Karachi and Hyderabad.");
  return { zoneIds: ids, names };
}
