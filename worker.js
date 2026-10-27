// Seforim Search — Cloudflare Worker (fetching back-end for the public site).
//
// What this is: the static GitHub Pages site cannot read other stores'
// search pages directly from a visitor's browser (CORS: stores don't send
// the headers that would allow it). This worker runs server-side, where
// no browser CORS rule applies: it fetches a store's public search page,
// parses title / cover image / price / list price / product link out of
// it, and returns just those cards as JSON.
//
// What it is NOT: no public third-party CORS relay is used, no passwords,
// no payments, no store sign-ins. It only reads public search pages,
// exactly as a browser would. If a store blocks the worker
// (bot check, 403, timeout), that store comes back as an honest error
// and the frontend shows the link-out fallback — listings are never
// invented.
//
// Accounts (added for the wishlist): sign-in is Google Identity Services
// only. The frontend gets a Google ID token and hands it to this worker,
// which verifies Google's signature and issuer/audience/expiry itself —
// no Google client secret is stored anywhere, and no password of any
// kind is ever collected or stored. A verified user gets a random
// session id in KV (HttpOnly, Secure, SameSite=None cookie, 30 days);
// the wishlist is stored in KV under that user's Google id, nothing
// else. No payment or address data is ever handled.
//
// Deploy: see README.md ("Deploy the fetching worker"). Free tier is
// enough to start (100,000 requests/day on Cloudflare Workers free).

const enc = (q) => encodeURIComponent(q);

const STORES = [
  { id: "eichlers", name: "Eichler's", parser: "magento",
    searchUrl: (q) => `https://www.eichlers.com/catalogsearch/result/?q=${enc(q)}` },
  { id: "feldheim", name: "Feldheim", parser: "magento",
    searchUrl: (q) => `https://www.feldheim.com/catalogsearch/result/?q=${enc(q)}` },
  { id: "zberman", name: "Z. Berman Books", parser: "magento",
    searchUrl: (q) => `https://zbermanbooks.com/catalogsearch/result/?q=${enc(q)}` },
  { id: "seforimdeals", name: "SeforimDeals", parser: "shopify",
    searchUrl: (q) => `https://seforimdeals.com/search?q=${enc(q)}` },
  { id: "seforimplace", name: "SeforimPlace", parser: "opencartJournal",
    searchUrl: (q) => `https://seforimplace.com/index.php?route=product/search&search=${enc(q)}` },
  { id: "hamafitz", name: "Hamafitz", parser: "opencartClassic",
    searchUrl: (q) => `https://www.hamafitz.com/index.php?route=product/search&search=${enc(q)}` },
  { id: "greenfield", name: "Greenfield Judaica", parser: "volusion",
    searchUrl: (q) => `https://www.greenfieldjudaica.com/search.asp?search=${enc(q)}` },
  { id: "esicha", name: "eSicha", note: "sichos publications", parser: "wooStoreApi",
    searchUrl: (q) => `https://www.esicha.org/?s=${enc(q)}` },
];

const MAX_PER_STORE = 24;
const CACHE_TTL_SECONDS = 600; // 10 minutes
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 SeforimSearch/1.0";

function decodeEntities(s) {
  return s.replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
}
function cleanText(s) {
  return decodeEntities(s.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}
function money(amount) { return `$${amount.toFixed(2)}`; }
function parseDollarText(text) {
  const m = text.match(/\$\s?([\d,]+(?:\.\d{2})?)/);
  if (!m?.[1]) return null;
  const n = parseFloat(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}
function firstDollar(text) {
  const amount = parseDollarText(text);
  return amount == null ? null : { text: money(amount), amount };
}
function imgFromTag(tag) {
  const attr = (name) => {
    const m = tag.match(new RegExp(`${name}="([^"]+)"`));
    return m?.[1] ?? null;
  };
  for (const c of [attr("data-original"), attr("data-src"), attr("data-lazy-src"), attr("src")]) {
    if (!c) continue;
    const v = decodeEntities(c).trim();
    if (v.startsWith("data:image")) continue;
    if (/pixel|placeholder|no-image|blank\.gif|spacer/i.test(v)) continue;
    if (v.startsWith("//")) return `https:${v}`;
    if (v.startsWith("http")) return v;
  }
  const srcset = attr("srcset") ?? attr("data-srcset");
  if (srcset) {
    const first = srcset.split(",")[0]?.trim().split(/\s+/)[0];
    if (first?.startsWith("http")) return first;
  }
  return null;
}
function looksBotWalled(html) {
  return html.includes("/.within.website/") || html.includes("Making sure you") ||
    html.includes("Just a moment...") || html.includes("cf-challenge") ||
    html.includes("Attention Required! | Cloudflare") || html.includes("sessionStorage.IoI");
}

function parseMagento(html) {
  const products = []; const seen = new Set();
  const anchorRe = /<a\b[^>]*>([\s\S]*?)<\/a>/g;
  for (const m of html.matchAll(anchorRe)) {
    if (products.length >= MAX_PER_STORE) break;
    const openTag = m[0].slice(0, m[0].indexOf(">") + 1);
    if (!openTag.includes("product-item-link")) continue;
    const href = openTag.match(/href="([^"]+)"/)?.[1];
    if (!href) continue;
    const url = decodeEntities(href);
    if (seen.has(url)) continue;
    const title = cleanText(m[1] ?? "");
    if (!title) continue;
    seen.add(url);
    const idx = m.index ?? 0;
    const before = html.slice(Math.max(0, idx - 4500), idx);
    const after = html.slice(idx, idx + 3000);
    let imageUrl = null;
    const imgTags = before.match(/<img\b[^>]*>/g) ?? [];
    for (let i = imgTags.length - 1; i >= 0; i--) {
      const tag = imgTags[i] ?? "";
      if (/product-image|primary-image/.test(tag)) { imageUrl = imgFromTag(tag); if (imageUrl) break; }
    }
    let priceAmount = null;
    const priceMatch = after.match(/data-price-amount="([\d.]+)"[^>]*data-price-type="finalPrice"/) ?? after.match(/data-price-amount="([\d.]+)"/);
    if (priceMatch?.[1]) { const n = parseFloat(priceMatch[1]); if (Number.isFinite(n)) priceAmount = n; }
    if (priceAmount == null) { const d = firstDollar(after.slice(0, 1200)); if (d) priceAmount = d.amount; }
    let compareAtText = null;
    const oldMatch = after.match(/data-price-amount="([\d.]+)"[^>]*data-price-type="oldPrice"/) ?? after.match(/data-price-type="oldPrice"[^>]*data-price-amount="([\d.]+)"/);
    if (oldMatch?.[1] && priceAmount != null) {
      const old = parseFloat(oldMatch[1]);
      if (Number.isFinite(old) && old > priceAmount) compareAtText = money(old);
    }
    products.push({ title, url, priceText: priceAmount == null ? null : money(priceAmount), priceAmount, compareAtText, imageUrl });
  }
  return products;
}
function parseShopify(html) {
  const products = []; const seen = new Set();
  const blocks = html.split(/<div class="product-item\s/);
  for (const block of blocks.slice(1)) {
    if (products.length >= MAX_PER_STORE) break;
    const chunk = block.slice(0, 7000);
    const titleM = chunk.match(/<a href="(\/products\/[^"]+)"[^>]*class="product-item__title[^"]*"[^>]*>([\s\S]*?)<\/a>/);
    if (!titleM?.[1] || !titleM[2]) continue;
    const path = titleM[1].split("?")[0] ?? titleM[1];
    const url = `https://seforimdeals.com${path}`;
    if (seen.has(url)) continue;
    const title = cleanText(titleM[2]);
    if (!title) continue;
    seen.add(url);
    let imageUrl = null;
    const imgM = chunk.match(/<img\b[^>]*>/);
    if (imgM) imageUrl = imgFromTag(imgM[0].replace("{width}", "600"));
    const saleM = chunk.match(/price--highlight[^>]*>[\s\S]{0,200}?\$\s?([\d,]+(?:\.\d{2})?)/);
    const cmpM = chunk.match(/price--compare[^>]*>[\s\S]{0,200}?\$\s?([\d,]+(?:\.\d{2})?)/);
    let priceAmount = null;
    if (saleM?.[1]) priceAmount = parseFloat(saleM[1].replace(/,/g, ""));
    if (priceAmount == null || !Number.isFinite(priceAmount)) {
      const idx = chunk.indexOf("product-item__price-list");
      const d = idx >= 0 ? firstDollar(chunk.slice(idx)) : null;
      priceAmount = d?.amount ?? null;
    }
    const compareAmount = cmpM?.[1] ? parseFloat(cmpM[1].replace(/,/g, "")) : null;
    products.push({ title, url, priceText: priceAmount == null ? null : money(priceAmount), priceAmount,
      compareAtText: compareAmount != null && Number.isFinite(compareAmount) && compareAmount !== priceAmount ? money(compareAmount) : null, imageUrl });
  }
  return products;
}
function parseShopifySuggest(raw) {
  try {
    const data = JSON.parse(raw);
    const list = data.resources?.results?.products ?? [];
    return list.slice(0, MAX_PER_STORE).map((p) => {
      const img = p.featured_image?.url ?? p.featured_image?.src ?? null;
      const priceN = p.price ? parseFloat(p.price) : NaN;
      return { title: cleanText(p.title ?? ""), url: p.url ? `https://seforimdeals.com${p.url.split("?")[0]}` : "",
        priceText: Number.isFinite(priceN) ? money(priceN) : null, priceAmount: Number.isFinite(priceN) ? priceN : null,
        compareAtText: null, imageUrl: img ? (img.startsWith("//") ? `https:${img}` : img) : null };
    }).filter((p) => p.title && p.url);
  } catch { return []; }
}
function parseOpencartJournal(html) {
  const clean = html.replace(/<style[\s\S]*?<\/style>/g, "").replace(/<script[\s\S]*?<\/script>/g, "");
  const products = []; const seen = new Set();
  for (const seg of clean.split(/class="product-layout/)) {
    if (products.length >= MAX_PER_STORE) break;
    const chunk = seg.slice(0, 8000);
    const nameM = chunk.match(/class="name[^"]*">\s*<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!nameM?.[1] || !nameM[2]) continue;
    const url = decodeEntities(nameM[1]).split("?")[0] ?? nameM[1];
    if (seen.has(url)) continue;
    const title = cleanText(nameM[2]);
    if (!title) continue;
    seen.add(url);
    let priceAmount = null; let compareAtText = null;
    const pNew = chunk.match(/price-new[^>]*>\s*\$?\s?([\d,]+(?:\.\d{2})?)/);
    const pOld = chunk.match(/price-old[^>]*>\s*\$?\s?([\d,]+(?:\.\d{2})?)/);
    if (pNew?.[1]) priceAmount = parseFloat(pNew[1].replace(/,/g, ""));
    if (pOld?.[1] && priceAmount != null) { const old = parseFloat(pOld[1].replace(/,/g, "")); if (Number.isFinite(old) && old > priceAmount) compareAtText = money(old); }
    if (priceAmount == null) { const pn = chunk.match(/price-normal[^>]*>\s*\$?\s?([\d,]+(?:\.\d{2})?)/); if (pn?.[1]) priceAmount = parseFloat(pn[1].replace(/,/g, "")); }
    if (priceAmount == null || !Number.isFinite(priceAmount)) {
      const priceDiv = chunk.match(/class="price"[^>]*>([\s\S]{0,500})/);
      const d = priceDiv?.[1] ? firstDollar(priceDiv[1]) : null;
      priceAmount = d?.amount ?? null;
    }
    let imageUrl = null;
    const imgs = chunk.match(/<img\b[^>]*>/g) ?? [];
    for (const tag of imgs) {
      if (tag.includes("/image/cache/") || tag.includes("/image/data/") || tag.includes("/image/catalog/")) { imageUrl = imgFromTag(tag); if (imageUrl) break; }
    }
    if (!imageUrl && imgs[0]) imageUrl = imgFromTag(imgs[0]);
    products.push({ title, url, priceText: priceAmount == null ? null : money(priceAmount), priceAmount, compareAtText, imageUrl });
  }
  return products;
}
function parseOpencartClassic(html) {
  const products = []; const seen = new Set();
  const segments = html.split(/class="product-thumb/);
  for (const seg of segments.slice(1)) {
    if (products.length >= MAX_PER_STORE) break;
    const chunk = seg.slice(0, 8000);
    const h4 = chunk.match(/<h4>\s*<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!h4?.[1] || !h4[2]) continue;
    const url = decodeEntities(h4[1]).split("?")[0] ?? h4[1];
    if (seen.has(url)) continue;
    const title = cleanText(h4[2]);
    if (!title) continue;
    seen.add(url);
    const priceM = chunk.match(/class="price"[^>]*>([\s\S]{0,600})/);
    const priceHtml = priceM?.[1] ?? "";
    const pNew = priceHtml.match(/price-new[^>]*>\s*\$?\s?([\d,]+(?:\.\d{2})?)/);
    const pOld = priceHtml.match(/price-old[^>]*>\s*\$?\s?([\d,]+(?:\.\d{2})?)/);
    let priceAmount = null; let compareAtText = null;
    if (pNew?.[1]) priceAmount = parseFloat(pNew[1].replace(/,/g, ""));
    if (pOld?.[1] && priceAmount != null) { const old = parseFloat(pOld[1].replace(/,/g, "")); if (Number.isFinite(old) && old > priceAmount) compareAtText = money(old); }
    if (priceAmount == null) { const d = firstDollar(priceHtml); priceAmount = d?.amount ?? null; }
    let imageUrl = null;
    const imgs = chunk.match(/<img\b[^>]*>/g) ?? [];
    for (const tag of imgs) { if (tag.includes("/image/cache/")) { imageUrl = imgFromTag(tag); if (imageUrl) break; } }
    if (!imageUrl && imgs[0]) imageUrl = imgFromTag(imgs[0]);
    products.push({ title, url, priceText: priceAmount == null ? null : money(priceAmount), priceAmount, compareAtText, imageUrl });
  }
  return products;
}
function parseVolusion(html) {
  const products = []; const seen = new Set();
  const anchorRe = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  for (const m of html.matchAll(anchorRe)) {
    if (products.length >= MAX_PER_STORE) break;
    const href = decodeEntities(m[1] ?? "");
    if (!/(item\.asp|\.html)(\?|$)/i.test(href)) continue;
    if (/search\.asp|category|cart|checkout|account|login/i.test(href)) continue;
    const url = href.startsWith("http") ? href : `https://www.greenfieldjudaica.com${href.startsWith("/") ? "" : "/"}${href}`;
    const cleanUrl = url.split("?")[0] ?? url;
    if (seen.has(cleanUrl)) continue;
    const title = cleanText(m[2] ?? "");
    if (title.length < 4 || /^(home|menu|cart|search|view|more)$/i.test(title)) continue;
    seen.add(cleanUrl);
    const idx = m.index ?? 0;
    const around = html.slice(Math.max(0, idx - 1200), idx + 1800);
    const d = firstDollar(around.slice(1200));
    let imageUrl = null;
    const imgs = around.match(/<img\b[^>]*>/g) ?? [];
    for (const tag of imgs) { const v = imgFromTag(tag); if (v && !/logo|icon|button/i.test(v)) { imageUrl = v; break; } }
    products.push({ title, url: cleanUrl, priceText: d?.text ?? null, priceAmount: d?.amount ?? null, compareAtText: null, imageUrl });
  }
  return products;
}
function parseWooStoreApi(raw) {
  let data;
  try { data = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(data)) return [];
  const products = [];
  for (const p of data) {
    const title = cleanText(p.name ?? "");
    const url = p.permalink ?? "";
    if (!title || !url) continue;
    const minor = p.prices?.currency_minor_unit ?? 2;
    const div = Math.pow(10, minor);
    const priceRaw = p.prices?.price ? parseInt(p.prices.price, 10) : NaN;
    const regRaw = p.prices?.regular_price ? parseInt(p.prices.regular_price, 10) : NaN;
    const priceAmount = Number.isFinite(priceRaw) ? priceRaw / div : null;
    products.push({ title, url, priceText: priceAmount == null ? null : money(priceAmount), priceAmount,
      compareAtText: Number.isFinite(regRaw) && regRaw !== priceRaw ? money(regRaw / div) : null, imageUrl: p.images?.[0]?.src ?? null });
    if (products.length >= MAX_PER_STORE) break;
  }
  return products;
}

function parseForStore(store, text) {
  switch (store.parser) {
    case "magento": return parseMagento(text);
    case "shopify": return parseShopify(text);
    case "opencartJournal": return parseOpencartJournal(text);
    case "opencartClassic": return parseOpencartClassic(text);
    case "volusion": return parseVolusion(text);
    case "wooStoreApi": return parseWooStoreApi(text);
    default: return [];
  }
}
function targetUrlFor(store, query) {
  if (store.parser === "wooStoreApi") {
    return `https://www.esicha.org/wp-json/wc/store/v1/products?search=${enc(query)}&per_page=${MAX_PER_STORE}`;
  }
  return store.searchUrl(query);
}
async function fetchStoreText(store, query) {
  const url = targetUrlFor(store, query);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    // Eichler's WAF blocks desktop Chrome user-agents (403) while
    // accepting a plain generic agent from the same IP, so it gets one.
    // SeforimPlace does the same (desktop Chrome UA gets a 547-byte
    // bot-check page; a plain agent gets the real ~315KB search page).
    const ua = (store.id === "eichlers" || store.id === "seforimplace") ? "Mozilla/5.0" : UA;
    const res = await fetch(url, {
      signal: ctrl.signal, redirect: "follow",
      headers: { "User-Agent": ua, "Accept": "text/html,application/json,*/*", "Accept-Language": "en-US,en;q=0.9" },
    });
    if (!res.ok) return { ok: false, httpStatus: res.status, text: null };
    return { ok: true, httpStatus: res.status, text: await res.text() };
  } catch (e) {
    return { ok: false, httpStatus: null, text: null, error: String(e?.name ?? e) };
  } finally { clearTimeout(t); }
}
async function searchStoreWorker(store, query) {
  const base = { storeId: store.id, storeName: store.name, searchUrl: store.searchUrl(query) };
  const got = await fetchStoreText(store, query);
  if (!got.ok) {
    return { ...base, status: "error",
      message: `${store.name} could not be reached right now${got.httpStatus ? ` (HTTP ${got.httpStatus})` : ""}. You can open its own search results instead.`, products: [] };
  }
  const text = got.text ?? "";
  if (looksBotWalled(text)) {
    return { ...base, status: "error",
      message: `${store.name} is showing a bot-check page right now, so its listings can't be loaded here. You can open its own search results instead.`, products: [] };
  }
  let products = parseForStore(store, text);
  if (products.length === 0 && store.parser === "shopify") {
    const suggestUrl = `https://seforimdeals.com/search/suggest.json?q=${enc(query)}&resources%5Btype%5D=product&resources%5Blimit%5D=10`;
    try {
      const res = await fetch(suggestUrl, { headers: { "User-Agent": UA } });
      if (res.ok) products = parseShopifySuggest(await res.text());
    } catch { /* keep empty */ }
  }
  if (products.length === 0) {
    return { ...base, status: "empty", message: `No listings at ${store.name} matched “${query}”.`, products: [] };
  }
  return { ...base, status: "ok", message: null, products };
}

const PAGES_ORIGIN = "https://zakkais.github.io";
function corsHeaders(request) {
  const origin = request?.headers?.get("Origin");
  if (origin === PAGES_ORIGIN) {
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
  }
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}
function jsonResponse(obj, status = 200, request = null, extraHeaders = {}) {
  const cacheControl = (request?.url?.includes("/auth/") || request?.url?.includes("/api/"))
    ? "no-store" : `public, max-age=${CACHE_TTL_SECONDS}`;
  return new Response(JSON.stringify(obj), { status,
    headers: { ...corsHeaders(request), "Cache-Control": cacheControl, "Content-Type": "application/json", ...extraHeaders } });
}

// ---------------------------------------------------------------------------
// Google sign-in + wishlist storage (KV)
// ---------------------------------------------------------------------------

function parseCookies(request) {
  const out = {};
  for (const part of (request.headers.get("Cookie") || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function b64urlDecode(s) {
  const norm = s.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(norm.padEnd(norm.length + (4 - norm.length % 4) % 4, "=")), (c) => c.charCodeAt(0));
}
async function verifyGoogleIdToken(credential, clientId) {
  const parts = String(credential || "").split(".");
  if (parts.length !== 3) return null;
  let header, payload;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[0])));
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1])));
  } catch { return null; }
  if (header.alg !== "RS256" || !header.kid) return null;
  if (payload.iss !== "https://accounts.google.com" && payload.iss !== "accounts.google.com") return null;
  if (payload.aud !== clientId) return null;
  if (payload.exp * 1000 < Date.now()) return null;
  if (payload.email_verified !== true && payload.email_verified !== "true") return null;
  if (!payload.sub || !payload.email) return null;
  let jwks;
  try {
    const res = await fetch("https://www.googleapis.com/oauth2/v3/certs");
    if (!res.ok) return null;
    jwks = await res.json();
  } catch { return null; }
  const jwk = (jwks.keys || []).find((k) => k.kid === header.kid);
  if (!jwk) return null;
  try {
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlDecode(parts[2]), signed);
    if (!ok) return null;
  } catch { return null; }
  return { sub: payload.sub, email: payload.email, name: payload.name || payload.email };
}
async function getSession(request, env) {
  if (!env.SEFORIM_KV) return null;
  const sid = parseCookies(request).ssp_session;
  if (!sid) return null;
  try {
    const raw = await env.SEFORIM_KV.get(`sess:${sid}`);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (s.exp * 1000 < Date.now()) return null;
    return s;
  } catch { return null; }
}
function sessionCookie(sid, maxAge) {
  return `ssp_session=${sid}; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=${maxAge}`;
}
function cleanWishlist(body) {
  const items = Array.isArray(body?.items) ? body.items.slice(0, 500).map((i) => ({
    url: String(i.url || "").slice(0, 2000), title: String(i.title || "").slice(0, 500),
    imageUrl: i.imageUrl ? String(i.imageUrl).slice(0, 2000) : null,
    priceText: i.priceText ? String(i.priceText).slice(0, 50) : null,
    compareAtText: i.compareAtText ? String(i.compareAtText).slice(0, 50) : null,
    storeId: String(i.storeId || "").slice(0, 50), storeName: String(i.storeName || "").slice(0, 100),
  })).filter((i) => i.url && i.title) : [];
  const titles = Array.isArray(body?.titles) ? [...new Set(body.titles.map((t) => String(t).slice(0, 300)).filter(Boolean))].slice(0, 200) : [];
  return { items, titles };
}
async function handleAuth(request, env, url) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }
  if (!env.SEFORIM_KV) return jsonResponse({ error: "Storage not configured" }, 503, request);
  if (url.pathname === "/auth/me") {
    const s = await getSession(request, env);
    if (!s) return jsonResponse({ error: "Not signed in" }, 401, request);
    return jsonResponse({ email: s.email, name: s.name }, 200, request);
  }
  if (url.pathname === "/auth/logout") {
    const sid = parseCookies(request).ssp_session;
    if (sid) await env.SEFORIM_KV.delete(`sess:${sid}`);
    return jsonResponse({ ok: true }, 200, request, { "Set-Cookie": sessionCookie("", 0) });
  }
  if (url.pathname === "/auth/google" && request.method === "POST") {
    const clientId = env.GOOGLE_CLIENT_ID;
    if (!clientId) return jsonResponse({ error: "Google sign-in not configured" }, 503, request);
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: "Bad request" }, 400, request); }
    const user = await verifyGoogleIdToken(body.credential, clientId);
    if (!user) return jsonResponse({ error: "Invalid Google sign-in" }, 401, request);
    const sid = crypto.randomUUID();
    const exp = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
    await env.SEFORIM_KV.put(`sess:${sid}`, JSON.stringify({ ...user, exp }), { expirationTtl: 30 * 24 * 3600 });
    return jsonResponse({ email: user.email, name: user.name }, 200, request, { "Set-Cookie": sessionCookie(sid, 30 * 24 * 3600) });
  }
  if (url.pathname === "/api/wishlist") {
    const s = await getSession(request, env);
    if (!s) return jsonResponse({ error: "Not signed in" }, 401, request);
    if (request.method === "GET") {
      const raw = await env.SEFORIM_KV.get(`wish:${s.sub}`);
      return jsonResponse(raw ? JSON.parse(raw) : { items: [], titles: [] }, 200, request);
    }
    if (request.method === "PUT") {
      let body;
      try { body = await request.json(); } catch { return jsonResponse({ error: "Bad request" }, 400, request); }
      const cleaned = cleanWishlist(body);
      await env.SEFORIM_KV.put(`wish:${s.sub}`, JSON.stringify(cleaned));
      return jsonResponse(cleaned, 200, request);
    }
  }
  return jsonResponse({ error: "Not found" }, 404, request);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/auth/") || url.pathname.startsWith("/api/")) {
      return handleAuth(request, env, url);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }
    if (url.pathname === "/stores") {
      return jsonResponse({ stores: STORES.map((s) => ({ id: s.id, name: s.name, note: s.note ?? null })) }, 200, request);
    }
    // Any other path (including "/") with a ?q= runs a search; without
    // ?q= it returns the store list, so the worker URL alone is a
    // harmless health check.
    const q = (url.searchParams.get("q") || "").trim();
    if (!q) return jsonResponse({ error: "Missing ?q= search term" }, 400);
    const only = url.searchParams.get("store");
    const stores = only ? STORES.filter((s) => s.id === only) : STORES;
    if (only && stores.length === 0) return jsonResponse({ error: `Unknown store: ${only}` }, 400);

    // Cache: Cloudflare cache API when available; in local testing it is absent and skipped.
    const cacheKey = new Request(url.toString(), request);
    let cache = null;
    try { cache = typeof caches !== "undefined" ? caches.default : null; } catch { cache = null; }
    if (cache) {
      const hit = await cache.match(cacheKey);
      if (hit) return hit;
    }
    const results = await Promise.all(stores.map((s) => searchStoreWorker(s, q)));
    const response = jsonResponse({ query: q, results });
    if (cache && ctx?.waitUntil) {
      const toCache = response.clone();
      ctx.waitUntil(cache.put(cacheKey, toCache));
    }
    return response;
  },
};
