// workspace/ts-spaces/seforim-search-public/client/src/stores.ts
var enc = (q) => encodeURIComponent(q);
var STORES = [
  {
    id: "eichlers",
    name: "Eichler's",
    parser: "magento",
    searchUrl: (q) => `https://www.eichlers.com/catalogsearch/result/?q=${enc(q)}`
  },
  {
    id: "feldheim",
    name: "Feldheim",
    parser: "magento",
    searchUrl: (q) => `https://www.feldheim.com/catalogsearch/result/?q=${enc(q)}`
  },
  {
    id: "zberman",
    name: "Z. Berman Books",
    parser: "magento",
    searchUrl: (q) => `https://zbermanbooks.com/catalogsearch/result/?q=${enc(q)}`
  },
  {
    id: "seforimdeals",
    name: "SeforimDeals",
    parser: "shopify",
    searchUrl: (q) => `https://seforimdeals.com/search?q=${enc(q)}`
  },
  {
    id: "seforimplace",
    name: "SeforimPlace",
    parser: "opencartJournal",
    searchUrl: (q) => `https://seforimplace.com/index.php?route=product/search&search=${enc(q)}`
  },
  {
    id: "hamafitz",
    name: "Hamafitz",
    parser: "opencartClassic",
    searchUrl: (q) => `https://www.hamafitz.com/index.php?route=product/search&search=${enc(q)}`
  },
  {
    id: "greenfield",
    name: "Greenfield Judaica",
    parser: "volusion",
    searchUrl: (q) => `https://www.greenfieldjudaica.com/search.asp?search=${enc(q)}`
  },
  {
    id: "esicha",
    name: "eSicha",
    note: "sichos publications",
    parser: "wooStoreApi",
    searchUrl: (q) => `https://www.esicha.org/?s=${enc(q)}`
  }
];
var MAX_PER_STORE = 24;
// ---------------------------------------------------------------------------
// Fetching back-end (Cloudflare Worker). Deploy worker.js (see README.md)
// and put its URL here, e.g. "https://seforim-search.<you>.workers.dev".
// While this is empty, the site falls back to direct browser fetching
// (which most stores block via CORS) plus the link-out button.
// ---------------------------------------------------------------------------
var WORKER_URL = "";
// ---------------------------------------------------------------------------
// Transliteration spelling variants. Applied per word, not just to the
// whole query: searching "midrash rabbah" also searches "medrash rabbah",
// "midrashim", etc. Results are merged and deduplicated by product URL.
// ---------------------------------------------------------------------------
var VARIANT_GROUPS = [
  ["midrash", "medrash", "midrashim", "medrashim", "midresh", "medresh"],
  ["mishnah", "mishna", "mishnayos", "mishnayoth", "mishnayot"],
  ["chumash", "humash", "chumosh", "chumashim"],
  ["gemara", "gemorah", "gemora", "gemaros"],
  ["talmud", "talmudic"],
  ["halacha", "halacha", "halachos", "halakha", "halakhot", "halochos", "halochah"],
  ["tefillah", "tefila", "tefillot", "tefilos"],
  ["siddur", "siddurim", "siddurim"],
  ["machzor", "machzorim", "machzorim"],
  ["sefer", "seforim", "seferim", "sefer"],
  ["shulchan", "shulchan"],
  ["aruch", "oruch", "arukh"],
  ["rashi", "rashi"],
  ["rambam", "rambam"],
  ["tanya", "tanya"],
  ["kabbalah", "kabbala", "kabala"],
  ["mussar", "musar"],
  ["aggadah", "agada", "aggada", "aggadot"],
  ["berurah", "berura", "berurah"],
  ["brachot", "brochos", "brachos", "berachot", "berachos"],
  ["shabbos", "shabbat", "shabbath", "shabbos"],
  ["pesach", "passover", "pesah"],
  ["sukkah", "succah", "sukkot", "succos"],
  ["tehillim", "tehilim", "tehillim"],
  ["nach", "tanach", "tanakh"],
  ["avot", "avos", "pirkei avot", "pirkei avos"],
  ["yom", "yom"],
  ["kiddush", "kidush"],
  ["taharah", "tahara", "taharos"],
  ["tzitzit", "tzitzis", "tzitzith"],
  ["mezuzah", "mezuza", "mezuzot"],
  ["chanukah", "hanukkah", "chanuka", "hanuka"],
  ["purim", "purim"],
  ["rosh", "rosh"],
  ["hashanah", "hashana", "hashanah"],
  ["kippur", "kippur"],
  ["mishneh", "mishne", "mishneh torah"],
  ["torah", "torah", "tora"],
  ["neviim", "neviim", "neviim"],
  ["kesuvim", "kesuvim", "ksuvim"],
  ["parsha", "parsha", "parshah", "parshas", "parshat"],
  ["rebbe", "rebbe", "rebbi"],
  ["tzaddik", "tzadik", "tzaddikim", "tzadikim"],
  ["chassidus", "hasidus", "chassidut", "chasidus"],
  ["likkutei", "likutei", "likkutey", "likkutei"],
  ["sichos", "sichot", "sichos"],
  ["shul", "shul"],
  ["minhag", "minhog", "minhagim", "minhogim"],
  ["mitzvah", "mitzva", "mitzvot", "mitzvos"],
  ["yeshiva", "yeshivah", "yeshiva"],
  ["rabbi", "rav", "rebbe"],
  ["gaon", "goan"],
  ["kitzur", "kitzur"],
  ["orech", "orech"],
  ["chayim", "chaim", "hayim"],
  ["ohr", "or", "ohr"],
  ["zohar", "zohar"],
  ["taanit", "taanis", "taanith"],
  ["megillah", "megila", "megillas", "megilot"],
  ["esther", "esther"],
  ["daniel", "daniel"],
  ["ezra", "ezra"],
  ["nechemiah", "nechemia", "nehemiah"],
];
function variantMap() {
  const map = new Map();
  for (const group of VARIANT_GROUPS) {
    for (const word of group) {
      if (!map.has(word)) map.set(word, new Set(group));
      else for (const w of group) map.get(word).add(w);
    }
  }
  return map;
}
var VARIANT_MAP = variantMap();
function expandQuery(query) {
  const words = String(query || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [query];
  const perWord = words.map((w) => {
    const alts = VARIANT_MAP.get(w);
    return alts ? [w, ...[...alts].filter((a) => a !== w)] : [w];
  });
  const combos = [""];
  for (const alts of perWord) {
    const next = [];
    for (const base of combos) {
      for (const a of alts) next.push(base ? `${base} ${a}` : a);
    }
    combos.splice(0, combos.length, ...next.slice(0, 12));
  }
  const seen = new Set();
  const out = [];
  for (const c of combos) {
    if (!seen.has(c)) { seen.add(c); out.push(c); }
  }
  if (out.length === 0 || out[0] !== query.trim().toLowerCase()) out.unshift(query.trim());
  return out.slice(0, 12);
}
function mergeProducts(listOfLists) {
  const seen = new Set();
  const out = [];
  for (const list of listOfLists) {
    for (const p of list) {
      const key = p.url || p.title;
      if (seen.has(key)) continue;
      seen.add(key); out.push(p);
    }
  }
  return out.slice(0, MAX_PER_STORE);
}
function decodeEntities(s) {
  return s.replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10))).replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
}
function cleanText(s) {
  return decodeEntities(s.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}
function money(amount) {
  return `$${amount.toFixed(2)}`;
}
function parseDollarText(text) {
  const m = text.match(/\$\s?([\d,]+(?:\.\d{2})?)/);
  if (!m?.[1])
    return null;
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
  const candidates = [
    attr("data-original"),
    attr("data-src"),
    attr("data-lazy-src"),
    attr("src")
  ];
  for (const c of candidates) {
    if (!c)
      continue;
    const v = decodeEntities(c).trim();
    if (v.startsWith("data:image"))
      continue;
    if (/pixel|placeholder|no-image|blank\.gif|spacer/i.test(v))
      continue;
    if (v.startsWith("//"))
      return `https:${v}`;
    if (v.startsWith("http"))
      return v;
  }
  const srcset = attr("srcset") ?? attr("data-srcset");
  if (srcset) {
    const first = srcset.split(",")[0]?.trim().split(/\s+/)[0];
    if (first?.startsWith("http"))
      return first;
  }
  return null;
}
function looksBotWalled(html) {
  return html.includes("/.within.website/") || html.includes("Making sure you") || html.includes("Just a moment...") || html.includes("cf-challenge") || html.includes("Attention Required! | Cloudflare") || html.includes("sessionStorage.IoI");
}
function parseMagento(html) {
  const products = [];
  const seen = new Set;
  const anchorRe = /<a\b[^>]*>([\s\S]*?)<\/a>/g;
  for (const m of html.matchAll(anchorRe)) {
    if (products.length >= MAX_PER_STORE)
      break;
    const openTag = m[0].slice(0, m[0].indexOf(">") + 1);
    if (!openTag.includes("product-item-link"))
      continue;
    const href = openTag.match(/href="([^"]+)"/)?.[1];
    if (!href)
      continue;
    const url = decodeEntities(href);
    if (seen.has(url))
      continue;
    const title = cleanText(m[1] ?? "");
    if (!title)
      continue;
    seen.add(url);
    const idx = m.index ?? 0;
    const before = html.slice(Math.max(0, idx - 4500), idx);
    const after = html.slice(idx, idx + 3000);
    let imageUrl = null;
    const imgTags = before.match(/<img\b[^>]*>/g) ?? [];
    for (let i = imgTags.length - 1;i >= 0; i--) {
      const tag = imgTags[i] ?? "";
      if (/product-image|primary-image/.test(tag)) {
        imageUrl = imgFromTag(tag);
        if (imageUrl)
          break;
      }
    }
    let priceAmount = null;
    const priceMatch = after.match(/data-price-amount="([\d.]+)"[^>]*data-price-type="finalPrice"/) ?? after.match(/data-price-amount="([\d.]+)"/);
    if (priceMatch?.[1]) {
      const n = parseFloat(priceMatch[1]);
      if (Number.isFinite(n))
        priceAmount = n;
    }
    if (priceAmount == null) {
      const d = firstDollar(after.slice(0, 1200));
      if (d)
        priceAmount = d.amount;
    }
    let compareAtText = null;
    const oldMatch = after.match(/data-price-amount="([\d.]+)"[^>]*data-price-type="oldPrice"/) ?? after.match(/data-price-type="oldPrice"[^>]*data-price-amount="([\d.]+)"/);
    if (oldMatch?.[1] && priceAmount != null) {
      const old = parseFloat(oldMatch[1]);
      if (Number.isFinite(old) && old > priceAmount) {
        compareAtText = money(old);
      }
    }
    products.push({
      title,
      url,
      priceText: priceAmount == null ? null : money(priceAmount),
      priceAmount,
      compareAtText,
      imageUrl
    });
  }
  return products;
}
function parseShopify(html) {
  const products = [];
  const seen = new Set;
  const blocks = html.split(/<div class="product-item\s/);
  for (const block of blocks.slice(1)) {
    if (products.length >= MAX_PER_STORE)
      break;
    const chunk = block.slice(0, 7000);
    const titleM = chunk.match(/<a href="(\/products\/[^"]+)"[^>]*class="product-item__title[^"]*"[^>]*>([\s\S]*?)<\/a>/);
    if (!titleM?.[1] || !titleM[2])
      continue;
    const path = titleM[1].split("?")[0] ?? titleM[1];
    const url = `https://seforimdeals.com${path}`;
    if (seen.has(url))
      continue;
    const title = cleanText(titleM[2]);
    if (!title)
      continue;
    seen.add(url);
    let imageUrl = null;
    const imgM = chunk.match(/<img\b[^>]*>/);
    if (imgM)
      imageUrl = imgFromTag(imgM[0].replace("{width}", "600"));
    const saleM = chunk.match(/price--highlight[^>]*>[\s\S]{0,200}?\$\s?([\d,]+(?:\.\d{2})?)/);
    const cmpM = chunk.match(/price--compare[^>]*>[\s\S]{0,200}?\$\s?([\d,]+(?:\.\d{2})?)/);
    let priceAmount = null;
    if (saleM?.[1])
      priceAmount = parseFloat(saleM[1].replace(/,/g, ""));
    if (priceAmount == null || !Number.isFinite(priceAmount)) {
      const idx = chunk.indexOf("product-item__price-list");
      const d = idx >= 0 ? firstDollar(chunk.slice(idx)) : null;
      priceAmount = d?.amount ?? null;
    }
    const compareAmount = cmpM?.[1] ? parseFloat(cmpM[1].replace(/,/g, "")) : null;
    products.push({
      title,
      url,
      priceText: priceAmount == null ? null : money(priceAmount),
      priceAmount,
      compareAtText: compareAmount != null && Number.isFinite(compareAmount) && compareAmount !== priceAmount ? money(compareAmount) : null,
      imageUrl
    });
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
      return {
        title: cleanText(p.title ?? ""),
        url: p.url ? `https://seforimdeals.com${p.url.split("?")[0]}` : "",
        priceText: Number.isFinite(priceN) ? money(priceN) : null,
        priceAmount: Number.isFinite(priceN) ? priceN : null,
        compareAtText: null,
        imageUrl: img ? img.startsWith("//") ? `https:${img}` : img : null
      };
    }).filter((p) => p.title && p.url);
  } catch {
    return [];
  }
}
function parseOpencartJournal(html) {
  const clean = html.replace(/<style[\s\S]*?<\/style>/g, "").replace(/<script[\s\S]*?<\/script>/g, "");
  const products = [];
  const seen = new Set;
  for (const seg of clean.split(/class="product-layout/)) {
    if (products.length >= MAX_PER_STORE)
      break;
    const chunk = seg.slice(0, 8000);
    const nameM = chunk.match(/class="name[^"]*">\s*<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!nameM?.[1] || !nameM[2])
      continue;
    const url = decodeEntities(nameM[1]).split("?")[0] ?? nameM[1];
    if (seen.has(url))
      continue;
    const title = cleanText(nameM[2]);
    if (!title)
      continue;
    seen.add(url);
    let priceAmount = null;
    let compareAtText = null;
    const pNew = chunk.match(/price-new[^>]*>\s*\$?\s?([\d,]+(?:\.\d{2})?)/);
    const pOld = chunk.match(/price-old[^>]*>\s*\$?\s?([\d,]+(?:\.\d{2})?)/);
    if (pNew?.[1])
      priceAmount = parseFloat(pNew[1].replace(/,/g, ""));
    if (pOld?.[1] && priceAmount != null) {
      const old = parseFloat(pOld[1].replace(/,/g, ""));
      if (Number.isFinite(old) && old > priceAmount) {
        compareAtText = money(old);
      }
    }
    if (priceAmount == null) {
      const pn = chunk.match(/price-normal[^>]*>\s*\$?\s?([\d,]+(?:\.\d{2})?)/);
      if (pn?.[1])
        priceAmount = parseFloat(pn[1].replace(/,/g, ""));
    }
    if (priceAmount == null || !Number.isFinite(priceAmount)) {
      const priceDiv = chunk.match(/class="price"[^>]*>([\s\S]{0,500})/);
      const d = priceDiv?.[1] ? firstDollar(priceDiv[1]) : null;
      priceAmount = d?.amount ?? null;
    }
    let imageUrl = null;
    const imgs = chunk.match(/<img\b[^>]*>/g) ?? [];
    for (const tag of imgs) {
      if (tag.includes("/image/cache/") || tag.includes("/image/data/") || tag.includes("/image/catalog/")) {
        imageUrl = imgFromTag(tag);
        if (imageUrl)
          break;
      }
    }
    if (!imageUrl && imgs[0])
      imageUrl = imgFromTag(imgs[0]);
    products.push({
      title,
      url,
      priceText: priceAmount == null ? null : money(priceAmount),
      priceAmount,
      compareAtText,
      imageUrl
    });
  }
  return products;
}
function parseOpencartClassic(html) {
  const products = [];
  const seen = new Set;
  const segments = html.split(/class="product-thumb/);
  for (const seg of segments.slice(1)) {
    if (products.length >= MAX_PER_STORE)
      break;
    const chunk = seg.slice(0, 8000);
    const h4 = chunk.match(/<h4>\s*<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!h4?.[1] || !h4[2])
      continue;
    const url = decodeEntities(h4[1]).split("?")[0] ?? h4[1];
    if (seen.has(url))
      continue;
    const title = cleanText(h4[2]);
    if (!title)
      continue;
    seen.add(url);
    const priceM = chunk.match(/class="price"[^>]*>([\s\S]{0,600})/);
    const priceHtml = priceM?.[1] ?? "";
    const pNew = priceHtml.match(/price-new[^>]*>\s*\$?\s?([\d,]+(?:\.\d{2})?)/);
    const pOld = priceHtml.match(/price-old[^>]*>\s*\$?\s?([\d,]+(?:\.\d{2})?)/);
    let priceAmount = null;
    let compareAtText = null;
    if (pNew?.[1])
      priceAmount = parseFloat(pNew[1].replace(/,/g, ""));
    if (pOld?.[1] && priceAmount != null) {
      const old = parseFloat(pOld[1].replace(/,/g, ""));
      if (Number.isFinite(old) && old > priceAmount) {
        compareAtText = money(old);
      }
    }
    if (priceAmount == null) {
      const d = firstDollar(priceHtml);
      priceAmount = d?.amount ?? null;
    }
    let imageUrl = null;
    const imgs = chunk.match(/<img\b[^>]*>/g) ?? [];
    for (const tag of imgs) {
      if (tag.includes("/image/cache/")) {
        imageUrl = imgFromTag(tag);
        if (imageUrl)
          break;
      }
    }
    if (!imageUrl && imgs[0])
      imageUrl = imgFromTag(imgs[0]);
    products.push({
      title,
      url,
      priceText: priceAmount == null ? null : money(priceAmount),
      priceAmount,
      compareAtText,
      imageUrl
    });
  }
  return products;
}
function parseVolusion(html) {
  const products = [];
  const seen = new Set;
  const anchorRe = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  for (const m of html.matchAll(anchorRe)) {
    if (products.length >= MAX_PER_STORE)
      break;
    const href = decodeEntities(m[1] ?? "");
    if (!/(item\.asp|\.html)(\?|$)/i.test(href))
      continue;
    if (/search\.asp|category|cart|checkout|account|login/i.test(href))
      continue;
    const url = href.startsWith("http") ? href : `https://www.greenfieldjudaica.com${href.startsWith("/") ? "" : "/"}${href}`;
    const cleanUrl = url.split("?")[0] ?? url;
    if (seen.has(cleanUrl))
      continue;
    const title = cleanText(m[2] ?? "");
    if (title.length < 4 || /^(home|menu|cart|search|view|more)$/i.test(title))
      continue;
    seen.add(cleanUrl);
    const idx = m.index ?? 0;
    const around = html.slice(Math.max(0, idx - 1200), idx + 1800);
    const d = firstDollar(around.slice(1200));
    let imageUrl = null;
    const imgs = around.match(/<img\b[^>]*>/g) ?? [];
    for (const tag of imgs) {
      const v = imgFromTag(tag);
      if (v && !/logo|icon|button/i.test(v)) {
        imageUrl = v;
        break;
      }
    }
    products.push({
      title,
      url: cleanUrl,
      priceText: d?.text ?? null,
      priceAmount: d?.amount ?? null,
      compareAtText: null,
      imageUrl
    });
  }
  return products;
}
function parseWooStoreApi(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data))
    return [];
  const products = [];
  for (const p of data) {
    const title = cleanText(p.name ?? "");
    const url = p.permalink ?? "";
    if (!title || !url)
      continue;
    const minor = p.prices?.currency_minor_unit ?? 2;
    const div = Math.pow(10, minor);
    const priceRaw = p.prices?.price ? parseInt(p.prices.price, 10) : NaN;
    const regRaw = p.prices?.regular_price ? parseInt(p.prices.regular_price, 10) : NaN;
    const priceAmount = Number.isFinite(priceRaw) ? priceRaw / div : null;
    products.push({
      title,
      url,
      priceText: priceAmount == null ? null : money(priceAmount),
      priceAmount,
      compareAtText: Number.isFinite(regRaw) && regRaw !== priceRaw ? money(regRaw / div) : null,
      imageUrl: p.images?.[0]?.src ?? null
    });
    if (products.length >= MAX_PER_STORE)
      break;
  }
  return products;
}
async function fetchViaChain(url) {
  const ctrl = new AbortController;
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: "follow" });
    if (!res.ok)
      return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}
function parseForStore(store, text) {
  switch (store.parser) {
    case "magento":
      return parseMagento(text);
    case "shopify":
      return parseShopify(text);
    case "opencartJournal":
      return parseOpencartJournal(text);
    case "opencartClassic":
      return parseOpencartClassic(text);
    case "volusion":
      return parseVolusion(text);
    case "wooStoreApi":
      return parseWooStoreApi(text);
    default:
      return [];
  }
}
function targetUrlFor(store, query) {
  if (store.parser === "wooStoreApi") {
    return `https://www.esicha.org/wp-json/wc/store/v1/products?search=${enc(query)}&per_page=${MAX_PER_STORE}`;
  }
  return store.searchUrl(query);
}
async function searchStoreViaWorker(store, query) {
  if (!WORKER_URL) return null;
  try {
    const base = WORKER_URL.replace(/\/$/, "");
    const res = await fetch(`${base}/?q=${enc(query)}&store=${store.id}`, { signal: AbortSignal.timeout(25000) });
    if (!res.ok) return null;
    const data = await res.json();
    const r = (data.results || [])[0];
    if (!r) return null;
    return {
      storeId: store.id, storeName: store.name, searchUrl: store.searchUrl(query),
      status: r.status, message: r.message, products: r.products || [],
    };
  } catch { return null; }
}
async function searchStore(store, query, variantQueries) {
  const searchUrl = store.searchUrl(query);
  const base = { storeId: store.id, storeName: store.name, searchUrl };
  // Worker first (server-side fetch, no browser CORS block). If the
  // worker is not configured or fails, fall through to direct fetch.
  if (WORKER_URL) {
    const queries = variantQueries && variantQueries.length ? variantQueries : [query];
    const perVariant = [];
    for (const vq of queries) {
      const r = await searchStoreViaWorker(store, vq);
      if (r && r.status === "ok") perVariant.push(r.products);
      else if (r && r.status === "empty") perVariant.push([]);
      else if (r) { /* worker error for this store: stop, fall through below */ break; }
      else break;
    }
    if (perVariant.length === queries.length) {
      const merged = mergeProducts(perVariant);
      if (merged.length > 0) return { ...base, status: "ok", message: null, products: merged };
      return { ...base, status: "empty", message: `No listings at ${store.name} matched “${query}”.`, products: [] };
    }
    // If worker gave an error status for the original query, surface it
    // honestly instead of silently falling back to a blocked direct fetch.
    const first = await searchStoreViaWorker(store, query);
    if (first && first.status === "error") return first;
  }
  // Direct browser fetch (fallback when no worker is configured). Also
  // expands spelling variants and merges, deduplicated by product URL.
  const queries = variantQueries && variantQueries.length ? variantQueries : [query];
  const perVariant = [];
  for (const vq of queries) {
    const text = await fetchViaChain(targetUrlFor(store, vq));
    if (text == null) {
      return { ...base, status: "error",
        message: `The listings from ${store.name} couldn't be loaded from this page — the store doesn't allow other websites to read its results directly. You can open its own search results instead.`, products: [] };
    }
    if (looksBotWalled(text)) {
      return { ...base, status: "error",
        message: `${store.name} is showing a bot-check page right now, so its listings can't be loaded here. You can open its own search results instead.`, products: [] };
    }
    let products = parseForStore(store, text);
    if (products.length === 0 && store.parser === "shopify") {
      const suggestUrl = `https://seforimdeals.com/search/suggest.json?q=${enc(vq)}&resources%5Btype%5D=product&resources%5Blimit%5D=10`;
      const suggestText = await fetchViaChain(suggestUrl);
      if (suggestText) products = parseShopifySuggest(suggestText);
    }
    perVariant.push(products);
  }
  const merged = mergeProducts(perVariant);
  if (merged.length === 0) {
    return { ...base, status: "empty", message: `No listings at ${store.name} matched “${query}”.`, products: [] };
  }
  return { ...base, status: "ok", message: null, products: merged };
}
function sortProducts(products, mode) {
  if (mode === "store")
    return products;
  const dir = mode === "price-asc" ? 1 : -1;
  return [...products].sort((a, b) => {
    if (a.priceAmount == null && b.priceAmount == null)
      return 0;
    if (a.priceAmount == null)
      return 1;
    if (b.priceAmount == null)
      return -1;
    return (a.priceAmount - b.priceAmount) * dir;
  });
}
export {
  MAX_PER_STORE,
  STORES,
  WORKER_URL,
  expandQuery,
  cleanText,
  decodeEntities,
  fetchViaChain,
  looksBotWalled,
  money,
  parseMagento,
  parseOpencartClassic,
  parseOpencartJournal,
  parseShopify,
  parseShopifySuggest,
  parseVolusion,
  parseWooStoreApi,
  searchStore,
  sortProducts
};
