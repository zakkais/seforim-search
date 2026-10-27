// Seforim Search (public) — static UI.
// All searching happens in the visitor's browser (see app.js for the store
// parsers and fetch chain). Store selections and the sort choice are kept
// in localStorage only. No accounts, no checkout, no tracking.

import { STORES, WORKER_URL, expandQuery, searchStore, sortProducts } from "./app.js";

const LS_STORES = "ssp:store-selection";
const LS_SORT = "ssp:sort-mode";
const EXAMPLES = ["midrash rabbah", "tanya", "mishnah berurah", "tehillim", "likkutei sichos"];

const $ = (sel) => document.querySelector(sel);

function loadSelection() {
  const sel = {};
  for (const s of STORES) sel[s.id] = true;
  try {
    const parsed = JSON.parse(localStorage.getItem(LS_STORES) || "{}");
    for (const s of STORES) {
      if (typeof parsed[s.id] === "boolean") sel[s.id] = parsed[s.id];
    }
  } catch { /* defaults stand */ }
  return sel;
}

function loadSort() {
  try {
    const v = localStorage.getItem(LS_SORT);
    if (v === "price-asc" || v === "price-desc" || v === "alpha-asc" || v === "alpha-desc" || v === "priority") return v;
  } catch { /* ignore */ }
  return "price-asc";
}

function saveLocal(key, value) {
  try { localStorage.setItem(key, value); } catch { /* ignore */ }
}

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

let selection = loadSelection();
let sortMode = loadSort();
let activeQuery = "";
let activeVariants = [];
let results = {}; // storeId -> StoreResult
let runId = 0;

const enabledStores = () => STORES.filter((s) => selection[s.id]);

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderStoreChecks() {
  const wrap = $("#store-checks");
  wrap.innerHTML = STORES.map((s) => `
    <div class="col-12 col-sm-6">
      <div class="form-check py-2">
        <input class="form-check-input" type="checkbox" id="store-${s.id}"
               aria-label="Include ${esc(s.name)}"
               data-store="${s.id}" ${selection[s.id] ? "checked" : ""}>
        <label class="form-check-label" for="store-${s.id}">
          ${esc(s.name)}${s.note ? `<span class="text-secondary small ms-2">${esc(s.note)}</span>` : ""}
        </label>
      </div>
    </div>`).join("");
  wrap.querySelectorAll("input[data-store]").forEach((el) => {
    el.addEventListener("change", () => {
      toggleStore(el.getAttribute("data-store"), el.checked);
    });
  });
  renderStoresButton();
}

function renderStoresButton() {
  $("#stores-toggle-label").textContent =
    `Stores · ${enabledStores().length} of ${STORES.length} included`;
  $("#no-stores-warning").classList.toggle("d-none", enabledStores().length > 0);
  $("#search-btn").disabled = enabledStores().length === 0 || !$("#sefer-search").value.trim();
}

const BOOK_SVG = `<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V4a2 2 0 0 0-2-2H6.5A2.5 2.5 0 0 0 4 4.5v15Z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/></svg>`;
const FALLBACK_IMG = `<div class="product-img d-flex align-items-center justify-content-center text-secondary">${BOOK_SVG}</div>`;

function productCard(store, p) {
  const price = p.priceText
    ? `<span class="fw-bold price">${esc(p.priceText)}</span>` +
      (p.compareAtText
        ? `<span class="text-secondary text-decoration-line-through small ms-2">${esc(p.compareAtText)}</span>`
        : "")
    : `<span class="text-secondary small">Price at store</span>`;
  const img = p.imageUrl
    ? `<img src="${esc(p.imageUrl)}" alt="${esc(p.title)}" loading="lazy"
            class="w-100 product-img" onerror="this.outerHTML=window.__sspFallbackImg">`
    : FALLBACK_IMG;
  return `
    <div class="col">
      <div class="card h-100 shadow-sm position-relative product-card">
        <div class="p-2 pb-0">
          <div class="rounded product-img-wrap position-relative">${img}${p.compareAtText ? `<span class="sale-stamp">On sale</span>` : ""}</div>
        </div>
        <div class="card-body d-flex flex-column pt-2">
          <p class="store-badge mb-1"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 9l1.5-5h15L21 9"/><path d="M4 9v11a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V9"/><path d="M9 21V13h6v8"/></svg>${esc(store.name)}</p>
          <a href="${esc(p.url)}" target="_blank" rel="noopener noreferrer"
             class="stretched-link font-display fw-medium text-decoration-none product-title"
             aria-label="View ${esc(p.title)} at ${esc(store.name)}">${esc(p.title)}</a>
          <div class="mt-auto pt-2"><p class="mb-0">${price}</p></div>
        </div>
      </div>
    </div>`;
}

function renderResults() {
  const section = $("#results");
  if (!activeQuery) {
    section.innerHTML = "";
    $("#idle-state").classList.remove("d-none");
    return;
  }
  $("#idle-state").classList.add("d-none");
  const stores = enabledStores();
  const total = stores.reduce((n, s) => n + (results[s.id]?.products.length || 0), 0);
  const anyLoading = stores.some((s) => !results[s.id] || results[s.id].status === "loading");

  const extraVariants = activeVariants.filter((v) => v !== activeQuery.toLowerCase());
  let html = `
    <div class="d-flex flex-wrap align-items-baseline justify-content-between gap-2 pb-2 results-rule">
      <h2 class="font-display fw-semibold mb-0 results-title">Results for “${esc(activeQuery)}”</h2>
      ${anyLoading ? "" : `<p class="text-secondary small mb-0">${total} listing${total === 1 ? "" : "s"} loaded</p>`}
    </div>
    ${extraVariants.length ? `<p class="text-secondary small mb-0">Also searched for: ${extraVariants.map((v) => `“${esc(v)}”`).join(", ")}</p>` : ""}
    ${WORKER_URL ? "" : `<p class="text-secondary small mb-0">Fetching back-end not yet configured — results load directly from each store where the browser allows it. See README for the worker setup.</p>`}`;

  // One merged grid: products from every store are sorted together
  // (by price or alphabetically), each card still carrying its store
  // badge. Stores are never shown as separate sections.
  const loadingStores = stores.filter((s) => !results[s.id] || results[s.id].status === "loading");
  if (loadingStores.length) {
    html += `
      <div class="mt-3 d-flex align-items-center gap-2 text-secondary">
        <span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>
        <span>Searching ${loadingStores.map((s) => esc(s.name)).join(", ")}…</span>
      </div>`;
  }
  // Stores with no listings are simply left out — no error or empty
  // notice per store, per the site owner's preference.
  const merged = [];
  for (const store of stores) {
    const r = results[store.id];
    if (r && r.status === "ok") {
      for (const p of r.products) merged.push({ store, product: p });
    }
  }
  const sorted = sortProducts(merged.map((m) => m.product), sortMode, activeQuery);
  // sortProducts returns products, not pairs: re-pair by product identity
  // via a Map so each card keeps its store badge after a global sort.
  const byProduct = new Map(merged.map((m) => [m.product, m.store]));
  if (sorted.length) {
    html += `<div class="row row-cols-2 row-cols-md-3 row-cols-lg-4 g-3 mt-1">` +
      sorted.map((p) => productCard(byProduct.get(p), p)).join("") + `</div>`;
  } else if (!anyLoading) {
    html += `<p class="mt-3 p-3 rounded text-secondary empty-box">No listings matched “${esc(activeQuery)}” at the included stores.</p>`;
  }
  section.innerHTML = html;
}

// ---------------------------------------------------------------------------
// Search orchestration
// ---------------------------------------------------------------------------

function fetchOne(storeId, query, run) {
  const store = STORES.find((s) => s.id === storeId);
  if (!store) return;
  searchStore(store, query, activeVariants).then((r) => {
    if (run !== runId) return;
    results[storeId] = r;
    renderResults();
  });
}

function markLoading(store, query) {
  results[store.id] = {
    storeId: store.id,
    storeName: store.name,
    searchUrl: store.searchUrl(query),
    status: "loading",
    message: null,
    products: [],
  };
}

function runSearch(q) {
  const query = String(q || "").trim();
  if (!query || enabledStores().length === 0) return;
  $("#sefer-search").value = query;
  activeQuery = query;
  activeVariants = expandQuery(query);
  const run = ++runId;
  results = {};
  for (const s of enabledStores()) markLoading(s, query);
  renderResults();
  for (const s of enabledStores()) fetchOne(s.id, query, run);
}

function toggleStore(storeId, enabled) {
  selection[storeId] = enabled;
  saveLocal(LS_STORES, JSON.stringify(selection));
  renderStoresButton();
  if (enabled && activeQuery && !results[storeId]) {
    const store = STORES.find((s) => s.id === storeId);
    if (store) {
      markLoading(store, activeQuery);
      renderResults();
      fetchOne(storeId, activeQuery, runId);
    }
  } else if (activeQuery) {
    renderResults();
  }
}

function setAllStores(enabled) {
  for (const s of STORES) selection[s.id] = enabled;
  saveLocal(LS_STORES, JSON.stringify(selection));
  renderStoreChecks();
  if (enabled && activeQuery) {
    for (const s of STORES) {
      if (!results[s.id]) {
        markLoading(s, activeQuery);
        fetchOne(s.id, activeQuery, runId);
      }
    }
  }
  if (activeQuery) renderResults();
}

// ---------------------------------------------------------------------------
// Wire up
// ---------------------------------------------------------------------------

window.__sspFallbackImg = FALLBACK_IMG;

document.addEventListener("DOMContentLoaded", () => {
  renderStoreChecks();

  const sortSel = $("#sort-select");
  sortSel.value = sortMode;
  sortSel.addEventListener("change", () => {
    sortMode = sortSel.value;
    saveLocal(LS_SORT, sortMode);
    renderResults();
  });

  $("#stores-toggle").addEventListener("click", () => {
    const panel = $("#stores-panel");
    const open = panel.classList.toggle("d-none") === false;
    $("#stores-toggle").setAttribute("aria-expanded", String(open));
    $("#stores-caret").textContent = open ? "▴" : "▾";
  });

  $("#select-all").addEventListener("click", () => setAllStores(true));
  $("#clear-all").addEventListener("click", () => setAllStores(false));

  const input = $("#sefer-search");
  input.addEventListener("input", renderStoresButton);
  $("#search-form").addEventListener("submit", (e) => {
    e.preventDefault();
    runSearch(input.value);
  });

  $("#examples").innerHTML = EXAMPLES.map((ex) =>
    `<button type="button" class="btn btn-sm rounded-pill example-chip text-capitalize" data-q="${esc(ex)}">${esc(ex)}</button>`
  ).join("");
  $("#examples").querySelectorAll("button[data-q]").forEach((b) => {
    b.addEventListener("click", () => runSearch(b.getAttribute("data-q")));
  });

  renderStoresButton();
});
