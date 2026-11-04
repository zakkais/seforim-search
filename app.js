// Seforim Search — store library (runs in the visitor's browser).
//
// What this file does: it knows the eight stores (their search URLs and
// which page layout each one uses), turns a store's search page into
// product listings, expands a search into alternate transliterations
// (midrash/medrash, mishnah/mishna, ...), merges results across stores
// and spelling variants, and sorts them. ui.js imports it and renders
// what it returns. It has no dependencies of its own — plain browser
// JavaScript, no build step.
//
// HOW TO EDIT THIS FILE (read before changing anything):
// - INTENTIONAL DUPLICATION: the store list (STORES) and the store
//   parsers below are copied in worker.js as well. That is not an
//   accident to clean up: worker.js is the server-side fetcher the live
//   site normally uses, and this file is the direct-browser fallback
//   the page uses when the worker cannot be reached. The worker copy
//   is authoritative for live site searches; this copy is authoritative
//   for that fallback. If you change a store's search URL or a parser,
//   change it in BOTH files, and keep MAX_PER_STORE the same in both,
//   or the page will trim the worker's results.
// - To add or fix a store, edit STORES and, if its page layout is new,
//   add a parser and a case in parseForStore (and the same in
//   worker.js). To change how far a search goes, change MAX_PER_STORE
//   (currently 100 listings per store) in both files.
// - Do not touch WORKER_URL casually: it must point at the deployed
//   worker, with no trailing slash. While it is empty, the page falls
//   back to direct browser fetching, which most stores block.
//
// What each listing looks like everywhere in this project:
// { title, url, priceText, priceAmount, compareAtText, imageUrl }
// (priceText/compareAtText are display strings like "$41.00";
// priceAmount is the number used for sorting, or null when the store
// shows no price.)
var enc = (q) => encodeURIComponent(q);
var STORES = [
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
var MAX_PER_STORE = 100;
// ---------------------------------------------------------------------------
// Fetching back-end (Cloudflare Worker). Deploy worker.js (see README.md)
// and put its URL here, e.g. "https://seforim-search.<you>.workers.dev".
// While this is empty, the site falls back to direct browser fetching
// (which most stores block via CORS) plus the link-out button.
// ---------------------------------------------------------------------------
var WORKER_URL = "https://seforim-search.zakkaishusterman01.workers.dev";
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
  ["halacha", "halachos", "halakha", "halakhot", "halochos", "halochah"],
  ["tefillah", "tefila", "tefillot", "tefilos"],
  ["siddur", "siddurim"],
  ["machzor", "machzorim"],
  ["sefer", "seforim", "seferim"],
  ["shulchan"],
  ["aruch", "oruch", "arukh"],
  ["rashi"],
  ["rambam"],
  ["tanya"],
  ["kabbalah", "kabbala", "kabala"],
  ["mussar", "musar"],
  ["aggadah", "agada", "aggada", "aggadot"],
  ["berurah", "berura"],
  ["brachot", "brochos", "brachos", "berachot", "berachos"],
  ["shabbos", "shabbat", "shabbath"],
  ["pesach", "passover", "pesah"],
  ["sukkah", "succah", "sukkot", "succos"],
  ["tehillim", "tehilim"],
  ["nach", "tanach", "tanakh"],
  ["avot", "avos", "pirkei avot", "pirkei avos"],
  ["yom"],
  ["kiddush", "kidush"],
  ["taharah", "tahara", "taharos"],
  ["tzitzit", "tzitzis", "tzitzith"],
  ["mezuzah", "mezuza", "mezuzot"],
  ["chanukah", "hanukkah", "chanuka", "hanuka"],
  ["purim"],
  ["rosh"],
  ["hashanah", "hashana"],
  ["kippur"],
  ["mishneh", "mishne", "mishneh torah"],
  ["torah", "tora"],
  ["neviim"],
  ["kesuvim", "ksuvim"],
  ["parsha", "parshah", "parshas", "parshat"],
  ["rebbe", "rebbi"],
  ["tzaddik", "tzadik", "tzaddikim", "tzadikim"],
  ["chassidus", "hasidus", "chassidut", "chasidus"],
  ["likkutei", "likutei", "likkutey"],
  ["sichos", "sichot"],
  ["shul"],
  ["minhag", "minhog", "minhagim", "minhogim"],
  ["mitzvah", "mitzva", "mitzvot", "mitzvos"],
  ["yeshiva", "yeshivah"],
  ["rabbi", "rav", "rebbe"],
  ["gaon", "goan"],
  ["kitzur"],
  ["orech"],
  ["chayim", "chaim", "hayim"],
  ["ohr", "or"],
  ["zohar"],
  ["taanit", "taanis", "taanith"],
  ["megillah", "megila", "megillas", "megilot"],
  ["esther"],
  ["daniel"],
  ["ezra"],
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
// ---------------------------------------------------------------------------
// The Hebrew bridge. Sefer titles are often listed in Hebrew only, and
// shoppers search in transliteration — or the reverse. Each row is
// [canonical latin, [hebrew forms], ...extra latin spellings]. The
// ranker canonicalizes BOTH the query and every title through this
// table, so "minchas elazar" and "מנחת אלעזר" are the same search to
// it, and expandQuery adds the all-Hebrew form as an extra store
// query so Hebrew-only listings are fetched, not just ranked. The
// table starts with the words that actually recur in sefer titles;
// add a row when a real search shows a word is missing.
// ---------------------------------------------------------------------------
const HEBREW_BRIDGE = [
  ["minchas", ["מנחת"], "minchat", "minhat", "menchas"],
  ["elazar", ["אלעזר"]],
  ["tanya", ["תניא"]],
  ["mishnah", ["משנה"], "mishna"],
  ["mishnayos", ["משניות"], "mishnayot"],
  ["berurah", ["ברורה"], "berura", "brurah"],
  ["shulchan", ["שולחן"], "shulhan", "שלחן"],
  ["aruch", ["ערוך"], "arukh", "oruch"],
  ["hilchos", ["הלכות"], "halachos", "halachot", "hilchot", "halacha", "halochos"],
  ["torah", ["תורה"]],
  ["chumash", ["חומש"], "humash"],
  ["tehillim", ["תהלים", "תהילים"], "tehilim", "psalms"],
  ["gemara", ["גמרא"], "gemora", "gemorah"],
  ["talmud", ["תלמוד"]],
  ["yerushalmi", ["ירושלמי"]],
  ["bavli", ["בבלי"]],
  ["siddur", ["סידור"], "sidur"],
  ["machzor", ["מחזור"], "mahzor"],
  ["haggadah", ["הגדה"], "hagadah", "hagada"],
  ["megillah", ["מגילה", "מגילת"], "megila", "megillas"],
  ["rambam", ["רמבם"]],
  ["tur", ["טור"]],
  ["shut", ["שות"]],
  ["shabbos", ["שבת"], "shabbat", "shabos"],
  ["pesach", ["פסח"], "pesah"],
  ["succos", ["סוכות"], "sukkot", "succot"],
  ["sefer", ["ספר"]],
  ["seforim", ["ספרים"]],
  ["shiurim", ["שיעורים"]],
  ["maamarim", ["מאמרים"]],
  ["sichos", ["שיחות"], "sichot"],
  ["likutei", ["ליקוטי"], "likkutey", "likkutei"],
  ["chassidus", ["חסידות"], "chasidus", "hassidut"],
  ["tefillah", ["תפילה"], "tefila", "tefilah"],
  ["brachos", ["ברכות"], "berachos", "berachot"],
  ["midrash", ["מדרש"], "medrash"],
  ["rabbah", ["רבה"], "rabba", "raba"],
  ["zohar", ["זוהר"]],
  ["kinos", ["קינות"], "kinot"],
  ["selichos", ["סליחות"], "selichot"],
  ["pirkei", ["פרקי"]],
  ["avos", ["אבות"], "avot"],
  ["mitzvos", ["מצוות"], "mitzvot", "mitsvos"],
  ["parsha", ["פרשה"], "parshah", "parshas", "parshat"],
  ["bereishis", ["בראשית"], "bereshit", "bereishit"],
  ["shemos", ["שמות"], "shemot"],
  ["vayikra", ["ויקרא"]],
  ["bamidbar", ["במדבר"], "bemidbar"],
  ["devarim", ["דברים"]],
  ["yehoshua", ["יהושע"]],
  ["shofetim", ["שופטים"], "shoftim"],
  ["shmuel", ["שמואל"], "shmuell", "shemuel"],
  ["melachim", ["מלכים"]],
  ["yeshayahu", ["ישעיהו"], "yeshaya"],
  ["yirmiyahu", ["ירמיהו"]],
  ["yechezkel", ["יחזקאל"]],
  ["daniel", ["דניאל"]],
  ["ezra", ["עזרא"]],
  ["nechemya", ["נחמיה"], "nehemiah", "nechemia"],
  ["divrei", ["דברי"]],
  ["hayamim", ["הימים"]],
  ["chayei", ["חיי"], "hayei"],
  ["asher", ["אשר"]],
  ["yosef", ["יוסף"]],
  ["moshe", ["משה"]],
  ["yaakov", ["יעקב"]],
  ["yitzchak", ["יצחק"]],
  ["chaim", ["חיים"]],
  ["menachem", ["מנחם"]],
  ["shlomo", ["שלמה"]],
  ["yehuda", ["יהודה"]],
  ["levi", ["לוי"]],
  ["yisrael", ["ישראל"]],
  ["eliezer", ["אליעזר"]],
  ["meir", ["מאיר"]],
  ["pinchas", ["פנחס"]],
  ["eliyahu", ["אליהו"]],
  ["ben", ["בן"]],
  ["shneur", ["שניאור"]],
  ["zalman", ["זלמן"]],
];
const CANON_WORD = new Map();
const HEBREW_FORM = new Map();
for (const [latin, hebrews, ...variants] of HEBREW_BRIDGE) {
  CANON_WORD.set(latin, latin);
  for (const h of hebrews) CANON_WORD.set(h, latin);
  for (const v of variants) CANON_WORD.set(v, latin);
  HEBREW_FORM.set(latin, hebrews[0]);
}
function canonWords(words) {
  return words.map((w) => CANON_WORD.get(w) ?? w);
}
function expandQuery(query) {
  const words = String(query || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [query];
  // An ISBN is an exact identifier, not a phrase: never expand it into
  // spelling variants (variant searches on a number are pure noise).
  // Stores match the number against their ISBN fields as-is.
  const compact = words.join("").replace(/-/g, "");
  if (/^\d{9}[\dx]$/i.test(compact) || /^\d{13}$/.test(compact)) return [query.trim()];
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
  // If every word has a Hebrew form, search the title in Hebrew too:
  // many listings exist in Hebrew only, and some stores match them
  // only under a Hebrew query. It goes right after the original query
  // so the 12-variant cap can't squeeze it out.
  const hebrewForms = words.map((w) => HEBREW_FORM.get(CANON_WORD.get(w) ?? w));
  if (hebrewForms.length === words.length && hebrewForms.every(Boolean)) {
    const hq = hebrewForms.join(" ");
    if (!seen.has(hq) && !out.includes(hq)) out.splice(1, 0, hq);
  }
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
// ---------------------------------------------------------------------------
// One parser per store platform (the same set as in worker.js — see the
// duplication note at the top). Each turns a store's search page (or,
// for eSicha, its product API JSON) into the shared listing shape above.
// A parser returning [] does not mean "no such sefer" — it can also mean
// the store changed its page layout, in which case this is the place
// that needs updating (and the matching parser in worker.js too).
// ---------------------------------------------------------------------------
function parseMagento(html) {
  const products = [];
  const seen = new Set();
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
  const seen = new Set();
  const blocks = html.split(/<div class="product-item\s/);
  for (const block of blocks.slice(1)) {
    if (products.length >= MAX_PER_STORE)
      break;
    const chunk = block.slice(0, 7000);
    const titleM = chunk.match(/<a href="([^"]*\/products\/[^"]+)"[^>]*class="product-item__title[^"]*"[^>]*>([\s\S]*?)<\/a>/);
    if (!titleM?.[1] || !titleM[2])
      continue;
    // Collection pages prefix the href with /collections/<name>; the
    // canonical product URL is always /products/<handle>. (Search
    // pages already link that way, so this changes nothing for them.)
    const handle = titleM[1].split("?")[0].split("/products/")[1];
    if (!handle)
      continue;
    const url = `https://seforimdeals.com/products/${handle}`;
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
  const seen = new Set();
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
  const seen = new Set();
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
  const seen = new Set();
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
      imageUrl: p.images?.[0]?.src ?? null,
      soldOut: p.is_in_stock === false
    });
    if (products.length >= MAX_PER_STORE)
      break;
  }
  return products;
}
// ---------------------------------------------------------------------------
// Searching: try the worker first (it fetches server-side, so no browser
// CORS block), and fall back to reading the store directly from the
// browser when the worker is missing or fails. Either way, results from
// all spelling variants are merged and deduplicated by product URL.
// ---------------------------------------------------------------------------
async function fetchViaChain(url) {
  const ctrl = new AbortController();
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
// ---------------------------------------------------------------------------
// Sorting. Price and title sorts are straightforward; "Priority: closest
// match" is explained on priorityScore itself — read that comment before
// changing the ranking, because small changes there reorder every
// search's results.
// ---------------------------------------------------------------------------
function normWords(s) {
  return String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(/\s+/).filter(Boolean);
}
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}
// Priority score for a title against the original query: lower is closer.
// Tier: exact match, starts with the query, contains it, all query words
// present, some query words present, none present. Within a tier, the
// average per-word edit distance to the title's words breaks ties, so a
// title spelled like the query ("midrash") outranks a farther variant
// ("medrash", "midresh") and a merely similar word. A small penalty per
// extra title word follows, so between two titles that both contain the
// query the shorter, more focused one wins ("שו"ת מנחת אלעזר" over a
// longer title that merely mentions the name). Price, then title,
// breaks remaining ties in sortProducts.
//
// Both sides are canonicalized through the Hebrew bridge first (see
// HEBREW_BRIDGE above), and the abbreviation שו"ת is folded to "shut"
// before word-splitting, since its quote mark would otherwise split it
// into fragments. Without the bridge, a Hebrew-only title scored
// "none" against a transliterated query and sank to the very bottom —
// the bug behind "minchas elazar" ranking its only real match last.
function priorityScore(title, query) {
  const foldShut = (s) => String(s || "").replace(/שו["'׳״]ת/g, " shut ");
  const qWords = canonWords(normWords(foldShut(query)));
  const tWords = canonWords(normWords(foldShut(title)));
  const q = qWords.join(" ");
  const t = tWords.join(" ");
  if (!q) return 0;
  // A query word counts as matched if a title word is equal or within a
  // small edit distance, so close spellings ("mishna" for "mishnah")
  // count as matches instead of falling behind partial-word titles.
  const minDists = qWords.map((w) => tWords.length ? Math.min(...tWords.map((tw) => levenshtein(w, tw))) : 99);
  const matched = minDists.filter((d, i) => d <= Math.max(1, Math.floor(qWords[i].length / 3))).length;
  let tier;
  if (t === q) tier = 0;
  else if (t.startsWith(q)) tier = 1;
  else if (t.includes(q)) tier = 2;
  else if (qWords.length && matched === qWords.length) tier = 3;
  else if (matched > 0) tier = 4;
  else tier = 5;
  const avgDist = minDists.length ? minDists.reduce((a, b) => a + b, 0) / minDists.length : 99;
  const extraWords = Math.max(0, tWords.length - qWords.length);
  // A title that matches the query exactly AS TYPED (before any
  // canonicalizing) still beats one that only matches through the
  // bridge or a spelling variant: searching "mishnah berurah" should
  // put "Mishnah Berurah" ahead of "Mishna Berura", even though the
  // bridge treats them as the same words.
  const rawQ = normWords(query).join(" ");
  const rawT = normWords(title).join(" ");
  const rawBonus = !rawQ ? 0
    : rawT === rawQ ? -50
    : rawT.startsWith(rawQ) ? -30
    : rawT.includes(rawQ) ? -15
    : 0;
  return tier * 1000 + avgDist * 10 + extraWords + rawBonus;
}
function sortProducts(products, mode, query) {
  if (mode === "priority") {
    return [...products].sort((a, b) => {
      const d = priorityScore(a.title, query) - priorityScore(b.title, query);
      if (d !== 0) return d;
      if (a.priceAmount != null && b.priceAmount != null && a.priceAmount !== b.priceAmount)
        return a.priceAmount - b.priceAmount;
      return String(a.title || "").localeCompare(String(b.title || ""), undefined, { sensitivity: "base" });
    });
  }
  if (mode === "alpha-asc" || mode === "alpha-desc") {
    const dir = mode === "alpha-asc" ? 1 : -1;
    return [...products].sort((a, b) =>
      String(a.title || "").localeCompare(String(b.title || ""), undefined, { sensitivity: "base" }) * dir);
  }
  if (mode !== "price-asc" && mode !== "price-desc")
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
// ---------------------------------------------------------------------------
// Grouping: the same sefer listed by several stores becomes ONE card
// (Zakkai's design, 2026-11-03: the card says how many stores carry it,
// cheapest price up front, swipe inside the card to flip stores).
//
// A listing's signature is its core name — canonical words (Hebrew
// bridge applied) with store dressing removed — plus the
// discriminators that make two listings DIFFERENT items: the set's
// volume count, a series part label, the size class, the binding, and
// edition markers. Rules group only listings whose cores are identical
// and whose discriminators never conflict, at most one listing per
// store per group. Anything softer — a detail stated on one side only
// is fine for the rules, but cores that merely overlap, or a
// Hebrew-titled listing against a dressed-up transliteration — is NOT
// guessed by the rules: matchCandidates proposes those pairs and the
// worker's /match endpoint lets the AI judge them (the client's
// verdict cache makes each pair a one-time question). A wrong merge
// would promise one store's price for another store's edition, so
// every doubtful case resolves to "separate cards", which is simply
// how the site behaved before grouping existed.
// ---------------------------------------------------------------------------
const GROUP_SIZE_CLASS = new Map([
  ["full", "FULL"], ["large", "FULL"], ["big", "FULL"], ["גדול", "FULL"],
  ["mid", "MID"], ["medium", "MID"],
  ["compact", "SMALL"], ["small", "SMALL"], ["mini", "SMALL"], ["pocket", "SMALL"], ["student", "SMALL"], ["קטן", "SMALL"],
]);
const GROUP_BINDING_CLASS = new Map([
  ["leather", "LEATHER"],
  ["hardcover", "HARD"], ["hard", "HARD"], ["hc", "HARD"],
  ["paperback", "SOFT"], ["softcover", "SOFT"], ["pb", "SOFT"],
]);
const GROUP_EDITION_MARKERS = new Set([
  "revised", "מבואר", "mevoar", "annotated", "illustrated", "מנוקד", "menukad",
  // A named translation language is an edition discriminator too: a
  // Russian Kitzur Shulchan Aruch is not the plain one. ("Hebrew" and
  // "English" are left out — too many bilingual titles name them.)
  "russian", "spanish", "french", "german", "portuguese", "italian", "yiddish",
]);
const GROUP_DRESSING = new Set([
  "the", "a", "an", "of", "from", "with", "and", "in", "on", "for", "to", "im", "al", "shel",
  "על", "עם", "את", "של",
  "sefer", "book", "books", "set", "sets", "vol", "vols", "volume", "volumes",
  "כרכים", "סט", "חלק", "חלקים", "chelek", "helek",
  "edition", "editions", "new", "standard", "size", "sized",
  "shrink", "wrapped", "slipcased", "slipcase", "yahadus",
  "full", "large", "big", "mid", "medium", "compact", "small", "mini", "pocket", "student",
  "גדול", "קטן",
  "leather", "hardcover", "paperback", "softcover", "hard", "hc", "pb",
  "h", "c", "p", "b",
]);
const GROUP_HEBREW_NUMERAL = {
  "א": 1, "ב": 2, "ג": 3, "ד": 4, "ה": 5, "ו": 6, "ז": 7, "ח": 8, "ט": 9,
  "י": 10, "יא": 11, "יב": 12, "יג": 13, "יד": 14, "טו": 15, "טז": 16,
  "יז": 17, "יח": 18, "יט": 19, "כ": 20,
};
const GROUP_NUM_WORDS = new Set(["vol", "vols", "volume", "volumes", "כרכים"]);
const GROUP_PART_WORDS = new Set(["vol", "vols", "volume", "volumes", "חלק", "חלקים", "chelek", "helek", "part", "parts"]);
// Transliterated Hebrew numerals, for titles like "Chelek Alef" or
// "Chelek Yud Beis": labels only need to be consistent, not summed.
const GROUP_LATIN_NUMERAL = {
  alef: 1, aleph: 1, beis: 2, bet: 2, bais: 2, gimel: 3, gimmel: 3,
  dalet: 4, daled: 4, hei: 5, he: 5, vov: 6, vav: 6, zayin: 7,
  ches: 8, chet: 8, tes: 9, tet: 9, yud: 10, yod: 10, chaf: 20, kuf: 100,
};

function productSignature(title) {
  const folded = String(title || "").replace(/שו["'׳״]ת/g, " shut ");
  const words = canonWords(normWords(folded));
  let count = null;
  let sizeClass = null;
  let binding = null;
  let isSet = false;
  const editions = new Set();
  const partTokens = [];
  const coreSet = new Set();
  const asNum = (w) => (/^\d+$/.test(w) ? parseInt(w, 10) : GROUP_HEBREW_NUMERAL[w] ?? GROUP_LATIN_NUMERAL[w]);
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const next = words[i + 1];
    if (sizeClass === null && GROUP_SIZE_CLASS.has(w)) sizeClass = GROUP_SIZE_CLASS.get(w);
    if (binding === null) {
      if (GROUP_BINDING_CLASS.has(w)) binding = GROUP_BINDING_CLASS.get(w);
      else if (w === "h" && next === "c") binding = "HARD";
      else if (w === "p" && next === "b") binding = "SOFT";
    }
    if (GROUP_EDITION_MARKERS.has(w)) editions.add(w);
    if (w === "set" || w === "sets" || w === "סט") isSet = true;
    const num = asNum(w);
    // "5 vol" / "5 כרכים" / "ה כרכים": a number directly before a
    // volume word is the set's volume count.
    if (num !== undefined && next !== undefined && GROUP_NUM_WORDS.has(next)) {
      if (count === null) count = num;
      isSet = true;
      continue;
    }
    // "vol 2" / "חלק ב" / "chelek alef": one volume of a series — a
    // part label. Consecutive numeral words are one label ("yud beis").
    if (GROUP_PART_WORDS.has(w) && next !== undefined && asNum(next) !== undefined) {
      const label = [];
      let k = i + 1;
      while (k < words.length && asNum(words[k]) !== undefined) { label.push(String(asNum(words[k]))); k++; }
      partTokens.push(label.join(" "));
      i = k - 1;
      continue;
    }
    if (/^\d+$/.test(w)) { partTokens.push(w); continue; }
    if (GROUP_DRESSING.has(w)) continue;
    // A lone letter (either alphabet) is an initial or a detached
    // prefix/article, never the sefer's name.
    if (w.length === 1) continue;
    coreSet.add(w);
  }
  const core = [...coreSet].sort();
  return {
    core,
    coreKey: core.join(" "),
    count,
    part: partTokens.join(" "),
    sizeClass,
    binding,
    isSet,
    editions: [...editions].sort(),
  };
}

// Hard conflicts: stated facts that cannot both describe one item.
// Missing facts never conflict — that is what the AI check is for.
function signaturesConflict(a, b) {
  if (a.count !== null && b.count !== null && a.count !== b.count) return true;
  if (a.part && b.part && a.part !== b.part) return true;
  if ((a.count !== null && b.part) || (b.count !== null && a.part)) return true;
  // A stated set (even with no volume count) is never one volume of it.
  if ((a.isSet && b.part) || (b.isSet && a.part)) return true;
  if (a.sizeClass && b.sizeClass && a.sizeClass !== b.sizeClass) return true;
  if (a.binding && b.binding && a.binding !== b.binding) return true;
  if (a.editions.length && b.editions.length && a.editions.join(",") !== b.editions.join(",")) return true;
  return false;
}

function groupProducts(entries) {
  const sigs = entries.map((e) => productSignature(e.title));
  const byPrice = (x, y) => (entries[x].priceAmount ?? 1e12) - (entries[y].priceAmount ?? 1e12);
  const order = entries.map((_, i) => i).sort(byPrice);
  const groups = [];
  const byCore = new Map();
  const strictSame = (a, b) =>
    a.count === b.count && a.part === b.part && a.sizeClass === b.sizeClass && a.binding === b.binding && a.isSet === b.isSet;
  for (const idx of order) {
    const sig = sigs[idx];
    let placed = false;
    if (sig.coreKey) {
      for (const gi of byCore.get(sig.coreKey) ?? []) {
        const g = groups[gi];
        if (g.stores.has(entries[idx].storeId)) continue;
        // A volume/part label stated on one side only is NOT a rule
        // match: the unlabelled listing may be a different volume (a
        // "Living Tehillim" grouped with "Living Tehillim Vol. 4" in
        // testing). Such pairs still go to the AI check as candidates
        // — signaturesConflict deliberately does not flag them.
        const fits = g.members.every((mi) =>
          !signaturesConflict(sigs[mi], sig) && (sigs[mi].part || "") === (sig.part || "") &&
          (sig.core.length > 1 || strictSame(sigs[mi], sig)));
        if (fits) {
          g.members.push(idx);
          g.stores.add(entries[idx].storeId);
          placed = true;
          break;
        }
      }
    }
    if (!placed) {
      groups.push({ members: [idx], stores: new Set([entries[idx].storeId]) });
      if (sig.coreKey) {
        if (!byCore.has(sig.coreKey)) byCore.set(sig.coreKey, []);
        byCore.get(sig.coreKey).push(groups.length - 1);
      }
    }
  }
  return groups.map((g) => g.members.map((i) => entries[i]).sort((a, b) => (a.priceAmount ?? 1e12) - (b.priceAmount ?? 1e12)));
}

// Pairs the rules could not settle, best first, for the AI check:
// different stores, not already grouped together, no hard conflict,
// and cores that overlap meaningfully.
function matchCandidates(entries, groups) {
  const groupOf = new Map();
  groups.forEach((members, gi) => members.forEach((e) => groupOf.set(e, gi)));
  const sigOf = new Map(entries.map((e) => [e, productSignature(e.title)]));
  const out = [];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i];
      const b = entries[j];
      if (a.storeId === b.storeId) continue;
      if (groupOf.get(a) === groupOf.get(b)) continue;
      const sa = sigOf.get(a);
      const sb = sigOf.get(b);
      if (!sa.core.length || !sb.core.length) continue;
      if (signaturesConflict(sa, sb)) continue;
      const setB = new Set(sb.core);
      const inter = sa.core.filter((w) => setB.has(w)).length;
      if (!(inter >= 2 || (inter >= 1 && sa.core.length <= 3 && sb.core.length <= 3))) continue;
      const union = new Set([...sa.core, ...sb.core]).size;
      let score = inter / union;
      // Two listings that agree on the volume count are very likely
      // the same set wearing different title dressing — ask about
      // them ahead of the general shared-word crowd. (With a cap of
      // 16 these pairs were crowded out entirely on big searches:
      // the 5-volume Tehillim sets never reached the AI at all.)
      if (sa.count != null && sa.count === sb.count) score = Math.max(score, 0.9);
      // One title fully containing the other — the classic "same
      // book, one store appends the author's name" case ("Healthy
      // Habits" vs "Healthy Habits - Rivka Schonfeld") — is the
      // strongest candidate there is; always send it first.
      if (inter === Math.min(sa.core.length, sb.core.length) && inter >= 2) score = 0.95;
      out.push({ a, b, score });
    }
  }
  out.sort((x, y) => y.score - x.score);
  return out.slice(0, 40);
}

// ---------------------------------------------------------------------------
// Relevance filtering
// ---------------------------------------------------------------------------
// Some stores' search is OR-loose: "minchas elazar" returns every
// "Minchas …" and every "… Elazar" on the site (145 listings, most of
// them irrelevant). Ranking alone cannot fix a flood like that, so
// for a multi-word query the merged results are FILTERED before
// display: a listing stays only if its title matches every query
// word (canonicalized through the Hebrew bridge, with the same
// edit-distance tolerance the ranker uses, so spelling variants
// count). When too few listings match every word, one-word-short
// matches are kept instead; single-word queries are never filtered.
// ---------------------------------------------------------------------------
const SEARCH_FILTER_STOPWORDS = new Set([
  "the", "a", "an", "of", "for", "with", "and", "or", "in", "on",
  "sefer", "book", "books", "edition", "editions",
]);
function filterRelevant(products, query) {
  const foldShut = (s) => String(s || "").replace(/שו["'׳״]ת/g, " shut ");
  const qWords = [...new Set(canonWords(normWords(foldShut(query)))
    .filter((w) => !SEARCH_FILTER_STOPWORDS.has(w)))];
  if (qWords.length < 2) return products;
  const matchedCount = (title) => {
    const tWords = canonWords(normWords(foldShut(title)));
    return qWords.reduce((n, w) => {
      const tol = Math.max(1, Math.floor(w.length / 3));
      return n + (tWords.some((tw) => levenshtein(w, tw) <= tol) ? 1 : 0);
    }, 0);
  };
  const full = products.filter((p) => matchedCount(p.title) === qWords.length);
  // Four or more full matches are a real result set — returning the
  // one-word-short flood alongside them would defeat the filter.
  if (full.length >= 4) return full;
  const near = products.filter((p) => matchedCount(p.title) >= qWords.length - 1);
  return near.length ? near : products;
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
  sortProducts,
  productSignature,
  signaturesConflict,
  groupProducts,
  matchCandidates,
  filterRelevant
};
