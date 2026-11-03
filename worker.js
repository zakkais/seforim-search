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
//
// HOW TO EDIT THIS FILE (read before changing anything):
// - What it needs from Cloudflare: a KV namespace bound as SEFORIM_KV
//   (sign-in sessions and server wishlists live there) and a plain-text
//   environment variable GOOGLE_CLIENT_ID (the public Google client id).
//   Without those two bindings, search still works but sign-in returns
//   "not configured" — do not deploy this file without them.
// - Do NOT add a Google client secret anywhere in this file. Sign-in
//   works by verifying Google's signed ID token (see
//   verifyGoogleIdToken); no secret is needed, and none must ever be
//   written here.
// - INTENTIONAL DUPLICATION: the store list (STORES) and the store
//   parsers below are copied in app.js as well. That is not an accident
//   to clean up: app.js is the direct-browser fallback the page uses
//   when this worker cannot be reached. The worker copy is
//   authoritative for live site searches; the app.js copy is
//   authoritative for that fallback. If you change a store's search URL
//   or a parser, change it in BOTH files, and keep MAX_PER_STORE the
//   same in both, or the page will trim the worker's results.
// - Per-store behaviour, in one place (details live beside the code):
//   at most 100 listings per store; Magento stores take one request
//   with product_list_limit=100; OpenCart and Shopify stores are
//   fetched page by page in parallel; eSicha's API serves 10 listings
//   per page, so pages 1-10 are fetched; Greenfield is bot-blocked
//   and is meant to come back as an error, never as invented listings.
// - SAFE MODE (2026-10-28, extended 2026-11-03): Eichler's and
//   Feldheim are NOT in the store list — Eichler's robots.txt
//   disallows its search route (/catalogsearch/), and Feldheim's
//   disallows both the whole site for ordinary agents and its search
//   route, so neither is fetched. Every store is fetched with the same identified
//   agent below (SeforimSearch/1.0); no plain-agent workaround is
//   used, so a store that answers a bot-check page (SeforimPlace
//   does, for non-browser agents) simply returns no listings and is
//   omitted, rather than being worked around.

const enc = (q) => encodeURIComponent(q);

const STORES = [
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

// Per-store cap for one search: up to 100 listings. How a store gets there
// differs — see pageUrlsFor: Magento takes a single request with a big
// page size (product_list_limit=100), while OpenCart ignores its limit
// parameter entirely (SeforimPlace returns 20/page whatever limit is
// asked) and WooCommerce's API fixes its page at 10, so those stores are
// fetched page by page, in parallel, instead of one slow sequence.
const MAX_PER_STORE = 100;
const CACHE_TTL_SECONDS = 600; // 10 minutes
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 SeforimSearch/1.0";

// ---------------------------------------------------------------------------
// Small helpers shared by the parsers: cleaning text, reading prices and
// cover images out of raw HTML, and spotting a bot-check page.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// One parser per store platform. Each turns a store's search page (or,
// for eSicha, its product API JSON) into the same shape:
// { title, url, priceText, priceAmount, compareAtText, imageUrl }.
// A parser returning [] does not mean "no such sefer" — it can also mean
// the store changed its page layout, in which case this is the place
// that needs updating (and the matching parser in app.js too).
// ---------------------------------------------------------------------------
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
    const titleM = chunk.match(/<a href="([^"]*\/products\/[^"]+)"[^>]*class="product-item__title[^"]*"[^>]*>([\s\S]*?)<\/a>/);
    if (!titleM?.[1] || !titleM[2]) continue;
    // Collection pages prefix the href with /collections/<name>; the
    // canonical product URL is always /products/<handle>. (Search
    // pages already link that way, so this changes nothing for them.
    // The new-releases feed reads a collection page — see below.)
    const handle = titleM[1].split("?")[0].split("/products/")[1];
    if (!handle) continue;
    const url = `https://seforimdeals.com/products/${handle}`;
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
      compareAtText: Number.isFinite(regRaw) && regRaw !== priceRaw ? money(regRaw / div) : null, imageUrl: p.images?.[0]?.src ?? null,
      soldOut: p.is_in_stock === false });
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
function parseKehot(html) {
  // Kehot's department listing (store.kehotonline.com/products.asp):
  // each product has a class="producttitlelink" anchor to
  // prodinfo.asp?number=<SKU>, its cover in an <img> with class
  // "prodlistimg" shortly before the anchor (a relative "images/..."
  // path), and its price in a <span class="ProductPrice"> shortly
  // after. There is no list price on the listing page, so
  // compareAtText is always null. Used only by the new-releases feed
  // below; Kehot search itself is a POST form and stays out of the
  // worker, as before.
  const products = []; const seen = new Set();
  const anchorRe = /<a\b[^>]*class="producttitlelink"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  for (const m of html.matchAll(anchorRe)) {
    if (products.length >= MAX_PER_STORE) break;
    const url = decodeEntities(m[1]);
    if (!url || seen.has(url)) continue;
    const title = cleanText(m[2] ?? "");
    if (!title) continue;
    seen.add(url);
    const idx = m.index ?? 0;
    let imageUrl = null;
    const before = html.slice(Math.max(0, idx - 2500), idx);
    const imgs = before.match(/<img\b[^>]*prodlistimg[^>]*>/gi) ?? [];
    if (imgs.length) {
      const srcM = imgs[imgs.length - 1].match(/src="([^"]+)"/i);
      if (srcM?.[1]) {
        const v = decodeEntities(srcM[1]);
        if (!/clear\.gif|spacer/i.test(v)) {
          imageUrl = v.startsWith("http") ? v : `https://store.kehotonline.com/${v.replace(/^\//, "")}`;
        }
      }
    }
    let priceAmount = null;
    const priceM = html.slice(idx, idx + 5000).match(/class="ProductPrice">\s*\$\s?([\d,]+(?:\.\d{2})?)/);
    if (priceM?.[1]) { const n = parseFloat(priceM[1].replace(/,/g, "")); if (Number.isFinite(n)) priceAmount = n; }
    products.push({ title, url, priceText: priceAmount == null ? null : money(priceAmount), priceAmount, compareAtText: null, imageUrl });
  }
  return products;
}
// ---------------------------------------------------------------------------
// Fetching: which URL(s) to ask each store for, and how the results from
// several pages are merged. See the per-store notes in extraPageUrls
// and fetchStoreText — those two functions hold the paging logic that
// lets each store return more than its first page.
// ---------------------------------------------------------------------------
function targetUrlFor(store, query, light) {
  if (store.parser === "wooStoreApi") {
    return `https://www.esicha.org/wp-json/wc/store/v1/products?search=${enc(query)}&per_page=${light ? 25 : MAX_PER_STORE}`;
  }
  return store.searchUrl(query);
}
async function fetchStoreText(store, url, ajax = false) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    // SAFE MODE: every store gets the same identified agent (UA above).
    // No plain-agent workaround: SeforimPlace answers non-browser
    // agents with a bot-check page, and that answer is accepted — it
    // yields no listings and the store is omitted, not worked around.
    const headers = { "User-Agent": UA, "Accept": "text/html,application/json,*/*", "Accept-Language": "en-US,en;q=0.9" };
    // Journal (SeforimPlace) only honours the page parameter on AJAX
    // requests — its infinite scroll loads later pages that way. A plain
    // fetch of &page=2 returns page 1 again; with X-Requested-With it
    // correctly returns "Showing 21 to 40" (verified against a real
    // browser, whose page 2 starts with Shut Chacham Tzvi).
    if (ajax) headers["X-Requested-With"] = "XMLHttpRequest";
    const res = await fetch(url, {
      signal: ctrl.signal, redirect: "follow", headers,
    });
    if (!res.ok) return { ok: false, httpStatus: res.status, text: null };
    return { ok: true, httpStatus: res.status, text: await res.text() };
  } catch (e) {
    return { ok: false, httpStatus: null, text: null, error: String(e?.name ?? e) };
  } finally { clearTimeout(t); }
}
// Extra page URLs beyond page 1, or null when one request already covers
// the store (Magento's product_list_limit, or a blocked/single-page store).
function extraPageUrls(store, query) {
  if (store.parser === "magento" || store.parser === "volusion") return null;
  if (store.parser === "wooStoreApi") {
    const base = targetUrlFor(store, query);
    return Array.from({ length: 9 }, (_, i) => `${base}&page=${i + 2}`);
  }
  const base = store.searchUrl(query);
  return [2, 3, 4, 5].map((p) => `${base}&page=${p}`);
}
function mergeAcrossPages(lists) {
  const seen = new Set(); const out = [];
  for (const list of lists) for (const p of list) {
    const key = p.url || p.title;
    if (seen.has(key)) continue;
    seen.add(key); out.push(p);
    if (out.length >= MAX_PER_STORE) return out;
  }
  return out;
}
async function searchStoreWorker(store, query, env, ctx, opts = {}) {
  // opts.light (chat grounding): first page only, no stock annotation.
  // A chat invocation searches all six stores at once, and the full
  // path — extra pages plus up to 40 stock fetches — blew past the
  // platform's 50-subrequest limit, which surfaced as the AI call
  // itself failing ("Too many subrequests") on big result sets.
  const light = !!opts.light;
  const base = { storeId: store.id, storeName: store.name, searchUrl: store.searchUrl(query) };
  // Magento gets one big request instead of paging: its limit parameter
  // is honoured by the Magento stores.
  const firstUrl = store.parser === "magento"
    ? `${store.searchUrl(query)}&product_list_limit=${MAX_PER_STORE}`
    : targetUrlFor(store, query, light);
  const got = await fetchStoreText(store, firstUrl);
  if (!got.ok) {
    return { ...base, status: "error",
      message: `${store.name} could not be reached right now${got.httpStatus ? ` (HTTP ${got.httpStatus})` : ""}. You can open its own search results instead.`, products: [] };
  }
  const text = got.text ?? "";
  if (looksBotWalled(text)) {
    // This is the expected outcome for Greenfield: its challenge page
    // demands JavaScript, which a server-side fetch cannot run, so the
    // store honestly reports an error instead of listings. Do not try
    // to "fix" this by inventing listings or by scraping through a
    // browser from the worker — that is not what this worker does.
    return { ...base, status: "error",
      message: `${store.name} is showing a bot-check page right now, so its listings can't be loaded here. You can open its own search results instead.`, products: [] };
  }
  let products = parseForStore(store, text);
  // Remaining pages are fetched in parallel, not one after another, so
  // gathering up to 100 listings costs roughly one page-fetch of time.
  const extra = light ? null : extraPageUrls(store, query);
  if (extra && products.length > 0) {
    const pages = await Promise.all(extra.map(async (url) => {
      try {
        const r = await fetchStoreText(store, url, store.parser === "opencartJournal");
        if (!r.ok || looksBotWalled(r.text ?? "")) return [];
        return parseForStore(store, r.text ?? "");
      } catch { return []; }
    }));
    products = mergeAcrossPages([products, ...pages]);
  }
  if (products.length === 0 && store.parser === "shopify") {
    const suggestUrl = `https://seforimdeals.com/search/suggest.json?q=${enc(query)}&resources%5Btype%5D=product&resources%5Blimit%5D=10`;
    try {
      const res = await fetch(suggestUrl, { headers: { "User-Agent": UA } });
      if (res.ok) products = parseShopifySuggest(await res.text());
    } catch { /* keep empty */ }
  }
  if (!light && store.id === "seforimdeals" && env && products.length > 0) {
    // Annotate sold-out state per product (see getDealsStock). A
    // handle whose state can't be determined stays unmarked.
    const handles = [...new Set(products.map((p) => /\/products\/([^/?#]+)/.exec(p.url || "")?.[1]).filter(Boolean))];
    if (handles.length) {
      const stock = await getDealsStock(env, ctx, handles);
      for (const p of products) {
        const h = /\/products\/([^/?#]+)/.exec(p.url || "")?.[1];
        if (h && stock[h] !== undefined) p.soldOut = stock[h] === 0;
      }
    }
  }
  if (products.length === 0) {
    return { ...base, status: "empty", message: `No listings at ${store.name} matched “${query}”.`, products: [] };
  }
  return { ...base, status: "ok", message: null, products };
}

// ---------------------------------------------------------------------------
// HTTP plumbing: CORS (the live site may send credentials for sign-in;
// any other origin gets a plain public response) and JSON responses.
// Search responses are cached for 10 minutes; sign-in and wishlist
// responses are never cached.
// ---------------------------------------------------------------------------
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
// Google sign-in + wishlist storage (KV).
// How sign-in works, briefly: the page's Google button returns a signed
// ID token, the page posts it to /auth/google, and this worker checks
// the token's signature against Google's own keys, plus its issuer,
// audience (must equal GOOGLE_CLIENT_ID), expiry, and verified email.
// No password and no client secret is involved at any point. A token
// that passes gets a random session id, stored in KV for 30 days and
// handed back as a secure, HttpOnly cookie. The wishlist is then stored
// in KV under that user's Google id — one wishlist per signed-in user,
// and nothing else about the user is kept.
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
function cleanWishlistItem(i) {
  if (!i || typeof i !== "object") return null;
  const item = {
    url: String(i.url || "").slice(0, 2000), title: String(i.title || "").slice(0, 500),
    imageUrl: i.imageUrl ? String(i.imageUrl).slice(0, 2000) : null,
    priceText: i.priceText ? String(i.priceText).slice(0, 50) : null,
    compareAtText: i.compareAtText ? String(i.compareAtText).slice(0, 50) : null,
    storeId: String(i.storeId || "").slice(0, 50), storeName: String(i.storeName || "").slice(0, 100),
    addedAt: Number.isFinite(+i.addedAt) ? +i.addedAt : 0,
  };
  return item.url && item.title ? item : null;
}
function cleanWishlistTitle(t) {
  if (typeof t === "string") return t ? { text: t.slice(0, 300), addedAt: 0 } : null;
  if (t && typeof t === "object" && t.text) {
    return { text: String(t.text).slice(0, 300), addedAt: Number.isFinite(+t.addedAt) ? +t.addedAt : 0 };
  }
  return null;
}
function cleanDeleted(d) {
  const out = { urls: {}, titles: {} };
  if (d && typeof d === "object") {
    for (const [k, v] of Object.entries(d.urls ?? {}).slice(0, 1000)) {
      const ts = +v;
      if (k && Number.isFinite(ts) && ts > 0) out.urls[String(k).slice(0, 2000)] = ts;
    }
    for (const [k, v] of Object.entries(d.titles ?? {}).slice(0, 500)) {
      const ts = +v;
      if (k && Number.isFinite(ts) && ts > 0) out.titles[String(k).toLowerCase().slice(0, 300)] = ts;
    }
  }
  return out;
}
// Wishlist shape v2: items and titles carry an addedAt stamp, and a
// "deleted" map of tombstones records removals with their time. That
// is what stops a stale browser from resurrecting an item deleted in
// another browser — the merge rule is: a tombstone newer than the
// item's addedAt wins; re-adding an item stamps a fresh addedAt and
// clears its tombstone. Older clients keep working against the legacy
// view (no addedAt, titles as plain strings), and their writes
// preserve the stored tombstones and stamps.
function normalizeWishlist(raw) {
  let obj = raw;
  if (typeof raw === "string") { try { obj = JSON.parse(raw); } catch { obj = null; } }
  if (!obj || typeof obj !== "object") obj = {};
  const items = (Array.isArray(obj.items) ? obj.items : []).map(cleanWishlistItem).filter(Boolean).slice(0, 500);
  const titles = [];
  const seenTitles = new Set();
  for (const t of Array.isArray(obj.titles) ? obj.titles : []) {
    const c = cleanWishlistTitle(t);
    if (!c) continue;
    const key = c.text.toLowerCase();
    if (seenTitles.has(key)) continue;
    seenTitles.add(key);
    titles.push(c);
    if (titles.length >= 200) break;
  }
  return { items, titles, deleted: cleanDeleted(obj.deleted) };
}
function legacyWishlistView(v2) {
  return {
    items: v2.items.map(({ addedAt, ...rest }) => rest),
    titles: v2.titles.map((t) => t.text),
  };
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
      const v2 = normalizeWishlist(raw);
      return jsonResponse(url.searchParams.get("v") === "2" ? v2 : legacyWishlistView(v2), 200, request);
    }
    if (request.method === "PUT") {
      let body;
      try { body = await request.json(); } catch { return jsonResponse({ error: "Bad request" }, 400, request); }
      const prior = normalizeWishlist(await env.SEFORIM_KV.get(`wish:${s.sub}`));
      const cleaned = normalizeWishlist(body);
      const isV2 = url.searchParams.get("v") === "2" || (body && typeof body === "object" &&
        ("deleted" in body || (Array.isArray(body.titles) && body.titles.some((t) => t && typeof t === "object"))));
      if (!isV2) {
        // A legacy client's list carries no tombstones; keep the
        // stored ones (and any known addedAt stamps) so its write
        // cannot undo a deletion made in a newer browser.
        cleaned.deleted = prior.deleted;
        const priorAdded = new Map(prior.items.map((i) => [i.url, i.addedAt]));
        for (const i of cleaned.items) if (!i.addedAt && priorAdded.has(i.url)) i.addedAt = priorAdded.get(i.url);
      }
      await env.SEFORIM_KV.put(`wish:${s.sub}`, JSON.stringify(cleaned));
      return jsonResponse(url.searchParams.get("v") === "2" ? cleaned : legacyWishlistView(cleaned), 200, request);
    }
  }
  return jsonResponse({ error: "Not found" }, 404, request);
}

// ---------------------------------------------------------------------------
// New-releases feed (the homepage "New & just in" strip) and the
// passive price log.
// ---------------------------------------------------------------------------
// The feed is built ONLY from sources that are open under safe mode:
// Hamafitz's "Just Arrived" page (its robots.txt disallows only
// pagination/sort parameters; the bare page-1 URL is what is
// requested), SeforimDeals' new-books collection (default order — its
// robots.txt disallows sort_by, so none is ever sent), and Kehot's
// "Complete New Books" department (its robots.txt is effectively
// empty). Feldheim, Greenfield, Eichler's and SeforimPlace are never
// fetched for the feed. The blob lives in KV (key "feed:new-releases")
// and refreshes lazily: a request that finds it missing or older than
// 12 hours rebuilds it, so the feed costs at most six store-page
// fetches a day however many visitors the homepage gets. Items keep
// the date they were first seen and drop off 45 days after that; the
// strip holds at most 30.

const FEED_SOURCES = [
  { storeId: "hamafitz", storeName: "Hamafitz", url: "https://hamafitz.com/index.php?route=product/module&path=34", parser: "opencartClassic", cap: 15 },
  { storeId: "seforimdeals", storeName: "SeforimDeals", url: "https://seforimdeals.com/collections/new-books-seforim-%D7%A1%D7%A4%D7%A8%D7%99%D7%9D-%D7%97%D7%93%D7%A9%D7%99%D7%9D", parser: "shopify", cap: 24 },
  { storeId: "kehot", storeName: "Kehot", url: "https://store.kehotonline.com/products.asp?dept=785&val=0&pagenumber=1", parser: "kehot", cap: 25 },
];
const FEED_TTL_MS = 12 * 3600 * 1000;
const FEED_KEEP_MS = 45 * 24 * 3600 * 1000;
// Bump when the blob's shape or balancing rules change: a stored blob
// with an older version counts as stale and is rebuilt on the next
// request, so a fix like this takes effect at once instead of up to
// 12 hours later.
const FEED_VERSION = 2;

// Balance the strip across its stores: group by store, newest first
// inside each group, then take one item from each store in turn.
// Without this, whichever source is fetched first would fill the
// whole strip on the first build, when every item shares a firstSeen.
function interleaveFeed(items) {
  const order = FEED_SOURCES.map((s) => s.storeId);
  const groups = new Map();
  for (const item of items ?? []) {
    if (!groups.has(item.storeId)) groups.set(item.storeId, []);
    groups.get(item.storeId).push(item);
  }
  for (const list of groups.values()) list.sort((a, b) => (b.firstSeen ?? 0) - (a.firstSeen ?? 0));
  const keys = [...groups.keys()].sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  const out = [];
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const k of keys) {
      const next = groups.get(k).shift();
      if (next) { out.push(next); progressed = true; }
    }
  }
  return out;
}

function parseFeedSource(src, text) {
  if (src.parser === "kehot") return parseKehot(text);
  return parseForStore({ parser: src.parser }, text);
}

async function refreshFeed(env) {
  const now = Date.now();
  let prev = { generatedAt: 0, items: [] };
  try {
    const raw = await env.SEFORIM_KV.get("feed:new-releases");
    if (raw) prev = JSON.parse(raw);
  } catch { /* start fresh */ }
  const prevByUrl = new Map((prev.items ?? []).map((i) => [i.url, i]));
  const merged = new Map();
  for (const src of FEED_SOURCES) {
    try {
      const res = await fetch(src.url, { headers: { "User-Agent": UA, "Accept": "text/html,*/*" } });
      if (!res.ok) continue;
      const text = await res.text();
      if (looksBotWalled(text)) continue;
      for (const p of parseFeedSource(src, text).slice(0, src.cap)) {
        if (!p.title || !p.url) continue;
        const old = prevByUrl.get(p.url);
        merged.set(p.url, { storeId: src.storeId, storeName: src.storeName, title: p.title, url: p.url,
          priceText: p.priceText ?? null, priceAmount: p.priceAmount ?? null,
          compareAtText: p.compareAtText ?? null, imageUrl: p.imageUrl ?? null,
          firstSeen: old?.firstSeen ?? now, lastSeen: now });
      }
    } catch { /* one source failing never sinks the feed */ }
  }
  // Items a source did not show this time (rotated off its first page,
  // or the source hiccuped) stay until they are 45 days old.
  for (const item of prev.items ?? []) {
    if (!merged.has(item.url) && now - (item.firstSeen ?? now) < FEED_KEEP_MS) merged.set(item.url, item);
  }
  const blob = { v: FEED_VERSION, generatedAt: now,
    items: [...merged.values()].sort((a, b) => (b.firstSeen ?? 0) - (a.firstSeen ?? 0)).slice(0, 60) };
  try { await env.SEFORIM_KV.put("feed:new-releases", JSON.stringify(blob)); } catch { /* serve it anyway */ }
  return blob;
}

async function getFeed(env, ctx) {
  let blob = null;
  try {
    const raw = await env.SEFORIM_KV.get("feed:new-releases");
    if (raw) blob = JSON.parse(raw);
  } catch { /* treat as missing */ }
  if (!blob || blob.v !== FEED_VERSION || Date.now() - (blob.generatedAt ?? 0) > FEED_TTL_MS) {
    const refreshing = refreshFeed(env);
    if (!blob || blob.v !== FEED_VERSION) blob = await refreshing; // nothing usable yet: wait for the build
    else if (ctx?.waitUntil) ctx.waitUntil(refreshing);            // serve the stale copy, refresh behind it
    else blob = await refreshing;
  }
  if (!blob) return { generatedAt: 0, items: [] };
  return { generatedAt: blob.generatedAt ?? 0, items: interleaveFeed(blob.items).slice(0, 30) };
}

// Passive price log: every search this worker answers anyway leaves a
// trace of the prices it saw — one KV key per store ("ph:<storeId>")
// holding { "<product url>": { title, last, lastSeen, hist } }, hist
// being recent [timestamp, price] pairs, newest last. It adds NO
// store traffic; the log is a by-product of searches already made,
// and it is the raw material for the future price-tracking and
// sale-pattern features (nothing reads it yet). Writes are kept rare
// on purpose: a store's map is written back only when a product is
// new to it, a price changed, or an entry's lastSeen is over a week
// old, and the map is pruned to its 400 most recently seen products.
async function logPrices(env, results) {
  if (!env?.SEFORIM_KV) return;
  const now = Date.now();
  for (const r of results ?? []) {
    if (r.status !== "ok" || !r.products?.length) continue;
    try {
      const key = `ph:${r.storeId}`;
      let map = {};
      const raw = await env.SEFORIM_KV.get(key);
      if (raw) map = JSON.parse(raw) ?? {};
      let changed = false;
      for (const p of r.products) {
        if (p.priceAmount == null || !p.url) continue;
        const e = map[p.url];
        if (!e) {
          map[p.url] = { title: p.title, last: p.priceAmount, lastSeen: now, hist: [[now, p.priceAmount]] };
          changed = true;
        } else if (e.last !== p.priceAmount) {
          e.hist = [...(e.hist ?? []), [now, p.priceAmount]].slice(-20);
          e.last = p.priceAmount; e.lastSeen = now; e.title = p.title;
          changed = true;
        } else if (now - (e.lastSeen ?? 0) > 7 * 24 * 3600 * 1000) {
          e.lastSeen = now;
          changed = true;
        }
      }
      if (!changed) continue;
      const entries = Object.entries(map)
        .sort((a, b) => (b[1].lastSeen ?? 0) - (a[1].lastSeen ?? 0)).slice(0, 400);
      await env.SEFORIM_KV.put(key, JSON.stringify(Object.fromEntries(entries)));
    } catch { /* logging must never break a search */ }
  }
}

// ---------------------------------------------------------------------------
// SeforimDeals stock map (sold-out badges)
// ---------------------------------------------------------------------------
// Zakkai, 2026-11-03: the card must say when an item is sold out at a
// store. Shopify's search page carries no per-product availability,
// but each product's public .js JSON does ("available"), so the
// worker checks just the products a search actually returned and
// caches each handle's state in KV for ~6 hours. (A whole-catalog
// crawl was tried first and dropped: the catalog runs past 6,000
// products, so a full map could never be completed or kept fresh.)
// A handle whose state can't be determined is left unmarked rather
// than guessed. eSicha reports stock live in its own API
// (parseWooStoreApi). Z. Berman's and Hamafitz's search pages expose
// no stock signal at all, so their cards stay unmarked for now —
// never a guessed badge.
// ---------------------------------------------------------------------------
const STOCK_TTL_MS = 6 * 60 * 60 * 1000;
const STOCK_MAX_FETCH = 40;
async function getDealsStock(env, ctx, handles) {
  const out = {};
  const stale = [];
  await Promise.all(handles.map(async (h) => {
    try {
      const raw = await env.SEFORIM_KV.get(`stock1:${h}`);
      if (raw) {
        const v = JSON.parse(raw);
        if (Date.now() - (v.ts ?? 0) < STOCK_TTL_MS && (v.s === 0 || v.s === 1)) { out[h] = v.s; return; }
      }
    } catch { /* treat as unknown */ }
    stale.push(h);
  }));
  const toFetch = stale.slice(0, STOCK_MAX_FETCH);
  if (toFetch.length) {
    const fetched = await Promise.all(toFetch.map(async (h) => {
      try {
        const res = await fetch(`https://seforimdeals.com/products/${encodeURIComponent(h)}.js`, { headers: { "User-Agent": UA } });
        if (!res.ok) return null;
        const data = await res.json();
        return typeof data?.available === "boolean" ? (data.available ? 1 : 0) : null;
      } catch { return null; }
    }));
    const puts = [];
    toFetch.forEach((h, i) => {
      if (fetched[i] === null) return;
      out[h] = fetched[i];
      puts.push(env.SEFORIM_KV.put(`stock1:${h}`, JSON.stringify({ s: fetched[i], ts: Date.now() })).catch(() => {}));
    });
    if (puts.length) {
      if (ctx?.waitUntil) ctx.waitUntil(Promise.all(puts));
      else await Promise.all(puts);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Chatbot prototype (Cloudflare Workers AI — no external account)
// ---------------------------------------------------------------------------
// POST /chat { question } -> { answer }. The prototype is grounded in
// the store listings only: the question is turned into a store search,
// the closest-matching listings are handed to the model as its ONLY
// facts, and the system prompt forbids inventing anything beyond
// them. Questions the listings can't answer — history, authorship,
// what a sefer contains — get an honest "the prototype can't verify
// that yet". The wider source layers (ChabadLibrary, HebrewBooks, and
// Sefaria used silently with Frum sources only, per the owner's rule)
// are a later step, as is a stronger paid model if this free one's
// Hebrew/Aramaic proves weak. Cost control: Workers AI's free daily
// allowance is the budget, and KV counters cap the endpoint anyway —
// 150 questions a day overall, 20 per visitor — so the prototype can
// never run up a bill.

// Model note: @cf/meta/llama-3.1-8b-instruct was deprecated by
// Cloudflare (the binding refuses it); the 70B fast model below is
// current and noticeably better with Hebrew. If it ever starts
// erroring the same way, check the Workers AI model catalog.
const CHAT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const CHAT_DAILY_CAP = 150;
const CHAT_IP_DAILY_CAP = 20;

const CHAT_STOPWORDS = new Set(("what who whom when where why how is are was were the a an of in on for to and or " +
  "does do did can could should would i you he she it they we me my your his her their our this that these those " +
  "sefer seforim book books set sets volume volumes vol edition editions price cost much many available stock " +
  "store stores sell sells author wrote written published year date history historical technical details detail " +
  "about tell please find show compare difference different between vs versus").split(" "));

function chatSearchTerms(question) {
  const toks = String(question || "").split(/[^A-Za-z\u0590-\u05FF0-9-]+/).filter(Boolean);
  const kept = toks.filter((tk) => /[\u0590-\u05FF]/.test(tk) || !CHAT_STOPWORDS.has(tk.toLowerCase()));
  return kept.slice(0, 6).join(" ");
}

async function chatCount(env, key) {
  try {
    const n = parseInt((await env.SEFORIM_KV.get(key)) || "0", 10);
    return Number.isFinite(n) ? n : 0;
  } catch { return 0; }
}

// ---------------------------------------------------------------------------
// Chat grounding helpers: product-page details + ChabadLibrary sources
// ---------------------------------------------------------------------------
// The first chat version grounded answers in listing titles and
// prices only, which cannot answer "what is the difference between
// X and Y" — the model could see two titles and nothing else. These
// helpers fetch two more fact layers, each fail-silent:
//  (a) the top listings' own product pages (publisher/vendor,
//      description, variant options) from the stores the site
//      already works with, and
//  (b) ChabadLibrary phrase search over the Rebbe's seforim and
//      Likkutei Sichos (public API; see AGENTS.md) — real excerpts,
//      each with its sefer > section breadcrumb and a public link.
// ---------------------------------------------------------------------------
function stripHtmlText(s, cap) {
  return String(s || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim().slice(0, cap || 700);
}

async function fetchTextTimeout(url, ms) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms || 4500);
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html,application/json" },
      signal: ctrl.signal, redirect: "follow",
    });
    clearTimeout(timer);
    if (!res.ok) return "";
    return await res.text();
  } catch { return ""; }
}

// ---------------------------------------------------------------------------
// Quick view: GET /product?url=<store product URL> returns the store's
// own gallery images and description for that product, so a card's eye
// button can show them without leaving the site. Only known store
// hosts are fetched (this is not a general proxy), results are cached
// in KV for a week, and prices are deliberately NOT included — the
// card already shows the live search price, and a cached price here
// would go stale.
// ---------------------------------------------------------------------------
const PRODUCT_HOSTS = new Set([
  "zbermanbooks.com", "www.zbermanbooks.com",
  "seforimdeals.com", "www.seforimdeals.com",
  "seforimplace.com", "www.seforimplace.com",
  "hamafitz.com", "www.hamafitz.com",
  "greenfieldjudaica.com", "www.greenfieldjudaica.com",
  "esicha.org", "www.esicha.org",
  "store.kehotonline.com",
]);
const PRODUCT_CACHE_TTL_MS = 7 * 24 * 3600 * 1000;

function fnvHash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}

// Like stripHtmlText, but keeps paragraph breaks so the modal can
// render the store's description as paragraphs.
function htmlToParagraphs(html, cap) {
  const text = String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim()).filter(Boolean).join("\n");
  return text.slice(0, cap || 3000);
}

function productImagesFromHtml(html, baseUrl) {
  const out = [];
  const seen = new Set();
  const push = (raw) => {
    if (!raw || typeof raw !== "string") return;
    let abs;
    try { abs = new URL(raw.replace(/&amp;/g, "&"), baseUrl).toString(); } catch { return; }
    if (!/^https:/.test(abs) || seen.has(abs)) return;
    if (/(logo|icon|sprite|payment|badge|pixel|spacer|blank|loading|favicon)/i.test(abs)) return;
    if (/(_small|_thumb|_compact|50x|100x)\.(jpe?g|png|webp)/i.test(abs)) return;
    seen.add(abs);
    out.push(abs);
  };
  // Structured data first — it names the product's own photos.
  for (const m of html.matchAll(/"image"\s*:\s*(\[[^\]]*\]|"(?:[^"\\]|\\.)*")/g)) {
    try {
      const v = JSON.parse(m[1]);
      if (Array.isArray(v)) v.forEach(push); else push(v);
    } catch { /* not valid JSON — skip */ }
  }
  const og = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i) ||
    html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:image"/i);
  if (og) push(og[1]);
  // Then the page's own <img> tags, keeping product-photo-shaped URLs.
  for (const m of html.matchAll(/<img\b[^>]*?(?:src|data-src)="([^"]+)"/gi)) {
    const raw = m[1];
    if (/(cdn\/shop\/files|\/media\/catalog\/|image\/cache\/catalog\/|\/images\/|wp-content\/uploads|\/ProductImages|\/products\/)/i.test(raw)) push(raw);
  }
  return out.slice(0, 10);
}

// Page furniture that follows the description inside a container
// slice (review forms, spec tables, related items). The description
// ends at the first such line.
const DESC_CUT_LINES = /^(Write a review|Your Name|Your Review|Reviews?|Related Products?|Tags:|Availability:|Reward Points|Ex Tax:|Note: HTML|Customers? who bought|You may also like|Description\s*$)/i;
function cutDescription(text) {
  const lines = String(text || "").split("\n");
  const cut = lines.findIndex((l) => DESC_CUT_LINES.test(l.trim()));
  return (cut >= 0 ? lines.slice(0, cut) : lines).join("\n").trim();
}

function productDescriptionFromHtml(html) {
  const markers = [
    'id="tab-description"', "woocommerce-Tabs-panel--description",
    "product attribute description", 'id="ProductDescription"',
    "product-description", "short-description",
  ];
  for (const marker of markers) {
    const idx = html.indexOf(marker);
    if (idx < 0) continue;
    // Start after the tag that carries the marker, so its attributes
    // don't leak into the text.
    const tagEnd = html.indexOf(">", idx);
    const start = tagEnd > idx && tagEnd - idx < 500 ? tagEnd + 1 : idx;
    const text = cutDescription(htmlToParagraphs(html.slice(start, start + 12000), 6000)).slice(0, 3000);
    // Very short results mean the marker was a nav/tab label rather
    // than the panel itself.
    if (text.length >= 60) return text;
  }
  const ld = html.match(/"description"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (ld) {
    try {
      const text = htmlToParagraphs(JSON.parse(`"${ld[1]}"`), 3000);
      if (text.length >= 40) return text;
    } catch { /* fall through to meta */ }
  }
  const meta = html.match(/<meta[^>]+(?:name|property)="(?:description|og:description)"[^>]+content="([^"]+)"/i) ||
    html.match(/<meta[^>]+content="([^"]+)"[^>]+(?:name|property)="(?:description|og:description)"/i);
  return meta ? htmlToParagraphs(meta[1], 3000) : "";
}

async function handleProduct(request, env, ctx) {
  const target = (new URL(request.url).searchParams.get("url") || "").trim();
  let u;
  try { u = new URL(target); } catch { return jsonResponse({ error: "Bad url" }, 400, request); }
  if (u.protocol !== "https:" || !PRODUCT_HOSTS.has(u.hostname)) {
    return jsonResponse({ error: "Store not supported for quick view" }, 400, request);
  }
  // Bump the pv<N> prefix when the extractors change, so cached
  // extractions from an older, buggier version are not served.
  const cacheKey = `pv2:${fnvHash(u.toString())}`;
  if (env.SEFORIM_KV) {
    try {
      const raw = await env.SEFORIM_KV.get(cacheKey);
      if (raw) {
        const v = JSON.parse(raw);
        if (Date.now() - (v.ts || 0) < PRODUCT_CACHE_TTL_MS) {
          return jsonResponse({ url: u.toString(), title: v.title || "", images: v.images || [], description: v.description || "" }, 200, request);
        }
      }
    } catch { /* treat as a miss */ }
  }
  let title = "";
  let images = [];
  let description = "";
  try {
    if (u.hostname.includes("seforimdeals.com") && u.pathname.startsWith("/products/")) {
      const raw = await fetchTextTimeout(`${u.origin}${u.pathname}.js`, 5000);
      if (raw) {
        const j = JSON.parse(raw);
        title = cleanText(j.title || "");
        if (Array.isArray(j.images)) {
          images = j.images.map((im) => (typeof im === "string" ? im : im?.src)).filter(Boolean).slice(0, 10);
        } else if (j.image) {
          images = [typeof j.image === "string" ? j.image : j.image.src].filter(Boolean);
        }
        description = htmlToParagraphs(j.description || "", 3000);
      }
    }
    if (!images.length || !description) {
      const html = await fetchTextTimeout(u.toString(), 6000);
      if (html) {
        if (!title) {
          const ogt = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i);
          title = ogt ? stripHtmlText(ogt[1], 200) : "";
        }
        if (!images.length) images = productImagesFromHtml(html, u.toString());
        if (!description) description = productDescriptionFromHtml(html);
      }
    }
  } catch { /* return whatever was gathered */ }
  if (!images.length && !description) {
    return jsonResponse({ error: "No details found at the store" }, 502, request);
  }
  if (env.SEFORIM_KV && ctx) {
    ctx.waitUntil(env.SEFORIM_KV.put(cacheKey, JSON.stringify({ title, images, description, ts: Date.now() })).catch(() => {}));
  }
  return jsonResponse({ url: u.toString(), title, images, description }, 200, request);
}

async function chatProductDetail(p) {
  try {
    const u = new URL(p.url);
    if (u.hostname.includes("seforimdeals.com") && u.pathname.startsWith("/products/")) {
      const raw = await fetchTextTimeout(`${u.origin}${u.pathname}.js`, 4000);
      if (raw) {
        const j = JSON.parse(raw);
        const parts = [];
        if (j.vendor) parts.push(`publisher/vendor: ${j.vendor}`);
        const desc = stripHtmlText(j.description || "", 650);
        if (desc) parts.push(desc);
        if (Array.isArray(j.variants) && j.variants.length > 1) {
          parts.push(`variants: ${j.variants.slice(0, 6).map((v) => v.title).join(" / ")}`);
        }
        if (parts.length) return parts.join(" — ");
      }
    }
    const html = await fetchTextTimeout(p.url, 4500);
    if (!html) return "";
    const meta = html.match(/<meta[^>]+(?:name|property)="(?:description|og:description)"[^>]+content="([^"]+)"/i) ||
      html.match(/<meta[^>]+content="([^"]+)"[^>]+(?:name|property)="(?:description|og:description)"/i);
    let desc = meta ? stripHtmlText(meta[1], 650) : "";
    if (!desc) {
      const ld = html.match(/"description"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (ld) desc = stripHtmlText(ld[1].replace(/\\n/g, " ").replace(/\\"/g, '"'), 650);
    }
    return desc;
  } catch { return ""; }
}

const CHAT_HEBREW_STOPWORDS = new Set(["מי", "מה", "מתי", "למה", "איך", "האם", "כמה", "את", "על", "של", "הוא", "היא", "כתב", "חיבר", "נדפס", "הוציא", "בין", "לבין"]);

async function chatLibrarySources(question) {
  const runs = (String(question || "").match(/[\u0590-\u05FF][\u0590-\u05FF"׳״' -]*/g) || [])
    .map((s) => s.trim()).filter((s) => s.length >= 2);
  // Phrase search is exact: question words ("who wrote the…") match
  // nothing, so drop them and search the sefer terms that remain —
  // "מי כתב את ספר התניא" becomes the phrase "ספר התניא".
  const words = runs.length
    ? runs.join(" ").split(/\s+/).filter((w) => !CHAT_HEBREW_STOPWORDS.has(w))
    : [];
  const phrase = words.slice(0, 3).join(" ");
  if (!phrase) return [];
  const out = [];
  for (const section of ["1100000000", "1300000000"]) {
    if (out.length >= 3) break;
    const raw = await fetchTextTimeout(
      `https://chabadlibrary.org/books/api/search?phrase=${encodeURIComponent(phrase)}&section_id=${section}&offset=0`, 5000);
    if (!raw) continue;
    try {
      const j = JSON.parse(raw);
      for (const r of (j.results || []).slice(0, 2)) {
        const text = stripHtmlText(r.text || "", 420);
        if (!text) continue;
        out.push(`- From ${r.tree || "ChabadLibrary"}: "${text}" — https://chabadlibrary.org/books/${r.mafteach_id}`);
        if (out.length >= 3) break;
      }
    } catch { /* ignore */ }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Match check for grouped cards (Workers AI)
// ---------------------------------------------------------------------------
// POST /match { pairs: [{a:{title,store,price}, b:{...}}] } ->
// { verdicts: [{ i, same }] }, where i is the pair's index in the
// request. The site's rule-based grouper (app.js) settles the clear
// cases itself; pairs it cannot settle — same core title, but a
// detail missing on one side — are sent here, and the model judges
// whether the two listings are the same sefer in the same edition
// and format. Hard conflicts (different stated volume counts or size
// classes) never reach this endpoint, and the client never lets a
// verdict override them. The client caches verdicts per title pair.
// A daily cap protects the free AI allowance; over the cap the
// endpoint returns no verdicts and the rules simply stand.
// ---------------------------------------------------------------------------
const MATCH_DAILY_CAP = 400;
const MATCH_MAX_PAIRS = 16;
async function handleMatch(request, env, ctx) {
  const noStore = { "Cache-Control": "no-store" };
  if (request.method !== "POST") return jsonResponse({ error: "POST only" }, 405, request, noStore);
  if (!env.AI) return jsonResponse({ verdicts: [] }, 200, request, noStore);
  let pairs = [];
  try {
    const body = await request.json();
    if (Array.isArray(body?.pairs)) {
      pairs = body.pairs.slice(0, MATCH_MAX_PAIRS)
        .map((pr, i) => ({ a: pr?.a, b: pr?.b, i }))
        .filter((pr) => pr.a?.title && pr.b?.title);
    }
  } catch { /* no usable pairs */ }
  if (!pairs.length) return jsonResponse({ verdicts: [] }, 200, request, noStore);
  if (env.SEFORIM_KV) {
    const day = new Date().toISOString().slice(0, 10);
    const key = `match:day:${day}`;
    let used = 0;
    try { used = parseInt(await env.SEFORIM_KV.get(key), 10) || 0; } catch { /* ignore */ }
    if (used + pairs.length > MATCH_DAILY_CAP) return jsonResponse({ verdicts: [] }, 200, request, noStore);
    if (ctx?.waitUntil) ctx.waitUntil(env.SEFORIM_KV.put(key, String(used + pairs.length), { expirationTtl: 2 * 24 * 3600 }).catch(() => {}));
  }
  const listing = (x) => `"${String(x.title).slice(0, 160)}" (${x.store || "store"}${x.price ? `, ${x.price}` : ""})`;
  const userMsg = pairs.map((pr, k) => `${k + 1}. A: ${listing(pr.a)}\n   B: ${listing(pr.b)}`).join("\n");
  const system = [
    "You compare pairs of Jewish bookstore listings and decide whether the two listings in each pair are the SAME sefer in the SAME edition and format:",
    "same work, same publisher/edition, same number of volumes, same size, same binding.",
    "A title may be in Hebrew in one listing and transliterated English in the other — that alone does not make them different books.",
    "Store dressing differs (words like 'set', 'vol.', publisher names added or dropped); look past it.",
    "An author's name appended to one title only — at the end, after a dash, or after 'by' — is also dressing: the same sefer, not a different book.",
    "But a subtitle naming a volume's TOPIC or TRACTATE (for example 'on Bava Kama', 'Musach HaShabbos', a siman range) is a real difference between volumes — answer false for those.",
    "If any stated detail conflicts — different volume counts, different sizes, different bindings — or you cannot tell, answer false for that pair.",
    "Reply with ONLY a JSON array of true/false values, one per pair, in order. No other text.",
  ].join(" ");
  try {
    const out = await env.AI.run(CHAT_MODEL, {
      messages: [{ role: "system", content: system }, { role: "user", content: userMsg }],
      max_tokens: 120,
    });
    const text = String(out?.response ?? out?.choices?.[0]?.message?.content ?? out?.result?.response ?? out?.result?.choices?.[0]?.message?.content ?? "");
    // The model is told to answer with a bare JSON array, but it may
    // capitalize True/False or wrap the array in prose. Parse strictly
    // first, then fall back to scanning for true/false tokens when
    // their count matches the number of pairs exactly.
    let arr = null;
    const m = /\[[\s\S]*\]/.exec(text);
    if (m) {
      try {
        const parsed = JSON.parse(m[0].replace(/\bTrue\b/g, "true").replace(/\bFalse\b/g, "false"));
        if (Array.isArray(parsed)) arr = parsed;
      } catch { /* fall through to the token scan */ }
    }
    if (!arr) {
      const tokens = (text.match(/true|false/gi) || []).map((t) => t.toLowerCase() === "true");
      if (tokens.length === pairs.length) arr = tokens;
    }
    if (!arr) return jsonResponse({ verdicts: [] }, 200, request, noStore);
    const verdicts = [];
    pairs.forEach((pr, k) => { if (typeof arr[k] === "boolean") verdicts.push({ i: pr.i, same: arr[k] }); });
    return jsonResponse({ verdicts }, 200, request, noStore);
  } catch {
    return jsonResponse({ verdicts: [] }, 200, request, noStore);
  }
}

async function handleChat(request, env, ctx) {
  const noStore = { "Cache-Control": "no-store" };
  if (request.method !== "POST") return jsonResponse({ error: "POST only" }, 405, request, noStore);
  if (!env.AI) return jsonResponse({ error: "The chat prototype is not switched on yet." }, 503, request, noStore);
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "Bad request" }, 400, request, noStore); }
  const question = String(body?.question || "").trim().slice(0, 500);
  if (!question) return jsonResponse({ error: "Ask a question first." }, 400, request, noStore);

  // Daily caps, counted in KV by UTC day.
  const day = new Date().toISOString().slice(0, 10);
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  let ipHash = 0;
  for (const ch of ip) ipHash = (ipHash * 31 + ch.charCodeAt(0)) >>> 0;
  const ipKey = `chat:ip:${day}:${ipHash.toString(16)}`;
  if (env.SEFORIM_KV) {
    const total = await chatCount(env, `chat:day:${day}`);
    const mine = await chatCount(env, ipKey);
    if (total >= CHAT_DAILY_CAP || mine >= CHAT_IP_DAILY_CAP) {
      return jsonResponse({ answer: "The chat prototype has reached its daily limit — please try again tomorrow. Searching the site works as usual." }, 200, request, noStore);
    }
    await env.SEFORIM_KV.put(`chat:day:${day}`, String(total + 1), { expirationTtl: 172800 });
    await env.SEFORIM_KV.put(ipKey, String(mine + 1), { expirationTtl: 172800 });
  }

  // Grounding: search the stores with the question's key terms and
  // keep the closest-matching listings as the model's only facts.
  // (These searches also feed the passive price log, like any other.)
  let contextLines = [];
  let topListings = [];
  const terms = chatSearchTerms(question);
  if (terms) {
    try {
      const results = await Promise.all(STORES.map((s) => searchStoreWorker(s, terms, env, ctx, { light: true })));
      if (ctx?.waitUntil) ctx.waitUntil(logPrices(env, results));
      const words = terms.toLowerCase().split(/\s+/);
      const scored = [];
      for (const r of results) {
        if (r.status !== "ok") continue;
        for (const p of r.products) {
          const lt = p.title.toLowerCase();
          const score = words.reduce((n, w) => n + (lt.includes(w) ? 1 : 0), 0);
          scored.push({ p, storeName: r.storeName, score });
        }
      }
      scored.sort((a, b) => b.score - a.score || ((a.p.priceAmount ?? 1e9) - (b.p.priceAmount ?? 1e9)));
      topListings = scored.slice(0, 8);
      contextLines = topListings.map(({ p, storeName }) =>
        `- ${p.title} — ${storeName}: ${p.priceText || "price shown at the store"}${p.compareAtText ? ` (list price ${p.compareAtText})` : ""}${p.soldOut ? " — SOLD OUT at this store" : ""} — ${p.url}`);
    } catch { /* no context; the prompt below handles that case */ }
  }

  // Second grounding layer: product-page details for the closest
  // listings, and ChabadLibrary excerpts when the question carries
  // Hebrew sefer terms. Both run in parallel under a deadline — if
  // they are slow, the answer proceeds from the listings alone
  // rather than timing out (a Hebrew question timed out without
  // this guard).
  let sourceLines = [];
  const plainLines = [...contextLines];
  try {
    const enrich = (async () => {
      const [details, sources] = await Promise.all([
        Promise.all(topListings.slice(0, 4).map(({ p }) => chatProductDetail(p))),
        chatLibrarySources(question),
      ]);
      return { details, sources };
    })();
    const deadline = new Promise((resolve) => setTimeout(() => resolve(null), 9000));
    const got = await Promise.race([enrich, deadline]);
    if (got) {
      got.details.forEach((d, i) => { if (d) contextLines[i] += `\n  Details: ${d}`; });
      sourceLines = got.sources;
    }
  } catch { /* listings-only context still stands */ }

  const system = [
    "You are the chat assistant for Seforim Search, a site that searches Jewish bookstores (seforim stores). This is a prototype.",
    "Answer ONLY from the facts provided below: store listings (some with product-page details) and, when present, source excerpts. Never invent a price, a volume count, a publisher, an author, a date, or any other fact.",
    "When comparing seforim or explaining the difference between them, use only the details actually stated — title, volumes, size, publisher/vendor, description, price, stock — and say which relevant details are not stated.",
    "When you use a listing, name its store. When you use a source excerpt, name the sefer and section it comes from and include its link.",
    "If the provided facts do not answer the question, say plainly what you could not verify instead of guessing.",
    "Keep answers focused: usually two to five sentences, or a short list when comparing. Answer in the language the question was asked in.",
    "Prices are the stores' current listing prices and can change; say so when an answer turns on a price.",
  ].join(" ");
  const listingsPart = `Question: ${question}\n\nListings found${terms ? ` for "${terms}"` : ""}:\n`;
  const userMsg = listingsPart + (contextLines.length ? contextLines.join("\n") : "(none)") +
    (sourceLines.length ? `\n\nSource excerpts:\n${sourceLines.join("\n")}` : "");
  const plainMsg = listingsPart + (plainLines.length ? plainLines.join("\n") : "(none)");
  // Workers AI answers in one of two shapes depending on the model:
  // the classic { response } or an OpenAI-style chat completion
  // ({ choices: [{ message: { content } }] }). Read both.
  const askModel = async (msg) => {
    const out = await env.AI.run(CHAT_MODEL, {
      messages: [{ role: "system", content: system }, { role: "user", content: msg }],
      // 320, not more: at 550 the binding call timed out on questions
      // whose answers enumerate many listings (tanya, siddur) while
      // short answers passed — generation length was the difference.
      max_tokens: 320,
    });
    const text = String(
      out?.response ||
      out?.choices?.[0]?.message?.content ||
      out?.result?.response ||
      out?.result?.choices?.[0]?.message?.content ||
      ""
    ).trim();
    if (!text) throw new Error("empty answer");
    return text;
  };
  try {
    return jsonResponse({ answer: await askModel(userMsg) }, 200, request, noStore);
  } catch {
    // One retry on the shorter listings-only context before giving up.
    try {
      return jsonResponse({ answer: await askModel(plainMsg) }, 200, request, noStore);
    } catch {
      return jsonResponse({ error: "The chat prototype could not answer just now — please try again." }, 502, request, noStore);
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point. /auth/* and /api/* are sign-in and wishlist routes (see
// handleAuth); /stores lists the stores; anything else with ?q= runs a
// search across the included stores (or one store with &store=<id>).
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/auth/") || url.pathname.startsWith("/api/")) {
      return handleAuth(request, env, url);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }
    if (url.pathname === "/chat") {
      return handleChat(request, env, ctx);
    }
    if (url.pathname === "/match") {
      return handleMatch(request, env, ctx);
    }
    if (url.pathname === "/product") {
      return handleProduct(request, env, ctx);
    }
    if (url.pathname === "/stores") {
      return jsonResponse({ stores: STORES.map((s) => ({ id: s.id, name: s.name, note: s.note ?? null })) }, 200, request);
    }
    if (url.pathname === "/new-releases") {
      if (!env.SEFORIM_KV) return jsonResponse({ generatedAt: 0, items: [] }, 200, request);
      return jsonResponse(await getFeed(env, ctx), 200, request);
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
    const results = await Promise.all(stores.map((s) => searchStoreWorker(s, q, env, ctx)));
    if (ctx?.waitUntil) ctx.waitUntil(logPrices(env, results));
    const response = jsonResponse({ query: q, results });
    if (cache && ctx?.waitUntil) {
      const toCache = response.clone();
      ctx.waitUntil(cache.put(cacheKey, toCache));
    }
    return response;
  },
};
