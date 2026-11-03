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
function targetUrlFor(store, query) {
  if (store.parser === "wooStoreApi") {
    return `https://www.esicha.org/wp-json/wc/store/v1/products?search=${enc(query)}&per_page=${MAX_PER_STORE}`;
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
async function searchStoreWorker(store, query) {
  const base = { storeId: store.id, storeName: store.name, searchUrl: store.searchUrl(query) };
  // Magento gets one big request instead of paging: its limit parameter
  // is honoured by the Magento stores.
  const firstUrl = store.parser === "magento"
    ? `${store.searchUrl(query)}&product_list_limit=${MAX_PER_STORE}`
    : targetUrlFor(store, query);
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
  const extra = extraPageUrls(store, query);
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
    const results = await Promise.all(stores.map((s) => searchStoreWorker(s, q)));
    if (ctx?.waitUntil) ctx.waitUntil(logPrices(env, results));
    const response = jsonResponse({ query: q, results });
    if (cache && ctx?.waitUntil) {
      const toCache = response.clone();
      ctx.waitUntil(cache.put(cacheKey, toCache));
    }
    return response;
  },
};
