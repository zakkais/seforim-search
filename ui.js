// Seforim Search — page logic (runs in the visitor's browser).
//
// What this file does: it renders the page (store checkboxes, the merged
// results grid, the wishlist view), runs searches through app.js, and
// wires up the optional Google sign-in. Searching itself, the store
// list, the spelling variants, and the sorting all live in app.js —
// this file only calls them and draws what they return.
//
// What it depends on — do not rename casually:
// - Every element id used here (sefer-search, search-form, sort-select,
//   stores-panel, store-checks, results, wishlist-view, nav-panel, ...)
//   must match index.html, or that control silently stops working.
// - The import above must keep pointing at app.js (with its ?v=
//   version, so visitors get a fresh copy when app.js changes).
// - GOOGLE_CLIENT_ID below is public, not a secret — but it must match
//   the client id the worker was deployed with, or sign-in fails.
//   Never put a client secret in this file: sign-in needs none (the
//   worker verifies Google's signed ID token itself).
//
// What is kept where: store choices, the sort choice, and the wishlist
// live in this browser's localStorage (keys below). When the visitor
// signs in with Google, the wishlist is also synced to the worker,
// which merges the browser copy with the server copy (see
// syncWishlistFromServer) — so signing in never wipes a local list.
// Searching stays open without signing in, and there is no checkout
// and no tracking in this file.

import { STORES, WORKER_URL, expandQuery, searchStore, sortProducts } from "./app.js?v=3";

const LS_STORES = "ssp:store-selection";
const LS_SORT = "ssp:sort-mode";
const LS_WISHLIST = "ssp:wishlist";
const LS_LANG = "ssp:lang";
// Languages for the footer switcher (index.html). English is the
// default and stays available so visitors can always switch back.
// Hebrew and Yiddish flip the page to right-to-left (see
// applyLanguage). The non-English wordings are a first draft — product
// titles, prices, and store names always stay exactly as the stores
// list them, whatever the interface language is.
const LANGS = [
  { code: "en", dir: "ltr" },
  { code: "he", dir: "rtl" },
  { code: "yi", dir: "rtl" },
  { code: "es", dir: "ltr" },
  { code: "fr", dir: "ltr" },
];
const I18N = {
  en: {
    language: "Language:", account: "Account", wishlist: "Wishlist", external: "External resources",
    authNote: "Sign in with Google to sync your wishlist across devices. Searching stays open without signing in.",
    signedInAs: "Signed in as", signOut: "Sign out", myWishlist: "My wishlist",
    searchPlaceholder: "Search", search: "Search", sortBy: "Sort by",
    "sort_price-asc": "Price: low to high", "sort_price-desc": "Price: high to low",
    sort_priority: "Priority: closest match", "sort_alpha-asc": "Title: A to Z", "sort_alpha-desc": "Title: Z to A",
    includeInSearch: "Include in search", selectAll: "Select all", clear: "Clear",
    noStores: "No stores are included — tick at least one to search.",
    storeChoicesNote: "Your store choices are kept in this browser only.",
    backToSearch: "Back to search", addTitleLabel: "Add a title to look up later",
    addTitlePlaceholder: "e.g. midrash rabbah", addTitle: "Add title",
    savedNote: "Saved in this browser, and synced across devices when you are signed in.",
    idleText: "Type a title above — in English or Hebrew — and this page gathers the matching listings, each with its own cover and price.",
    footerNote: "Listings, covers, and prices come live from each store's own website at search time. Searching needs no account; signing in with Google is optional and only syncs your wishlist. Your store choices and your local wishlist are kept in your own browser.",
    storesIncluded: "Stores · {n} of {total} included",
    save: "♡ Save", saved: "♥ Saved", remove: "Remove", onSale: "On sale", priceAtStore: "Price at store",
    resultsFor: "Results for “{q}”", listingsLoadedOne: "1 listing loaded", listingsLoadedOther: "{n} listings loaded",
    alsoSearchedFor: "Also searched for: ", searching: "Searching {stores}…",
    noListings: "No listings matched “{q}” at the included stores.",
    titlesToLookUp: "Titles to look up later — tap one to search it:",
    savedListings: "Saved listings:",
    nothingSaved: "Nothing saved yet. Tap ♡ Save on any listing, or add a title above.",
  },
  he: {
    language: "שפה:", account: "חשבון", wishlist: "רשימת ספרים שמורים", external: "משאבים חיצוניים",
    authNote: "היכנסו עם גוגל כדי לסנכרן את רשימת הספרים השמורים בין מכשירים. החיפוש פתוח גם בלי להיכנס.",
    signedInAs: "מחובר/ת בתור", signOut: "התנתקות", myWishlist: "הספרים השמורים שלי",
    searchPlaceholder: "חיפוש", search: "חיפוש", sortBy: "מיון לפי",
    "sort_price-asc": "מחיר: מהנמוך לגבוה", "sort_price-desc": "מחיר: מהגבוה לנמוך",
    sort_priority: "עדיפות: ההתאמה הקרובה ביותר", "sort_alpha-asc": "כותרת: מא׳ עד ת׳", "sort_alpha-desc": "כותרת: מת׳ עד א׳",
    includeInSearch: "כלול בחיפוש", selectAll: "בחר הכל", clear: "נקה",
    noStores: "לא נבחרו חנויות — סמן לפחות חנות אחת לחיפוש.",
    storeChoicesNote: "בחירת החנויות נשמרת בדפדפן זה בלבד.",
    backToSearch: "חזרה לחיפוש", addTitleLabel: "הוסף כותרת לחיפוש מאוחר יותר",
    addTitlePlaceholder: "לדוגמה: מדרש רבה", addTitle: "הוסף כותרת",
    savedNote: "נשמר בדפדפן זה, ומסונכרן בין מכשירים כשאתה מחובר.",
    idleText: "הקלד כותרת למעלה — בעברית או באנגלית — והדף יאסוף את המודעות המתאימות, כל אחת עם הכריכה והמחיר שלה.",
    footerNote: "המודעות, הכריכות והמחירים מגיעים בשידור חי מאתר כל חנות בעת החיפוש. החיפוש אינו דורש חשבון; כניסה עם גוגל היא אופציונלית ורק מסנכרנת את רשימת הספרים השמורים. בחירת החנויות ורשימת הספרים המקומית נשמרות בדפדפן שלך.",
    storesIncluded: "חנויות · {n} מתוך {total} כלולות",
    save: "♡ שמור", saved: "♥ נשמר", remove: "הסר", onSale: "במבצע", priceAtStore: "מחיר בחנות",
    resultsFor: "תוצאות עבור “{q}”", listingsLoadedOne: "מודעה אחת נטענה", listingsLoadedOther: "{n} מודעות נטענו",
    alsoSearchedFor: "חיפשנו גם: ", searching: "מחפש ב־{stores}…",
    noListings: "לא נמצאו מודעות עבור “{q}” בחנויות הכלולות.",
    titlesToLookUp: "כותרות לחיפוש מאוחר יותר — לחץ על אחת כדי לחפש אותה:",
    savedListings: "מודעות שמורות:",
    nothingSaved: "עדיין לא נשמר דבר. לחץ ♡ שמור על כל מודעה, או הוסף כותרת למעלה.",
  },
  yi: {
    language: "שפּראַך:", account: "חשבון", wishlist: "ווישליסט", external: "דרויסנדיקע רעסורסן",
    authNote: "צייכנט אײַן מיט גוגל כּדי צו סינקראָניזירן אײַער ווישליסט צווישן דיווייסעס. זוכן בלײַבט אָפֿן אָן אײַנצייכענען.",
    signedInAs: "אײַנגעצייכנט ווי", signOut: "אַרויסצייכענען", myWishlist: "מיין ווישליסט",
    searchPlaceholder: "זוכן", search: "זוכן", sortBy: "סאָרטירן לויט",
    "sort_price-asc": "פּרײַז: פֿון ביליק צום טײַער", "sort_price-desc": "פּרײַז: פֿון טײַער צום ביליק",
    sort_priority: "פּריאָריטעט: דער נענסטער טרעפֿ", "sort_alpha-asc": "טיטל: פֿון א ביז ת", "sort_alpha-desc": "טיטל: פֿון ת ביז א",
    includeInSearch: "אַרײַננעמען אין זוכן", selectAll: "קלייַב אַלץ", clear: "ליידיקן",
    noStores: "קיין קראָמען זענען נישט אַרײַנגענומען — קלייַב אויס כאָטש איין קראָם צום זוכן.",
    storeChoicesNote: "אײַערע קראָם־קלייַבן ווערן געהאַלטן נאָר אין דעם בלעטערער.",
    backToSearch: "צוריק צום זוכן", addTitleLabel: "לייג צו אַ טיטל צו זוכן שפּעטער",
    addTitlePlaceholder: "למשל: מדרש רבה", addTitle: "לייג צו",
    savedNote: "געהאַלטן אין דעם בלעטערער, און סינקראָניזירט צווישן דיווייסעס ווען איר זענט אײַנגעצייכנט.",
    idleText: "שרײַבט אַ טיטל אויבן — אויף ענגליש אָדער העברעיִש — און דער בלאַט וועט צונויפֿזאַמלען די פּאַסיקע ליסטינגס, יעדע מיט איר דעקל און פּרײַז.",
    footerNote: "ליסטינגס, דעקלעך און פּרײַזן קומען לעבעדיק פֿון יעדער קראָם׳ס אייגענער וועבזײַט בעת דעם זוכן. זוכן דאַרף קיין חשבון; אײַנצייכענען מיט גוגל איז פֿרײַוויליק און סינקראָניזירט נאָר אײַער ווישליסט. אײַערע קראָם־קלייַבן און לאָקאַלע ווישליסט ווערן געהאַלטן אין אײַער בלעטערער.",
    storesIncluded: "קראָמען · {n} פֿון {total} אַרײַנגענומען",
    save: "♡ האַלטן", saved: "♥ געהאַלטן", remove: "אַראָפּנעמען", onSale: "אויף סעיל", priceAtStore: "פּרײַז אין קראָם",
    resultsFor: "רעזולטאַטן פֿאַר “{q}”", listingsLoadedOne: "1 ליסטינג געלאַדן", listingsLoadedOther: "{n} ליסטינגס געלאַדן",
    alsoSearchedFor: "אויך געזוכט: ", searching: "זוכן אין {stores}…",
    noListings: "קיין ליסטינגס האָבן נישט געפּאַסט “{q}” אין די אַרײַנגענומענע קראָמען.",
    titlesToLookUp: "טיטלען צו זוכן שפּעטער — קליקט אויף איינעם צו זוכן אים:",
    savedListings: "געהאַלטענע ליסטינגס:",
    nothingSaved: "נאָך גאָרנישט געהאַלטן. קליקט ♡ האַלטן אויף אַ ליסטינג, אָדער לייגט צו אַ טיטל אויבן.",
  },
  es: {
    language: "Idioma:", account: "Cuenta", wishlist: "Lista de deseos", external: "Recursos externos",
    authNote: "Inicia sesión con Google para sincronizar tu lista de deseos entre dispositivos. Buscar sigue abierto sin iniciar sesión.",
    signedInAs: "Sesión iniciada como", signOut: "Cerrar sesión", myWishlist: "Mi lista de deseos",
    searchPlaceholder: "Buscar", search: "Buscar", sortBy: "Ordenar por",
    "sort_price-asc": "Precio: de menor a mayor", "sort_price-desc": "Precio: de mayor a menor",
    sort_priority: "Prioridad: coincidencia más cercana", "sort_alpha-asc": "Título: de la A a la Z", "sort_alpha-desc": "Título: de la Z a la A",
    includeInSearch: "Incluir en la búsqueda", selectAll: "Seleccionar todo", clear: "Limpiar",
    noStores: "No hay tiendas incluidas — marca al menos una para buscar.",
    storeChoicesNote: "Tus tiendas elegidas se guardan solo en este navegador.",
    backToSearch: "Volver a buscar", addTitleLabel: "Añade un título para buscar más tarde",
    addTitlePlaceholder: "p. ej. midrash rabbah", addTitle: "Añadir título",
    savedNote: "Guardado en este navegador, y sincronizado entre dispositivos cuando has iniciado sesión.",
    idleText: "Escribe un título arriba — en inglés o en hebreo — y esta página reunirá los anuncios correspondientes, cada uno con su portada y precio.",
    footerNote: "Los anuncios, portadas y precios llegan en vivo desde el sitio web de cada tienda al buscar. Buscar no necesita cuenta; iniciar sesión con Google es opcional y solo sincroniza tu lista de deseos. Tus tiendas elegidas y tu lista local se guardan en tu navegador.",
    storesIncluded: "Tiendas · {n} de {total} incluidas",
    save: "♡ Guardar", saved: "♥ Guardado", remove: "Quitar", onSale: "En oferta", priceAtStore: "Precio en tienda",
    resultsFor: "Resultados para “{q}”", listingsLoadedOne: "1 anuncio cargado", listingsLoadedOther: "{n} anuncios cargados",
    alsoSearchedFor: "También se buscó: ", searching: "Buscando en {stores}…",
    noListings: "Ningún anuncio coincidió con “{q}” en las tiendas incluidas.",
    titlesToLookUp: "Títulos para buscar más tarde — toca uno para buscarlo:",
    savedListings: "Anuncios guardados:",
    nothingSaved: "Aún no has guardado nada. Toca ♡ Guardar en cualquier anuncio, o añade un título arriba.",
  },
  fr: {
    language: "Langue :", account: "Compte", wishlist: "Liste de souhaits", external: "Ressources externes",
    authNote: "Connectez-vous avec Google pour synchroniser votre liste de souhaits entre appareils. La recherche reste ouverte sans connexion.",
    signedInAs: "Connecté en tant que", signOut: "Se déconnecter", myWishlist: "Ma liste de souhaits",
    searchPlaceholder: "Rechercher", search: "Rechercher", sortBy: "Trier par",
    "sort_price-asc": "Prix : croissant", "sort_price-desc": "Prix : décroissant",
    sort_priority: "Priorité : correspondance la plus proche", "sort_alpha-asc": "Titre : de A à Z", "sort_alpha-desc": "Titre : de Z à A",
    includeInSearch: "Inclure dans la recherche", selectAll: "Tout sélectionner", clear: "Effacer",
    noStores: "Aucune boutique incluse — cochez-en au moins une pour rechercher.",
    storeChoicesNote: "Vos boutiques choisies sont conservées uniquement dans ce navigateur.",
    backToSearch: "Retour à la recherche", addTitleLabel: "Ajouter un titre à rechercher plus tard",
    addTitlePlaceholder: "p. ex. midrash rabbah", addTitle: "Ajouter un titre",
    savedNote: "Enregistré dans ce navigateur, et synchronisé entre appareils lorsque vous êtes connecté.",
    idleText: "Tapez un titre ci-dessus — en anglais ou en hébreu — et cette page rassemblera les annonces correspondantes, chacune avec sa couverture et son prix.",
    footerNote: "Les annonces, couvertures et prix proviennent en direct du site de chaque boutique au moment de la recherche. La recherche ne nécessite aucun compte ; se connecter avec Google est facultatif et ne fait que synchroniser votre liste de souhaits. Vos boutiques choisies et votre liste locale sont conservées dans votre navigateur.",
    storesIncluded: "Boutiques · {n} sur {total} incluses",
    save: "♡ Enregistrer", saved: "♥ Enregistré", remove: "Retirer", onSale: "En solde", priceAtStore: "Prix en boutique",
    resultsFor: "Résultats pour « {q} »", listingsLoadedOne: "1 annonce chargée", listingsLoadedOther: "{n} annonces chargées",
    alsoSearchedFor: "Aussi recherché : ", searching: "Recherche dans {stores}…",
    noListings: "Aucune annonce ne correspond à « {q} » dans les boutiques incluses.",
    titlesToLookUp: "Titres à rechercher plus tard — touchez-en un pour le rechercher :",
    savedListings: "Annonces enregistrées :",
    nothingSaved: "Rien n'est encore enregistré. Touchez ♡ Enregistrer sur une annonce, ou ajoutez un titre ci-dessus.",
  },
};
let currentLang = (() => {
  try {
    const saved = localStorage.getItem(LS_LANG);
    if (saved && I18N[saved]) return saved;
  } catch { /* default stands */ }
  return "en";
})();
// Look up a UI string in the current language, falling back to English
// for any key a translation is missing, with {name} placeholders filled.
function t(key, vars = {}) {
  let s = (I18N[currentLang] && I18N[currentLang][key]) || I18N.en[key] || key;
  for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}
function listingsLoadedText(n) {
  return n === 1 ? t("listingsLoadedOne") : t("listingsLoadedOther", { n });
}
// Apply a language to the whole page: document direction (right-to-left
// for Hebrew/Yiddish), every tagged static string, the sort options,
// the search button label, the switcher buttons' active state — then
// re-render whatever view is open so dynamic strings follow too.
function applyLanguage(lang) {
  if (!I18N[lang]) lang = "en";
  currentLang = lang;
  const dir = (LANGS.find((l) => l.code === lang) || LANGS[0]).dir;
  document.documentElement.lang = lang;
  document.documentElement.dir = dir;
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.getAttribute("data-i18n"));
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    el.placeholder = t(el.getAttribute("data-i18n-placeholder"));
  });
  document.querySelectorAll("#sort-select option").forEach((opt) => {
    opt.textContent = t(`sort_${opt.value}`);
  });
  const searchBtn = $("#search-btn");
  if (searchBtn) searchBtn.setAttribute("aria-label", t("search"));
  document.querySelectorAll("#lang-switcher [data-lang]").forEach((btn) => {
    const active = btn.getAttribute("data-lang") === lang;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-pressed", String(active));
  });
  renderStoresButton();
  renderResults();
  if (!$("#wishlist-view").classList.contains("d-none")) renderWishlist();
}
function setLanguage(lang) {
  saveLocal(LS_LANG, lang);
  applyLanguage(lang);
}
// Google sign-in (Identity Services): the client id is public, not a
// secret — the worker verifies Google's signed ID token itself, so no
// client secret is stored anywhere. While empty, the site simply runs
// signed-out; while the Google app is in Testing mode, only its listed
// test users can sign in (opening sign-in to everyone is a separate,
// later step — publishing the app for Google's verification).
const GOOGLE_CLIENT_ID = "891019147469-gbo84i1ugleie3sa0mrrccje77uv3ko6.apps.googleusercontent.com";
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

function loadWishlist() {
  try {
    const parsed = JSON.parse(localStorage.getItem(LS_WISHLIST) || "{}");
    return {
      items: Array.isArray(parsed.items) ? parsed.items : [],
      titles: Array.isArray(parsed.titles) ? parsed.titles : [],
    };
  } catch { return { items: [], titles: [] }; }
}
let wishlist = loadWishlist();
const productByUrl = new Map(); // url -> { product, store }
const savedUrls = () => new Set(wishlist.items.map((i) => i.url));

function saveWishlist() {
  saveLocal(LS_WISHLIST, JSON.stringify(wishlist));
  renderWishlistCount();
  // Server sync is fire-and-forget; the local copy never waits on it.
  pushWishlistToServer();
}

function renderWishlistCount() {
  const el = $("#wishlist-count");
  if (!el) return;
  const n = wishlist.items.length + wishlist.titles.length;
  el.textContent = n ? `(${n})` : "";
}

function toggleWish(url) {
  const found = productByUrl.get(url);
  const idx = wishlist.items.findIndex((i) => i.url === url);
  if (idx >= 0) {
    wishlist.items.splice(idx, 1);
  } else if (found) {
    const { product, store } = found;
    wishlist.items.unshift({
      url: product.url, title: product.title, imageUrl: product.imageUrl || null,
      priceText: product.priceText || null, compareAtText: product.compareAtText || null,
      storeId: store.id, storeName: store.name,
    });
  }
  saveWishlist();
  if (!$("#wishlist-view").classList.contains("d-none")) renderWishlist();
  renderResults();
}

function addWishTitle(title) {
  const t = String(title || "").trim();
  if (!t) return;
  if (!wishlist.titles.some((x) => x.toLowerCase() === t.toLowerCase())) {
    wishlist.titles.unshift(t);
  }
  saveWishlist();
  renderWishlist();
}

function removeWishTitle(title) {
  wishlist.titles = wishlist.titles.filter((x) => x !== title);
  saveWishlist();
  renderWishlist();
}

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
    t("storesIncluded", { n: enabledStores().length, total: STORES.length });
  $("#no-stores-warning").classList.toggle("d-none", enabledStores().length > 0);
  $("#search-btn").disabled = enabledStores().length === 0 || !$("#sefer-search").value.trim();
}

const BOOK_SVG = `<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V4a2 2 0 0 0-2-2H6.5A2.5 2.5 0 0 0 4 4.5v15Z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/></svg>`;
const FALLBACK_IMG = `<div class="product-img d-flex align-items-center justify-content-center text-secondary">${BOOK_SVG}</div>`;

function productCard(store, p, wishMode) {
  const price = p.priceText
    ? `<span class="fw-bold price">${esc(p.priceText)}</span>` +
      (p.compareAtText
        ? `<span class="text-secondary text-decoration-line-through small ms-2">${esc(p.compareAtText)}</span>`
        : "")
    : `<span class="text-secondary small">${t("priceAtStore")}</span>`;
  const saved = savedUrls().has(p.url);
  const wishBtn = wishMode === "remove"
    ? `<button type="button" class="btn btn-sm save-btn" data-wish-url="${esc(p.url)}">${t("remove")}</button>`
    : `<button type="button" class="btn btn-sm save-btn ${saved ? "saved" : ""}" data-wish-url="${esc(p.url)}">${saved ? t("saved") : t("save")}</button>`;
  const img = p.imageUrl
    ? `<img src="${esc(p.imageUrl)}" alt="${esc(p.title)}" loading="lazy"
            class="w-100 product-img" onerror="this.outerHTML=window.__sspFallbackImg">`
    : FALLBACK_IMG;
  return `
    <div class="col">
      <div class="card h-100 shadow-sm position-relative product-card">
        <div class="p-2 pb-0">
          <div class="rounded product-img-wrap position-relative">${img}${p.compareAtText ? `<span class="sale-stamp">${t("onSale")}</span>` : ""}</div>
        </div>
        <div class="card-body d-flex flex-column pt-2">
          <p class="store-badge mb-1"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 9l1.5-5h15L21 9"/><path d="M4 9v11a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V9"/><path d="M9 21V13h6v8"/></svg>${esc(store.name)}</p>
          <a href="${esc(p.url)}" target="_blank" rel="noopener noreferrer"
             class="stretched-link font-display fw-medium text-decoration-none product-title"
             aria-label="View ${esc(p.title)} at ${esc(store.name)}">${esc(p.title)}</a>
          <div class="mt-auto pt-2 d-flex justify-content-between align-items-center gap-2"><p class="mb-0">${price}</p>${wishBtn}</div>
        </div>
      </div>
    </div>`;
}

function renderResults() {
  // While the wishlist view is open, results stay hidden and untouched.
  if (!$("#wishlist-view").classList.contains("d-none")) return;
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
      <h2 class="font-display fw-semibold mb-0 results-title">${t("resultsFor", { q: esc(activeQuery) })}</h2>
      ${anyLoading ? "" : `<p class="text-secondary small mb-0">${listingsLoadedText(total)}</p>`}
    </div>
    ${extraVariants.length ? `<p class="text-secondary small mb-0">${t("alsoSearchedFor")}${extraVariants.map((v) => `“${esc(v)}”`).join(", ")}</p>` : ""}
    ${WORKER_URL ? "" : `<p class="text-secondary small mb-0">Fetching back-end not yet configured — results load directly from each store where the browser allows it. See README for the worker setup.</p>`}`;

  // One merged grid: products from every store are sorted together
  // (by price or alphabetically), each card still carrying its store
  // badge. Stores are never shown as separate sections.
  const loadingStores = stores.filter((s) => !results[s.id] || results[s.id].status === "loading");
  if (loadingStores.length) {
    html += `
      <div class="mt-3 d-flex align-items-center gap-2 text-secondary">
        <span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>
        <span>${t("searching", { stores: loadingStores.map((s) => esc(s.name)).join(", ") })}</span>
      </div>`;
  }
  // Stores with no listings are simply left out — no error or empty
  // notice per store, per the site owner's preference.
  const merged = [];
  for (const store of stores) {
    const r = results[store.id];
    if (r && r.status === "ok") {
      for (const p of r.products) {
        merged.push({ store, product: p });
        productByUrl.set(p.url, { product: p, store });
      }
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
    html += `<p class="mt-3 p-3 rounded text-secondary empty-box">${t("noListings", { q: esc(activeQuery) })}</p>`;
  }
  section.innerHTML = html;
}

// ---------------------------------------------------------------------------
// Google sign-in + server wishlist sync
// ---------------------------------------------------------------------------

let signedInUser = null;
const workerFetch = (path, opts = {}) =>
  fetch(`${WORKER_URL}${path}`, { ...opts, credentials: "include" });

async function pushWishlistToServer() {
  if (!signedInUser || !WORKER_URL) return;
  try {
    await workerFetch("/api/wishlist", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(wishlist),
    });
  } catch { /* local copy is authoritative until the next sync */ }
}

async function syncWishlistFromServer() {
  if (!WORKER_URL) return;
  try {
    const res = await workerFetch("/api/wishlist");
    if (!res.ok) return;
    const server = await res.json();
    const seenUrls = new Set(wishlist.items.map((i) => i.url));
    for (const i of server.items || []) {
      if (i.url && !seenUrls.has(i.url)) { wishlist.items.push(i); seenUrls.add(i.url); }
    }
    const seenTitles = new Set(wishlist.titles.map((t) => t.toLowerCase()));
    for (const t of server.titles || []) {
      if (t && !seenTitles.has(String(t).toLowerCase())) { wishlist.titles.push(t); seenTitles.add(String(t).toLowerCase()); }
    }
    saveWishlist();
    if (!$("#wishlist-view").classList.contains("d-none")) renderWishlist();
    await pushWishlistToServer();
  } catch { /* stay local */ }
}

function showSignedIn(user) {
  signedInUser = user;
  $("#auth-note").classList.add("d-none");
  $("#gsi-button").classList.add("d-none");
  $("#auth-email").textContent = user.email;
  $("#auth-signedin").classList.remove("d-none");
}

function showSignedOut() {
  signedInUser = null;
  $("#auth-signedin").classList.add("d-none");
  $("#auth-note").classList.remove("d-none");
  $("#gsi-button").classList.remove("d-none");
}

async function handleGoogleCredential(response) {
  if (!WORKER_URL) return;
  try {
    const res = await workerFetch("/auth/google", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: response.credential }),
    });
    if (!res.ok) return;
    showSignedIn(await res.json());
    await syncWishlistFromServer();
  } catch { /* stay signed out */ }
}

function initGoogleSignIn(attempts = 0) {
  if (!GOOGLE_CLIENT_ID) {
    $("#auth-note").textContent = "Google sign-in is being set up — searching and the local wishlist work without it.";
    return;
  }
  if (!window.google?.accounts?.id) {
    if (attempts < 20) setTimeout(() => initGoogleSignIn(attempts + 1), 500);
    return;
  }
  window.google.accounts.id.initialize({ client_id: GOOGLE_CLIENT_ID, callback: handleGoogleCredential });
  window.google.accounts.id.renderButton(document.getElementById("gsi-button"), { theme: "outline", size: "medium" });
}

async function refreshAuth() {
  if (!WORKER_URL) return;
  try {
    const res = await workerFetch("/auth/me");
    if (res.ok) {
      showSignedIn(await res.json());
      await syncWishlistFromServer();
    } else {
      showSignedOut();
    }
  } catch { showSignedOut(); }
  initGoogleSignIn();
}

function renderWishlist() {
  const titlesWrap = $("#wish-titles");
  const itemsWrap = $("#wish-items");
  titlesWrap.innerHTML = wishlist.titles.length
    ? `<p class="text-secondary small mb-2">${t("titlesToLookUp")}</p>` +
      wishlist.titles.map((t) => `
        <div class="wish-title-row d-flex justify-content-between align-items-center gap-2 px-3 py-2 mb-2">
          <button type="button" class="btn p-0 text-start fw-medium flex-grow-1" data-wish-title="${esc(t)}">${esc(t)}</button>
          <button type="button" class="btn btn-sm text-secondary" data-wish-title-remove="${esc(t)}" aria-label="Remove ${esc(t)}">✕</button>
        </div>`).join("")
    : "";
  if (wishlist.items.length) {
    const cards = wishlist.items.map((i) => {
      const store = STORES.find((s) => s.id === i.storeId) || { id: i.storeId, name: i.storeName };
      productByUrl.set(i.url, { product: i, store });
      return productCard(store, i, "remove");
    }).join("");
    itemsWrap.innerHTML = `<p class="text-secondary small mb-2">${t("savedListings")}</p><div class="row row-cols-2 row-cols-md-3 row-cols-lg-4 g-3">${cards}</div>`;
  } else {
    itemsWrap.innerHTML = wishlist.titles.length
      ? ""
      : `<p class="text-secondary mb-0">${t("nothingSaved")}</p>`;
  }
  renderWishlistCount();
}

// Close the hamburger menu panel (Bootstrap collapse when available,
// plain class removal otherwise). Used both when a nav link is tapped
// and when the wishlist view opens from the menu.
function closeNavPanel() {
  const panel = document.getElementById("nav-panel");
  if (!panel) return;
  if (window.bootstrap) window.bootstrap.Collapse.getOrCreateInstance(panel).hide();
  else panel.classList.remove("show");
}

function showWishlist() {
  renderWishlist();
  $("#results").classList.add("d-none");
  $("#idle-state").classList.add("d-none");
  $("#wishlist-view").classList.remove("d-none");
  closeNavPanel();
}

function showSearchView() {
  $("#wishlist-view").classList.add("d-none");
  $("#results").classList.remove("d-none");
  renderResults();
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
  $("#wishlist-view").classList.add("d-none");
  $("#results").classList.remove("d-none");
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
  // The hamburger menu is Bootstrap's navbar collapse (see index.html):
  // the toggler opens/closes it. Nav links must NOT carry
  // data-bs-toggle="collapse" — Bootstrap blocks link navigation for
  // those (preventDefault), which is why tapping a link closed the menu
  // without opening anything. Instead, close the panel here on tap
  // without touching the link's own navigation (it opens in a new tab).
  const navPanelEl = document.getElementById("nav-panel");
  if (navPanelEl) {
    navPanelEl.querySelectorAll("a").forEach((a) => {
      a.addEventListener("click", closeNavPanel);
    });
  }

  // Footer language switcher: each button picks a language, which is
  // remembered in this browser and applied on the next visit too.
  document.querySelectorAll("#lang-switcher [data-lang]").forEach((btn) => {
    btn.addEventListener("click", () => setLanguage(btn.getAttribute("data-lang")));
  });
  applyLanguage(currentLang);

  renderStoreChecks();
  renderWishlistCount();

  $("#wishlist-nav-btn").addEventListener("click", showWishlist);
  $("#back-to-search").addEventListener("click", showSearchView);
  $("#signout-btn").addEventListener("click", async () => {
    try { await workerFetch("/auth/logout", { method: "POST" }); } catch { /* ignore */ }
    showSignedOut();
  });
  refreshAuth();
  $("#wish-title-form").addEventListener("submit", (e) => {
    e.preventDefault();
    addWishTitle($("#wish-title-input").value);
    $("#wish-title-input").value = "";
  });

  // One delegated handler for all wishlist buttons (search results and
  // wishlist view alike), so re-renders never lose their wiring.
  document.addEventListener("click", (e) => {
    const wishBtn = e.target.closest("[data-wish-url]");
    if (wishBtn) { toggleWish(wishBtn.getAttribute("data-wish-url")); return; }
    const titleBtn = e.target.closest("[data-wish-title]");
    if (titleBtn) { runSearch(titleBtn.getAttribute("data-wish-title")); return; }
    const titleRm = e.target.closest("[data-wish-title-remove]");
    if (titleRm) { removeWishTitle(titleRm.getAttribute("data-wish-title-remove")); return; }
  });

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

  renderStoresButton();
});
