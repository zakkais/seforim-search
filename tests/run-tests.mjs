// Seforim Search — pre-commit test gate.
//
// Run before pushing:  node tests/run-tests.mjs
// With live smoke:     node tests/run-tests.mjs --live
//
// What it checks, and why (each line is a failure that actually
// happened during the 2026-11-03 build-out):
//  1. Syntax of app.js / ui.js / worker.js — a broken file must
//     never reach the site.
//  2. Asset versions — index.html and ui.js must reference the
//     versions recorded in EXPECTED below. When you bump a version,
//     update EXPECTED in the same change; the phone's cache serves
//     stale files when versions drift.
//  3. Language parity — every dictionary in ui.js carries the same
//     keys, so no language shows a raw key or a missing label.
//  4. Search logic regressions — ranking, grouping, match
//     candidates, and the relevance filter against fixed cases
//     (the Minchas Elazar ranking bug, the set-vs-volume merge,
//     the author-name suffix, the Living Tehillim volume split).
//  5. Worker behaviour with stubbed stores — above all the
//     subrequest budget for /chat: the full search path across six
//     stores once exceeded the platform limit and the AI call
//     itself failed ("Too many subrequests"). The stub counts
//     fetches; /chat must stay well under the limit.
//  6. --live only: the same headline cases against the deployed
//     worker's real data.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LIVE = process.argv.includes("--live");
let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ""}`); }
}
const section = (s) => console.log(`\n${s}`);

// ---------------------------------------------------------------------------
section("1. Syntax");
{
  const tmp = mkdtempSync(join(tmpdir(), "ssp-tests-"));
  for (const f of ["app.js", "ui.js", "worker.js"]) {
    const p = join(tmp, f.replace(/\.js$/, ".mjs"));
    writeFileSync(p, readFileSync(join(ROOT, f)));
    try {
      execFileSync(process.execPath, ["--check", p], { stdio: "pipe" });
      check(`syntax: ${f}`, true);
    } catch (e) {
      check(`syntax: ${f}`, false, String(e.stderr || e).slice(0, 200));
    }
  }
}

// ---------------------------------------------------------------------------
section("2. Asset versions");
const EXPECTED = { ui: 25, styles: 13, app: 13 };
{
  const indexHtml = readFileSync(join(ROOT, "index.html"), "utf8");
  const uiSrc = readFileSync(join(ROOT, "ui.js"), "utf8");
  const vUi = Number(/ui\.js\?v=(\d+)/.exec(indexHtml)?.[1]);
  const vCss = Number(/styles\.css\?v=(\d+)/.exec(indexHtml)?.[1]);
  const vApp = Number(/app\.js\?v=(\d+)/.exec(uiSrc)?.[1]);
  check("index.html + ui.js versions match EXPECTED (bump both together)",
    vUi === EXPECTED.ui && vCss === EXPECTED.styles && vApp === EXPECTED.app,
    `found ui=${vUi} styles=${vCss} app=${vApp}, expected ${JSON.stringify(EXPECTED)}`);
}

// ---------------------------------------------------------------------------
section("3. Language parity in ui.js");
{
  const uiSrc = readFileSync(join(ROOT, "ui.js"), "utf8");
  const heads = [...uiSrc.matchAll(/^\s{2}(en|he|yi|es|fr): \{/gm)];
  check("five dictionaries found", heads.length === 5, `found ${heads.length}`);
  const keySets = {};
  heads.forEach((h, i) => {
    const seg = uiSrc.slice(h.index, i + 1 < heads.length ? heads[i + 1].index : h.index + 20000);
    // Blank out string contents first: a value like "Also searched
    // for: " must not register its own words as keys.
    const skeleton = seg.replace(/"(?:\\.|[^"\\])*"/g, '""');
    const keys = [...skeleton.matchAll(/([A-Za-z][A-Za-z0-9]*):/g)].map((m) => m[1]);
    keys.shift(); // the dictionary's own name (en/he/yi/es/fr) is not a key
    keySets[h[1]] = new Set(keys);
  });
  const en = keySets.en || new Set();
  for (const lang of ["he", "yi", "es", "fr"]) {
    const missing = [...en].filter((k) => !keySets[lang]?.has(k));
    check(`${lang} has every key en has`, missing.length === 0, `missing: ${missing.join(", ")}`);
  }
}

// ---------------------------------------------------------------------------
section("3b. Quick-view wiring (static)");
{
  const indexHtml = readFileSync(join(ROOT, "index.html"), "utf8");
  const uiSrc = readFileSync(join(ROOT, "ui.js"), "utf8");
  check("index.html has the quick-view modal", indexHtml.includes('id="qv-modal"'));
  check("cards carry a quick-view button", uiSrc.includes("data-qv-url"));
  check("quick view calls the worker /product endpoint", uiSrc.includes("/product?url="));
  check("group cards use dot indicators, not arrows",
    uiSrc.includes("carousel-indicators") && uiSrc.includes("data-bs-slide-to") && !uiSrc.includes("Previous store"));
  check("carousels are instantiated so swipe works without a first tap",
    uiSrc.includes("bootstrap.Carousel.getOrCreateInstance"));
  check("search form lives inside the sticky nav",
    indexHtml.indexOf('id="search-form"') > indexHtml.indexOf("<nav") &&
    indexHtml.indexOf('id="search-form"') < indexHtml.indexOf("</nav>"));
}

// ---------------------------------------------------------------------------
section("4. Search logic (app.js fixtures)");
const app = await import(pathToFileURL(join(ROOT, "app.js")).href);
const P = (title, storeId, priceAmount) => ({
  title, storeId, priceAmount,
  url: `https://example.invalid/${storeId}/${encodeURIComponent(title)}`,
  priceText: priceAmount == null ? null : `$${priceAmount}`,
});
{
  // Query expansion: Hebrew form present for a bridge-covered query;
  // an ISBN is never expanded.
  const variants = app.expandQuery("minchas elazar");
  check("expandQuery adds the Hebrew form", variants.includes("מנחת אלעזר"), JSON.stringify(variants));
  check("expandQuery never expands an ISBN", app.expandQuery("9781422627587").length === 1);

  // Ranking: the real Minchas Elazar (Hebrew title) must not sink
  // below partial matches; a title typed exactly as searched beats
  // a bridge-equivalent spelling.
  const pool = [
    P("Minchas Asher - Bava Kama", "seforimdeals", 19),
    P("Minchas Chinuch", "zberman", 49),
    P('שו"ת מנחת אלעזר עוז והדר - ה כרכים', "seforimdeals", 150),
    P("Journey To Jerusalem - Minchas Elazar", "hamafitz", 25),
  ];
  const ranked = app.sortProducts(pool, "priority", "minchas elazar");
  check("ranking: the Shut outranks one-word matches",
    ranked.findIndex((p) => p.title.includes("מנחת אלעזר")) <
    ranked.findIndex((p) => p.title.startsWith("Minchas Asher")));
  const spell = app.sortProducts(
    [P("Mishna Brura", "zberman", 40), P("Mishnah Berurah", "seforimdeals", 40)],
    "priority", "mishnah berurah");
  check("ranking: as-typed spelling wins", spell[0].title === "Mishnah Berurah");

  // Grouping rules.
  const groupsOf = (list) => app.groupProducts(list);
  const sameGroup = (groups, a, b) => groups.some((g) => g.includes(a) && g.includes(b));
  {
    const set = P("Lessons In Tanya - Large Set", "zberman", 110);
    const set2 = P("Lessons in Tanya - 5 Vol. Set - New Edition", "seforimdeals", 120);
    const vol1 = P("Lessons In Tanya Volume 1 PB", "seforimdeals", 21.95);
    const g = groupsOf([set, set2, vol1]);
    check("grouping: the two Lessons In Tanya sets group", sameGroup(g, set, set2));
    check("grouping: a set never swallows Volume 1", !sameGroup(g, set, vol1));
  }
  {
    const alef = P("Mesivta - Shabbos - Small - Chelek Alef", "seforimdeals", 30);
    const beis = P("Mesivta - Shabbos - Small - Chelek Beis", "zberman", 30);
    check("grouping: Chelek Alef and Chelek Beis stay apart", !sameGroup(groupsOf([alef, beis]), alef, beis));
  }
  {
    const vol4 = P("Living Tehillim - Vol. 4", "seforimdeals", 22);
    const plain = P("Living Tehillim", "hamafitz", 23.95);
    check("grouping: a stated volume does not group with an unstated one",
      !sameGroup(groupsOf([vol4, plain]), vol4, plain));
  }
  {
    const a = P("Mishnah Berurah Ohr Olam Vol. 3A", "seforimdeals", 40);
    const b = P("Mishnah Berurah Ohr Olam Vol. 3A", "zberman", 48);
    check("grouping: identical Ohr Olam volumes group", sameGroup(groupsOf([a, b]), a, b));
  }
  check("conflict: different volume counts",
    app.signaturesConflict(app.productSignature("Tanya 3 Vol Set"), app.productSignature("Tanya 5 Vol Set")) === true);
  check("conflict: a set vs a single volume",
    app.signaturesConflict(app.productSignature("Lessons In Tanya Set"), app.productSignature("Lessons In Tanya Volume 1")) === true);

  // Match candidates: the author-name suffix is the top candidate.
  {
    const plain = P("Healthy Habits", "seforimdeals", 22.5);
    const named = P("Healthy Habits - Rivka Schonfeld", "zberman", 19.95);
    const cands = app.matchCandidates([plain, named], [[plain], [named]]);
    check("candidates: author-suffix pair is offered", cands.length === 1 && cands[0].score === 0.95,
      JSON.stringify(cands.map((c) => c.score)));
  }
  {
    // Packaging and translation dressing must not split a set:
    // "Psalms" canonicalizes to tehillim, "shrink wrapped" and
    // "slipcased" are packaging, not editions (Zakkai's screenshots,
    // 2026-11-03 night).
    const zb2 = P("Tehillim / Psalms - 2 Volume Set", "zberman", 55);
    const sd2 = P("Tehillim - Psalms - 2 Vol Shrink Wrapped Set", "seforimdeals", 64.99);
    check("grouping: Tehillim 2-vol, shrink-wrapped vs plain, groups",
      sameGroup(groupsOf([zb2, sd2]), zb2, sd2));
    const zb5 = P("Tehillim - 5 Volume Personal - Size Set", "zberman", 59);
    const sd5 = P("Tehillim-Psalms - 5 Volume Slipcased Personal Size Set", "seforimdeals", 59.99);
    check("grouping: Tehillim 5-vol personal-size, slipcased vs plain, groups",
      sameGroup(groupsOf([zb5, sd5]), zb5, sd5));
    // Tehillos Menachem: spelling variants (Tehillas/Tehillos/
    // תהלות) and the word "perush" must not split the 1-volume
    // Tehillim — but its 5-volume set must NEVER merge with it.
    const esichaTm = P("Tehillim – Tehillas Menachem", "esicha", 18);
    const dealsTm = P("Tehillim With Perush Tehillos Menachem - תהלים עם פירוש תהלות מנחם", "seforimdeals", 22);
    check("grouping: Tehillim Tehillos Menachem 1-vol groups across spellings",
      sameGroup(groupsOf([esichaTm, dealsTm]), esichaTm, dealsTm));
    const zbTm5 = P("Tehillim - Tehillos Menachem - 5 Vol Set", "zberman", 60);
    check("grouping: the 5-vol Tehillos Menachem set stays apart from the 1-vol",
      !sameGroup(groupsOf([zbTm5, esichaTm]), zbTm5, esichaTm));
    // A store listing the identical product twice (slipcase page +
    // shrink-wrapped page) joins the group as another slide.
    const zbA = P("Tehillim / Psalms - 2 Volume Set", "zberman", 55);
    const sdSlip = P("Tehillim - Psalms - 2 Vol. Set", "seforimdeals", 58);
    const sdShrink = P("Tehillim - Psalms - 2 Vol Shrink Wrapped Set", "seforimdeals", 64.99);
    const gSame = groupsOf([zbA, sdSlip, sdShrink]);
    check("grouping: identical same-store duplicate joins the group",
      gSame.length === 1 && gSame[0].length === 3, JSON.stringify(gSame.map((g) => g.length)));
    const deals = P("Living Lessons Pirkei Avos - Hardcover", "seforimdeals", 32.39);
    const zb = P("Pirkei Avos Living lessons H/C- Yahadus - Weiss Edition", "zberman", 30);
    const cands = app.matchCandidates([deals, zb], [[deals], [zb]]);
    check("candidates: Pirkei Avos publisher/editor pair is offered",
      cands.length === 1 && cands[0].score >= 0.9, JSON.stringify(cands.map((c) => c.score)));
  }
  {
    // The candidate cap: with a crowd of shared-word listings the
    // subset pair must still be inside the (now 40) sent set.
    const target1 = P("Sefer Alpha Beta", "seforimdeals", 10);
    const target2 = P("Sefer Alpha Beta - Plus Dressing Words Here", "zberman", 12);
    const crowd = [];
    for (let i = 0; i < 60; i++) crowd.push(P(`Sefer Alpha Gamma ${i}`, i % 2 ? "zberman" : "hamafitz", 20 + i));
    const entries = [target1, target2, ...crowd];
    const cands = app.matchCandidates(entries, entries.map((e) => [e]));
    check("candidates: cap is 40 and the subset pair survives a crowd",
      cands.length <= 40 && cands.some((c) => (c.a === target1 && c.b === target2) || (c.a === target2 && c.b === target1)),
      `${cands.length} candidates`);
  }

  // Relevance filter.
  {
    const full = ["Minchas Elazar A", "Minchas Elazar B", "Minchas Elazar C", "Minchas Elazar D"]
      .map((t, i) => P(t, "seforimdeals", 10 + i));
    const oneWord = ["Minchas Asher", "Minchas Chinuch", "Elazar Shalom", "Minchas Yehuda", "Elazar Cohen", "Minchas David"]
      .map((t, i) => P(t, "zberman", 20 + i));
    const kept = app.filterRelevant([...full, ...oneWord], "minchas elazar");
    check("filter: with 4+ full matches, one-word matches are dropped",
      kept.length === 4 && kept.every((p) => full.includes(p)), `kept ${kept.length}`);
    const all = [P("Tanya", "zberman", 30), P("Tanya in a Nutshell", "seforimdeals", 9)];
    check("filter: single-word queries are never filtered",
      app.filterRelevant(all, "tanya").length === 2);
  }
}

// ---------------------------------------------------------------------------
section("5. Worker with stubbed stores");
{
  const realFetch = globalThis.fetch;
  let fetchCalls = 0;
  const wooProducts = Array.from({ length: 30 }, (_, i) => ({
    name: `Tanya Stub Volume ${i + 1}`,
    permalink: `https://www.esicha.org/product/tanya-stub-${i + 1}`,
    prices: { price: "2500", regular_price: "2500", currency_minor_unit: 2 },
    images: [], is_in_stock: true,
  }));
  const dealsHtml = Array.from({ length: 12 }, (_, i) =>
    `<div class="product-item "><a href="/products/tanya-deal-${i + 1}" class="product-item__title">Tanya Deal ${i + 1}</a><span class="price--highlight">$${(10 + i).toFixed(2)}</span></div>`
  ).join("\n");
  const qvHtml = `<html><head><meta property="og:image" content="https://www.esicha.org/wp-content/uploads/qv-main.jpg"><meta property="og:title" content="QV Stub Sefer"></head><body>` +
    `<div id="tab-description"><p>Quick view stub description: a full paragraph about this sefer, its author and its contents, long enough to count as a real description.</p></div>` +
    `<img src="https://www.esicha.org/wp-content/uploads/qv-second.jpg"></body></html>`;
  globalThis.fetch = async (url) => {
    fetchCalls++;
    const u = String(url);
    if (u.includes("qv-stub")) return new Response(qvHtml, { status: 200 });
    if (u.includes("esicha.org")) return new Response(JSON.stringify(wooProducts), { status: 200 });
    if (u.includes("seforimdeals.com") && u.includes(".js")) return new Response(JSON.stringify({ available: true, title: "Tanya Deal", variants: [], images: [{ src: "https://cdn.example.invalid/deal-1.jpg" }, { src: "https://cdn.example.invalid/deal-2.jpg" }], description: "<p>A fine sefer with a full description.</p>" }), { status: 200 });
    if (u.includes("seforimdeals.com")) return new Response(dealsHtml, { status: 200 });
    if (u.includes("chabadlibrary.org")) return new Response(JSON.stringify({ count: 0, results: [] }), { status: 200 });
    return new Response("", { status: 200 });
  };
  const kvStore = new Map();
  const env = {
    SEFORIM_KV: {
      get: async (k) => kvStore.get(k) ?? null,
      put: async (k, v) => { kvStore.set(k, String(v)); },
    },
    AI: {
      run: async (model, input) => {
        const sys = input?.messages?.[0]?.content || "";
        return { response: sys.includes("compare pairs") ? "[true]" : "Stub answer." };
      },
    },
  };
  const ctx = { waitUntil: (p) => { if (p && p.catch) p.catch(() => {}); } };
  const worker = (await import(pathToFileURL(join(ROOT, "worker.js")).href)).default;
  const call = (path, init) => worker.fetch(new Request(`https://worker.test${path}`, init), env, ctx);

  fetchCalls = 0;
  const chatRes = await call("/chat", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question: "tanya price" }),
  });
  const chatBody = await chatRes.json().catch(() => ({}));
  check("/chat answers with stubbed stores", chatRes.status === 200 && chatBody.answer === "Stub answer.",
    `status ${chatRes.status}, body ${JSON.stringify(chatBody).slice(0, 120)}`);
  check("/chat stays inside the subrequest budget", fetchCalls < 45, `${fetchCalls} fetches (platform limit is 50)`);

  const esichaRes = await call("/?store=esicha&q=tanya");
  const esichaBody = await esichaRes.json().catch(() => ({}));
  check("search: eSicha returns its products",
    esichaRes.status === 200 && esichaBody.results?.[0]?.products?.length === 30,
    `status ${esichaRes.status}, products ${esichaBody.results?.[0]?.products?.length}`);

  fetchCalls = 0;
  const dealsRes = await call("/?store=seforimdeals&q=tanya");
  const dealsBody = await dealsRes.json().catch(() => ({}));
  check("search: SeforimDeals returns its products",
    dealsRes.status === 200 && dealsBody.results?.[0]?.products?.length === 12,
    `status ${dealsRes.status}, products ${dealsBody.results?.[0]?.products?.length}`);
  check("search: one store's full path stays inside the budget", fetchCalls < 45, `${fetchCalls} fetches`);

  const qvDeals = await call(`/product?url=${encodeURIComponent("https://seforimdeals.com/products/tanya-deal-1")}`);
  const qvDealsBody = await qvDeals.json().catch(() => ({}));
  check("/product returns a Shopify gallery + description",
    qvDeals.status === 200 && qvDealsBody.images?.length === 2 && String(qvDealsBody.description).includes("fine sefer"),
    `status ${qvDeals.status}, body ${JSON.stringify(qvDealsBody).slice(0, 140)}`);
  const qvHtmlRes = await call(`/product?url=${encodeURIComponent("https://www.esicha.org/product/qv-stub")}`);
  const qvHtmlBody = await qvHtmlRes.json().catch(() => ({}));
  check("/product extracts gallery + description from a product page",
    qvHtmlRes.status === 200 && qvHtmlBody.images?.some((s) => s.includes("qv-main.jpg")) &&
    String(qvHtmlBody.description).includes("Quick view stub description"),
    `status ${qvHtmlRes.status}, body ${JSON.stringify(qvHtmlBody).slice(0, 140)}`);
  const qvBad = await call(`/product?url=${encodeURIComponent("https://evil.example.invalid/x")}`);
  check("/product refuses non-store hosts", qvBad.status === 400, `status ${qvBad.status}`);

  const matchRes = await call("/match", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pairs: [{ a: { title: "Healthy Habits" }, b: { title: "Healthy Habits - Rivka Schonfeld" } }] }),
  });
  const matchBody = await matchRes.json().catch(() => ({}));
  check("/match returns a verdict", matchRes.status === 200 && matchBody.verdicts?.[0]?.same === true,
    `status ${matchRes.status}, body ${JSON.stringify(matchBody).slice(0, 120)}`);

  globalThis.fetch = realFetch;
}

// ---------------------------------------------------------------------------
if (LIVE) {
  section("6. Live smoke (deployed worker, real data)");
  const W = "https://seforim-search.zakkaishusterman01.workers.dev";
  const STORE_IDS = ["zberman", "seforimdeals", "seforimplace", "hamafitz", "greenfield", "esicha"];
  const mergedFor = async (q) => {
    const byUrl = new Map();
    for (const variant of app.expandQuery(q)) {
      for (const s of STORE_IDS) {
        try {
          const r = await fetch(`${W}/?store=${s}&q=${encodeURIComponent(variant)}`);
          const d = await r.json();
          for (const rr of d.results || []) for (const p of rr.products || []) {
            if (!byUrl.has(p.url)) byUrl.set(p.url, { ...p, storeId: rr.store || s });
          }
        } catch { /* a store being down must not fail the gate */ }
      }
    }
    return [...byUrl.values()];
  };
  const me = await mergedFor("minchas elazar");
  const kept = app.filterRelevant(me, "minchas elazar");
  check("live: minchas elazar is filtered to a focused set", kept.length >= 1 && kept.length <= 8,
    `${me.length} merged -> ${kept.length} kept`);
  check("live: the Oz Vehadar Shut survives the filter",
    kept.some((p) => String(p.title).includes("מנחת אלעזר")));
  const tanya = await mergedFor("tanya");
  const tGroups = app.groupProducts(tanya);
  check("live: Living Lessons Tanya groups across stores",
    tGroups.some((g) => g.length >= 2 && g.some((p) => /Living Lessons/i.test(p.title))));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
