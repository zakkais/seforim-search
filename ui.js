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

import { STORES, WORKER_URL, expandQuery, searchStore, sortProducts, productSignature, signaturesConflict, groupProducts, matchCandidates } from "./app.js?v=9";

const LS_STORES = "ssp:store-selection";
const LS_SORT = "ssp:sort-mode";
const LS_WISHLIST = "ssp:wishlist";
const LS_MATCHCACHE = "ssp:matchcache";
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
    save: "♡", saved: "♥", remove: "Remove", onSale: "On sale", soldOut: "Sold out", inStores: "In {n} stores", priceAtStore: "Price at store",
    scan: "Scan ISBN", scanTitle: "Scan an ISBN or QR code", scanHint: "Point the camera at the barcode on the back of the sefer.", scanUnsupported: "Scanning is not supported in this browser — type the ISBN into the search box instead.", cancel: "Cancel",
    chatTitle: "Ask about a sefer", chatNote: "Prototype — it answers only from the stores' current listings, so it can compare prices and say what's sold out, but it can't answer history or authorship questions yet.", chatPlaceholder: "Ask about a sefer…", chatSend: "Send", chatWelcome: "Shalom! Ask me about a sefer — for example, which store has it cheapest, or whether it's sold out anywhere.", chatThinking: "Checking the stores…", chatError: "The chat couldn't answer just now — please try again.",
    newReleases: "New & just in", shippingTax: "Shipping & tax", shipNote: "What each store itself publishes about its shipping and tax. Where a store publishes no rate, only its own checkout has the real number — this page doesn't guess.",
    resultsFor: "Results for “{q}”", listingsLoadedOne: "1 listing loaded", listingsLoadedOther: "{n} listings loaded",
    alsoSearchedFor: "Also searched for: ", searching: "Searching {stores}…",
    noListings: "No listings matched “{q}” at the included stores.",
    titlesToLookUp: "Titles to look up later — tap one to search it:",
    savedListings: "Saved listings:",
    nothingSaved: "Nothing saved yet. Tap the ♡ on any listing, or add a title above.",
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
    save: "♡", saved: "♥", remove: "הסר", onSale: "במבצע", soldOut: "אזל מהמלאי", inStores: "ב-{n} חנויות", priceAtStore: "מחיר בחנות",
    scan: "סריקת ISBN", scanTitle: "סריקת ISBN או קוד QR", scanHint: "כוונו את המצלמה אל הברקוד שבגב הספר.", scanUnsupported: "הסריקה אינה נתמכת בדפדפן זה — הקלידו את ה-ISBN בתיבת החיפוש.", cancel: "ביטול",
    chatTitle: "שאל על ספר", chatNote: "אב־טיפוס — עונה רק ממודעות החנויות הנוכחיות, כך שיוכל להשוות מחירים ולומר מה אזל מהמלאי, אך עדיין לא לענות על שאלות היסטוריה או מחבר.", chatPlaceholder: "שאל על ספר…", chatSend: "שלח", chatWelcome: "שלום! שאל אותי על ספר — למשל, באיזו חנות הוא הכי זול, או אם הוא אזל באיזו חנות.", chatThinking: "בודק בחנויות…", chatError: "הצ׳אט לא הצליח לענות כרגע — נסה שוב.",
    newReleases: "חדש והגיע", shippingTax: "משלוח ומס", shipNote: "מה שכל חנות מפרסמת בעצמה על המשלוח והמס שלה. חנות שלא מפרסמת מחיר — רק בקופה שלה יש את המספר האמיתי; העמוד הזה לא מנחש.",
    resultsFor: "תוצאות עבור “{q}”", listingsLoadedOne: "מודעה אחת נטענה", listingsLoadedOther: "{n} מודעות נטענו",
    alsoSearchedFor: "חיפשנו גם: ", searching: "מחפש ב־{stores}…",
    noListings: "לא נמצאו מודעות עבור “{q}” בחנויות הכלולות.",
    titlesToLookUp: "כותרות לחיפוש מאוחר יותר — לחץ על אחת כדי לחפש אותה:",
    savedListings: "מודעות שמורות:",
    nothingSaved: "עדיין לא נשמר דבר. לחץ ♡ על כל מודעה, או הוסף כותרת למעלה.",
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
    save: "♡", saved: "♥", remove: "אַראָפּנעמען", onSale: "אויף סעיל", soldOut: "אויספאַרקויפט", inStores: "אין {n} קראָמען", priceAtStore: "פּרײַז אין קראָם",
    scan: "סקענען ISBN", scanTitle: "סקענען אַן ISBN אָדער QR קאָד", scanHint: "ווײַזט די קאַמעראַ אויפֿן באַרקאָד אויפֿן רוקן פֿונעם ספֿר.", scanUnsupported: "סקענען ווערט נישט געשטיצט אין דעם בלעטערער — טיפּט דעם ISBN אין דער זוך־קעסטל.", cancel: "אָפּזאָגן",
    chatTitle: "פֿרעגט וועגן אַ ספר", chatNote: "פּראָטאָטיפּ — ענטפֿערט נאָר פֿון די איצטיקע ליסטינגס פֿון די קראָמען, קען פֿאַרגלײַכן פּרײַזן און זאָגן וואָס איז אויספאַרקויפט, אָבער נאָך נישט ענטפֿערן אויף היסטאָריע אָדער מחבר־פֿראַגעס.", chatPlaceholder: "פֿרעגט וועגן אַ ספר…", chatSend: "שיקן", chatWelcome: "שלום! פֿרעגט מיך וועגן אַ ספר — למשל, אין וועלכער קראָם איז עס די ביליקסטע, אָדער צי עס איז ערגעץ אויספאַרקויפט.", chatThinking: "קוקט אין די קראָמען…", chatError: "דער טשאַט האָט איצט נישט געקענט ענטפֿערן — פּרוּווט נאָך אַ מאָל.",
    newReleases: "נײַ און פֿריש אָנגעקומען", shippingTax: "שיפּינג און שטײַער", shipNote: "וואָס יעדער קראָם גיט אַליין אָן וועגן זײַן שיפּינג און שטײַער. אַ קראָם וואָס גיט נישט אָן קיין פּרײַז — נאָר בײַם קאַסע איז דאָ דער עכטער נומער; דער בלאַט טרעפֿט נישט.",
    resultsFor: "רעזולטאַטן פֿאַר “{q}”", listingsLoadedOne: "1 ליסטינג געלאַדן", listingsLoadedOther: "{n} ליסטינגס געלאַדן",
    alsoSearchedFor: "אויך געזוכט: ", searching: "זוכן אין {stores}…",
    noListings: "קיין ליסטינגס האָבן נישט געפּאַסט “{q}” אין די אַרײַנגענומענע קראָמען.",
    titlesToLookUp: "טיטלען צו זוכן שפּעטער — קליקט אויף איינעם צו זוכן אים:",
    savedListings: "געהאַלטענע ליסטינגס:",
    nothingSaved: "נאָך גאָרנישט געהאַלטן. קליקט ♡ אויף אַ ליסטינג, אָדער לייגט צו אַ טיטל אויבן.",
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
    save: "♡", saved: "♥", remove: "Quitar", onSale: "En oferta", soldOut: "Agotado", inStores: "En {n} tiendas", priceAtStore: "Precio en tienda",
    scan: "Escanear ISBN", scanTitle: "Escanea un ISBN o código QR", scanHint: "Apunta la cámara al código de barras en la parte trasera del libro.", scanUnsupported: "El escaneo no es compatible con este navegador: escribe el ISBN en el cuadro de búsqueda.", cancel: "Cancelar",
    chatTitle: "Pregunta por un séfer", chatNote: "Prototipo: responde solo desde los listados actuales de las tiendas, así que puede comparar precios y decir qué está agotado, pero aún no puede responder preguntas de historia o autoría.", chatPlaceholder: "Pregunta por un séfer…", chatSend: "Enviar", chatWelcome: "¡Shalom! Pregúntame por un séfer: por ejemplo, en qué tienda está más barato o si está agotado en alguna.", chatThinking: "Revisando las tiendas…", chatError: "El chat no pudo responder ahora. Inténtalo de nuevo.",
    newReleases: "Novedades", shippingTax: "Envío e impuestos", shipNote: "Lo que cada tienda publica sobre sus envíos e impuestos. Si una tienda no publica tarifas, solo su caja tiene el número real: esta página no lo inventa.",
    resultsFor: "Resultados para “{q}”", listingsLoadedOne: "1 anuncio cargado", listingsLoadedOther: "{n} anuncios cargados",
    alsoSearchedFor: "También se buscó: ", searching: "Buscando en {stores}…",
    noListings: "Ningún anuncio coincidió con “{q}” en las tiendas incluidas.",
    titlesToLookUp: "Títulos para buscar más tarde — toca uno para buscarlo:",
    savedListings: "Anuncios guardados:",
    nothingSaved: "Aún no has guardado nada. Toca ♡ en cualquier anuncio, o añade un título arriba.",
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
    save: "♡", saved: "♥", remove: "Retirer", onSale: "En solde", soldOut: "Épuisé", inStores: "Dans {n} boutiques", priceAtStore: "Prix en boutique",
    scan: "Scanner l'ISBN", scanTitle: "Scanner un ISBN ou un code QR", scanHint: "Pointez l'appareil photo vers le code-barres au dos du livre.", scanUnsupported: "La numérisation n'est pas prise en charge dans ce navigateur — saisissez l'ISBN dans la zone de recherche.", cancel: "Annuler",
    chatTitle: "Demander un séfer", chatNote: "Prototype : répond uniquement à partir des listes actuelles des boutiques ; il peut comparer les prix et dire ce qui est épuisé, mais pas encore répondre aux questions d'histoire ou d'auteur.", chatPlaceholder: "Demandez un séfer…", chatSend: "Envoyer", chatWelcome: "Shalom ! Demandez-moi un séfer — par exemple, dans quelle boutique il est le moins cher, ou s'il est épuisé quelque part.", chatThinking: "Vérification des boutiques…", chatError: "Le chat n'a pas pu répondre. Réessayez.",
    newReleases: "Nouveautés", shippingTax: "Expédition et taxes", shipNote: "Ce que chaque boutique publie elle-même sur son expédition et ses taxes. Si une boutique ne publie aucun tarif, seule sa caisse donne le vrai montant — cette page ne devine pas.",
    resultsFor: "Résultats pour « {q} »", listingsLoadedOne: "1 annonce chargée", listingsLoadedOther: "{n} annonces chargées",
    alsoSearchedFor: "Aussi recherché : ", searching: "Recherche dans {stores}…",
    noListings: "Aucune annonce ne correspond à « {q} » dans les boutiques incluses.",
    titlesToLookUp: "Titres à rechercher plus tard — touchez-en un pour le rechercher :",
    savedListings: "Annonces enregistrées :",
    nothingSaved: "Rien n'est encore enregistré. Touchez ♡ sur une annonce, ou ajoutez un titre ci-dessus.",
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
  const chatFab = $("#chat-fab");
  if (chatFab) chatFab.setAttribute("aria-label", t("chatTitle"));
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

// MERGE-BEGIN — pure wishlist-shape helpers (no DOM, no storage).
// The wishlist lives in shape v2, here and on the server (see
// worker.js): items and titles carry an addedAt stamp, and a
// "deleted" map of tombstones remembers removals. The merge rule that
// keeps browsers consistent: a tombstone newer than an entry's
// addedAt wins, and re-adding an entry stamps a fresh addedAt and
// clears its tombstone — so a deletion made in one browser is no
// longer resurrected by a stale list in another. Lists saved by older
// versions (plain title strings, no stamps) migrate with addedAt 0.
function normalizeLocalWishlist(parsed) {
  const src = parsed && typeof parsed === "object" ? parsed : {};
  const items = (Array.isArray(src.items) ? src.items : [])
    .filter((i) => i && i.url && i.title)
    .map((i) => ({ ...i, addedAt: Number.isFinite(+i.addedAt) ? +i.addedAt : 0 }));
  const titles = [];
  const seen = new Set();
  for (const t of Array.isArray(src.titles) ? src.titles : []) {
    const c = typeof t === "string" ? { text: t, addedAt: 0 }
      : (t && t.text ? { text: String(t.text), addedAt: Number.isFinite(+t.addedAt) ? +t.addedAt : 0 } : null);
    if (!c || !c.text) continue;
    const key = c.text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    titles.push(c);
  }
  const deleted = { urls: {}, titles: {} };
  if (src.deleted && typeof src.deleted === "object") {
    for (const [k, v] of Object.entries(src.deleted.urls ?? {})) {
      if (Number.isFinite(+v) && +v > 0) deleted.urls[k] = +v;
    }
    for (const [k, v] of Object.entries(src.deleted.titles ?? {})) {
      if (Number.isFinite(+v) && +v > 0) deleted.titles[String(k).toLowerCase()] = +v;
    }
  }
  return { items, titles, deleted };
}
function mergeDeletedMaps(a, b) {
  const out = { urls: {}, titles: {} };
  for (const src of [a, b]) {
    if (!src) continue;
    for (const [k, v] of Object.entries(src.urls ?? {})) out.urls[k] = Math.max(out.urls[k] ?? 0, +v || 0);
    for (const [k, v] of Object.entries(src.titles ?? {})) out.titles[k] = Math.max(out.titles[k] ?? 0, +v || 0);
  }
  return out;
}
function mergeWishlists(a, b) {
  const deleted = mergeDeletedMaps(a?.deleted, b?.deleted);
  const byUrl = new Map();
  for (const src of [a, b]) for (const i of src?.items ?? []) {
    const cur = byUrl.get(i.url);
    if (!cur || (i.addedAt ?? 0) >= (cur.addedAt ?? 0)) byUrl.set(i.url, i);
  }
  const items = [...byUrl.values()].filter((i) => (deleted.urls[i.url] ?? 0) <= (i.addedAt ?? 0));
  const byTitle = new Map();
  for (const src of [a, b]) for (const t of src?.titles ?? []) {
    const key = t.text.toLowerCase();
    const cur = byTitle.get(key);
    if (!cur || (t.addedAt ?? 0) >= (cur.addedAt ?? 0)) byTitle.set(key, t);
  }
  const titles = [...byTitle.values()].filter((t) => (deleted.titles[t.text.toLowerCase()] ?? 0) <= (t.addedAt ?? 0));
  return { items, titles, deleted };
}
// MERGE-END

function loadWishlist() {
  try {
    return normalizeLocalWishlist(JSON.parse(localStorage.getItem(LS_WISHLIST) || "{}"));
  } catch { return { items: [], titles: [], deleted: { urls: {}, titles: {} } }; }
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
    wishlist.deleted.urls[url] = Date.now();
  } else if (found) {
    const { product, store } = found;
    wishlist.items.unshift({
      url: product.url, title: product.title, imageUrl: product.imageUrl || null,
      priceText: product.priceText || null, compareAtText: product.compareAtText || null,
      storeId: store.id, storeName: store.name, addedAt: Date.now(),
    });
    delete wishlist.deleted.urls[url];
  }
  saveWishlist();
  if (!$("#wishlist-view").classList.contains("d-none")) renderWishlist();
  renderResults();
}

function addWishTitle(title) {
  const text = String(title || "").trim();
  if (!text) return;
  if (!wishlist.titles.some((x) => x.text.toLowerCase() === text.toLowerCase())) {
    wishlist.titles.unshift({ text, addedAt: Date.now() });
  }
  delete wishlist.deleted.titles[text.toLowerCase()];
  saveWishlist();
  renderWishlist();
}

function removeWishTitle(title) {
  wishlist.titles = wishlist.titles.filter((x) => x.text !== title);
  wishlist.deleted.titles[String(title).toLowerCase()] = Date.now();
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

function cardInner(store, p, wishMode) {
  const price = p.priceText
    ? `<span class="fw-bold price">${esc(p.priceText)}</span>` +
      (p.compareAtText
        ? `<span class="text-secondary text-decoration-line-through small ms-2">${esc(p.compareAtText)}</span>`
        : "")
    : `<span class="text-secondary small">${t("priceAtStore")}</span>`;
  const saved = savedUrls().has(p.url);
  const wishBtn = wishMode === "remove"
    ? `<button type="button" class="btn btn-sm btn-outline-secondary position-relative z-2" data-wish-url="${esc(p.url)}">${t("remove")}</button>`
    : `<button type="button" class="btn btn-sm fs-5 lh-1 ${saved ? "btn-secondary" : "btn-outline-secondary"} position-relative z-2" data-wish-url="${esc(p.url)}" aria-label="${saved ? "Saved to wishlist" : "Save to wishlist"}"${saved ? ` aria-pressed="true"` : ""}>${saved ? t("saved") : t("save")}</button>`;
  const img = p.imageUrl
    ? `<img src="${esc(p.imageUrl)}" alt="${esc(p.title)}" loading="lazy"
            class="w-100 object-fit-contain product-img${p.soldOut ? " opacity-75" : ""}" onerror="this.outerHTML=window.__sspFallbackImg">`
    : FALLBACK_IMG;
  return `
        <div class="p-2 pb-0">
          <div class="rounded product-img-wrap position-relative">${img}${p.compareAtText ? `<span class="badge rounded-pill text-bg-danger position-absolute top-0 start-0 m-2 z-2 shadow-sm text-uppercase">${t("onSale")}</span>` : ""}${p.soldOut ? `<span class="badge rounded-pill text-bg-secondary position-absolute top-0 end-0 m-2 z-2 shadow-sm text-uppercase">${t("soldOut")}</span>` : ""}</div>
        </div>
        <div class="card-body d-flex flex-column pt-2">
          <p class="store-badge d-flex align-items-center gap-1 mb-1"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 9l1.5-5h15L21 9"/><path d="M4 9v11a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V9"/><path d="M9 21V13h6v8"/></svg>${esc(store.name)}</p>
          <a href="${esc(p.url)}" target="_blank" rel="noopener noreferrer"
             class="stretched-link font-display fw-medium text-decoration-none product-title"
             aria-label="View ${esc(p.title)} at ${esc(store.name)}">${esc(p.title)}</a>
          <div class="mt-auto pt-2 d-flex justify-content-between align-items-center gap-2"><p class="mb-0">${price}</p>${wishBtn}</div>
        </div>`;
}

function productCard(store, p, wishMode) {
  return `
    <div class="col">
      <div class="card h-100 shadow-sm position-relative">${cardInner(store, p, wishMode)}
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Grouped cards + the AI match check
// ---------------------------------------------------------------------------
// groupProducts (app.js) settles the clear cases by rule. Pairs it
// leaves apart but suspects — same sefer, details stated on one side
// only — are judged by the worker's /match endpoint, and each verdict
// is cached in this browser per title pair, so a pair is only ever
// asked about once. A "same" verdict merges the two groups on the
// next render; a "different" verdict just leaves the cards separate.
// ---------------------------------------------------------------------------
let groupSeq = 0;
let matchCache = {};
try { matchCache = JSON.parse(localStorage.getItem(LS_MATCHCACHE) || "{}") || {}; } catch { matchCache = {}; }
const pairKeyOf = (a, b) => [a.title, b.title].map((s) => String(s || "").trim().toLowerCase()).sort().join(" || ");
function saveMatchCache() {
  try { localStorage.setItem(LS_MATCHCACHE, JSON.stringify(matchCache)); } catch { /* private mode etc. */ }
}

function applyCachedVerdicts(entries, groups) {
  for (const c of matchCandidates(entries, groups)) {
    if (matchCache[pairKeyOf(c.a, c.b)] !== true) continue;
    const gi = groups.findIndex((g) => g.includes(c.a));
    const gj = groups.findIndex((g) => g.includes(c.b));
    if (gi < 0 || gj < 0 || gi === gj) continue;
    if (groups[gj].some((e) => groups[gi].some((x) => x.storeId === e.storeId))) continue;
    let ok = true;
    for (const x of groups[gi]) {
      for (const y of groups[gj]) {
        if (signaturesConflict(productSignature(x.title), productSignature(y.title))) { ok = false; break; }
      }
      if (!ok) break;
    }
    if (!ok) continue;
    groups[gi] = [...groups[gi], ...groups[gj]];
    groups.splice(gj, 1);
  }
  return groups;
}

let aiCheckInFlight = false;
function scheduleAiMatchCheck(entries, groups) {
  if (!WORKER_URL || aiCheckInFlight) return;
  const pending = matchCandidates(entries, groups)
    .filter((c) => !(pairKeyOf(c.a, c.b) in matchCache))
    .slice(0, 16);
  if (!pending.length) return;
  aiCheckInFlight = true;
  fetch(`${WORKER_URL}/match`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pairs: pending.map((c) => ({
        a: { title: c.a.title, store: c.a.store?.name || c.a.storeId, price: c.a.priceText || "" },
        b: { title: c.b.title, store: c.b.store?.name || c.b.storeId, price: c.b.priceText || "" },
      })),
    }),
  })
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      aiCheckInFlight = false;
      if (!data || !Array.isArray(data.verdicts)) return;
      let changed = false;
      for (const v of data.verdicts) {
        const c = pending[v.i];
        if (!c) continue;
        matchCache[pairKeyOf(c.a, c.b)] = v.same === true;
        if (v.same === true) changed = true;
      }
      saveMatchCache();
      if (changed) renderResults();
    })
    .catch(() => { aiCheckInFlight = false; });
}

// Members display cheapest-available first, so the front of the card
// is the best buy; sold-out listings sit at the back of the swipe.
const displayMembers = (g) => [...g].sort((a, b) =>
  ((a.soldOut === true) - (b.soldOut === true)) || ((a.priceAmount ?? 1e12) - (b.priceAmount ?? 1e12)));

function groupCard(members) {
  if (members.length === 1) return productCard(members[0].store, members[0]);
  const id = `grp-${++groupSeq}`;
  const slides = members.map((m, i) => `
        <div class="carousel-item${i === 0 ? " active" : ""}">${cardInner(m.store, m)}
        </div>`).join("");
  return `
    <div class="col">
      <div class="card h-100 shadow-sm position-relative">
        <div class="px-2 pt-2 d-flex align-items-center justify-content-between position-relative z-2">
          <span class="badge rounded-pill text-bg-primary">${t("inStores", { n: members.length })}</span>
          <span class="btn-group btn-group-sm" role="group" aria-label="Stores">
            <button type="button" class="btn btn-outline-secondary py-0 px-2" data-bs-target="#${id}" data-bs-slide="prev" aria-label="Previous store">&#8249;</button>
            <button type="button" class="btn btn-outline-secondary py-0 px-2" data-bs-target="#${id}" data-bs-slide="next" aria-label="Next store">&#8250;</button>
          </span>
        </div>
        <div id="${id}" class="carousel slide" data-bs-interval="false" data-bs-touch="true">
          <div class="carousel-inner">${slides}
          </div>
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
      <h2 class="font-display fw-semibold mb-0 fs-3">${t("resultsFor", { q: esc(activeQuery) })}</h2>
      ${anyLoading ? "" : `<p class="text-secondary small mb-0">${listingsLoadedText(total)}</p>`}
    </div>
    ${extraVariants.length ? `<p class="text-secondary small mb-0">${t("alsoSearchedFor")}${extraVariants.map((v) => `“${esc(v)}”`).join(", ")}</p>` : ""}
    ${WORKER_URL ? "" : `<p class="text-secondary small mb-0">Fetching back-end not yet configured — results load directly from each store where the browser allows it. See README for the worker setup.</p>`}`;

  // One merged grid: listings from every store together, never in
  // per-store sections. Listings of the same sefer at several stores
  // are grouped into a single card (see groupCard below).
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
  // Group first, then order the groups by the chosen sort using one
  // representative member per group (the member each sort would put
  // first). Inside a group, displayMembers decides the swipe order.
  const entries = merged.map((m) => ({ ...m.product, storeId: m.store.id, store: m.store }));
  const groups = applyCachedVerdicts(entries, groupProducts(entries));
  const repOf = (g) => {
    if (sortMode === "price-desc") return [...g].sort((a, b) => (b.priceAmount ?? -1) - (a.priceAmount ?? -1))[0];
    if (sortMode === "alpha-asc" || sortMode === "alpha-desc")
      return [...g].sort((a, b) => String(a.title || "").localeCompare(String(b.title || "")))[0];
    return displayMembers(g)[0];
  };
  const groupOfRep = new Map();
  const reps = groups.map((g) => { const r = repOf(g); groupOfRep.set(r, g); return r; });
  const sortedReps = sortProducts(reps, sortMode, activeQuery);
  if (entries.length) {
    groupSeq = 0;
    html += `<div class="row row-cols-2 row-cols-md-3 row-cols-lg-4 g-3 mt-1">` +
      sortedReps.map((r) => groupCard(displayMembers(groupOfRep.get(r)))).join("") + `</div>`;
    if (!anyLoading) scheduleAiMatchCheck(entries, groups);
  } else if (!anyLoading) {
    html += `<div class="alert alert-light border text-secondary mt-3" role="note">${t("noListings", { q: esc(activeQuery) })}</div>`;
  }
  section.innerHTML = html;
  updateFeedVisibility();
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
    await workerFetch("/api/wishlist?v=2", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(wishlist),
    });
  } catch { /* local copy is authoritative until the next sync */ }
}

async function syncWishlistFromServer() {
  if (!WORKER_URL) return;
  try {
    const res = await workerFetch("/api/wishlist?v=2");
    if (!res.ok) return;
    const server = normalizeLocalWishlist(await res.json());
    wishlist = mergeWishlists(wishlist, server);
    saveWishlist(); // also pushes the merged list back, fire-and-forget
    if (!$("#wishlist-view").classList.contains("d-none")) renderWishlist();
    renderResults();
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
      wishlist.titles.map((wt) => `
        <div class="list-group-item d-flex justify-content-between align-items-center gap-2 px-3 py-2">
          <button type="button" class="btn p-0 text-start fw-medium flex-grow-1" data-wish-title="${esc(wt.text)}">${esc(wt.text)}</button>
          <button type="button" class="btn btn-sm text-secondary" data-wish-title-remove="${esc(wt.text)}" aria-label="Remove ${esc(wt.text)}">✕</button>
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
  updateFeedVisibility();
  closeNavPanel();
}

function showSearchView() {
  $("#wishlist-view").classList.add("d-none");
  $("#results").classList.remove("d-none");
  renderResults();
}

// ---------------------------------------------------------------------------
// New-releases feed
// ---------------------------------------------------------------------------
// The worker keeps a "New & just in" list (GET /new-releases, built
// from Hamafitz, SeforimDeals and Kehot under safe mode — see
// worker.js). It renders with the same product cards as the search
// results, wishlist buttons included, on the homepage only: it hides
// while a search is on screen or the wishlist is open. No data (or
// no worker) means no section at all.

let feedItems = [];

function updateFeedVisibility() {
  const sec = $("#new-releases");
  if (!sec) return;
  const wishlistOpen = !$("#wishlist-view").classList.contains("d-none");
  sec.classList.toggle("d-none", !feedItems.length || Boolean(activeQuery) || wishlistOpen);
}

async function loadFeed() {
  if (!WORKER_URL) return;
  try {
    const res = await fetch(`${WORKER_URL}/new-releases`);
    if (!res.ok) return;
    const data = await res.json();
    feedItems = Array.isArray(data.items) ? data.items : [];
    if (!feedItems.length) return;
    $("#new-releases-grid").innerHTML = feedItems.map((p) => {
      const store = { id: p.storeId, name: p.storeName };
      productByUrl.set(p.url, { product: p, store });
      return `<div class="col">${productCard(store, p, "save")}</div>`;
    }).join("");
    updateFeedVisibility();
  } catch { /* the strip is a bonus; the search box is the site */ }
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
// ISBN / QR scanner (button inside the search bar)
// ---------------------------------------------------------------------------
// The scan button sits in the search bar's input group and opens a
// Bootstrap modal with the camera view. Detection uses the browser's
// built-in BarcodeDetector (Chrome/Android); where that is missing,
// the modal says so plainly and typing the ISBN still works, because
// ISBN queries are searched exactly (see expandQuery in app.js).

let scanStream = null;
let scanTimer = null;
let scanBusy = false;

function stopScan() {
  if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
  if (scanStream) { scanStream.getTracks().forEach((tr) => tr.stop()); scanStream = null; }
  const video = $("#scan-video");
  if (video) video.srcObject = null;
}

// A scanned QR code may hold a URL or text around the number; pull an
// ISBN-looking token out when there is one, else fall back to the
// longest run of digits.
function extractIsbn(raw) {
  for (const tok of String(raw).split(/[^0-9Xx]+/)) {
    if (/^\d{13}$/.test(tok) || /^\d{9}[\dXx]$/.test(tok)) return tok.toUpperCase();
  }
  const digits = String(raw).replace(/\D/g, "");
  return digits.length >= 8 ? digits : null;
}

async function startScan() {
  const status = $("#scan-status");
  const video = $("#scan-video");
  const supported = "BarcodeDetector" in window && navigator.mediaDevices && navigator.mediaDevices.getUserMedia;
  if (!supported) {
    video.classList.add("d-none");
    status.textContent = t("scanUnsupported");
    return;
  }
  video.classList.remove("d-none");
  status.textContent = t("scanHint");
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
  } catch (e) {
    status.textContent = t("scanUnsupported");
    return;
  }
  video.srcObject = scanStream;
  await video.play().catch(() => {});
  const detector = new window.BarcodeDetector({ formats: ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "qr_code"] });
  scanTimer = setInterval(async () => {
    if (scanBusy) return;
    scanBusy = true;
    try {
      const codes = await detector.detect(video);
      if (codes && codes.length) {
        const raw = String(codes[0].rawValue || "").trim();
        if (raw) {
          stopScan();
          const modalEl = $("#scan-modal");
          if (window.bootstrap && modalEl) window.bootstrap.Modal.getOrCreateInstance(modalEl).hide();
          runSearch(extractIsbn(raw) || raw);
        }
      }
    } catch (e) { /* a failed frame is not fatal; keep scanning */ }
    scanBusy = false;
  }, 350);
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
  const shipBtn = $("#ship-nav-btn");
  if (shipBtn) shipBtn.addEventListener("click", closeNavPanel);
  loadFeed();
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

  const scanModal = $("#scan-modal");
  if (scanModal) {
    scanModal.addEventListener("shown.bs.modal", startScan);
    scanModal.addEventListener("hidden.bs.modal", stopScan);
  }

  // Chat prototype: the floating button opens the panel; questions go
  // to the worker's /chat, which answers from store listings only.
  const chatPanel = $("#chat-panel");
  const chatMessages = $("#chat-messages");
  if (chatPanel && chatMessages) {
    let chatWelcomed = false;
    const addChatBubble = (text, who) => {
      const div = document.createElement("div");
      div.className = who === "me"
        ? "align-self-end chat-bubble-me rounded-3 px-3 py-2"
        : "align-self-start chat-bubble-ai rounded-3 px-3 py-2";
      div.style.maxWidth = "85%";
      div.style.whiteSpace = "pre-wrap";
      div.textContent = text;
      chatMessages.appendChild(div);
      chatMessages.scrollTop = chatMessages.scrollHeight;
      return div;
    };
    chatPanel.addEventListener("shown.bs.offcanvas", () => {
      if (!chatWelcomed) {
        chatWelcomed = true;
        addChatBubble(t("chatWelcome"), "ai");
      }
      $("#chat-input")?.focus();
    });
    $("#chat-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const input = $("#chat-input");
      const question = (input?.value || "").trim();
      if (!question) return;
      input.value = "";
      addChatBubble(question, "me");
      const sendBtn = $("#chat-send");
      if (sendBtn) sendBtn.disabled = true;
      const thinking = addChatBubble(t("chatThinking"), "ai");
      try {
        if (!WORKER_URL) throw new Error("no worker");
        const res = await fetch(`${WORKER_URL}/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question }),
        });
        const data = res.ok ? await res.json() : null;
        thinking.textContent = (data && (data.answer || data.error)) || t("chatError");
      } catch {
        thinking.textContent = t("chatError");
      }
      if (sendBtn) sendBtn.disabled = false;
      input?.focus();
    });
  }

  renderStoresButton();
});
