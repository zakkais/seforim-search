# Seforim Search (public) — static site

One search box that shows the actual product listings — cover, title, and
price — from seven seforim stores, sorted together in one merged grid
(each card still carries its store badge):

Feldheim · Z. Berman Books · SeforimDeals · SeforimPlace ·
Hamafitz · Greenfield Judaica · eSicha

Clicking a listing opens it on the store's own product page. Filters:
per-store include/exclude checkboxes and sorting (price low→high /
high→low, title A→Z / Z→A, and "Priority: closest match"). Searching
needs no account. Signing in with Google is optional and only syncs
your wishlist across devices; your store choices are kept in your own
browser's local storage. A hamburger menu also links to external
resources (Chabad Torah Texts, HebrewBooks, Sefaria) and to the
wishlist, which can hold saved listings and plain titles to look up
later. Searching also covers alternate English transliterations
(e.g. midrash/medrash).

SAFE MODE (2026-10-28): Eichler's was removed because its robots.txt
disallows its search route, and no bot-wall workaround is used — a
store that answers a bot-check page is accepted as an error and
omitted. That currently leaves SeforimPlace returning no listings.

## Files

- `index.html` — the page layout (Bootstrap 5.3 via CDN, Spectral font).
- `styles.css` — the bookshop theme on top of Bootstrap.
- `ui.js` — page logic: rendering, filters, the wishlist view, and the
  Google sign-in wiring. It imports `app.js`.
- `app.js` — the store library: search URLs, result parsers, spelling
  variants, merging, and sorting. It is also the direct-browser
  fallback when the worker cannot be reached.
- `worker.js` — the Cloudflare Worker fetching back-end: it fetches
  each store's public search page server-side, parses the listings,
  and returns just the cards as JSON. No passwords, payments, or store
  sign-ins are handled.
- `wrangler.toml` — reference only; the live worker is not deployed
  from this file.

## Editing notes

- Change the look in `styles.css`, the layout or text in `index.html`,
  rendering and wishlist/sign-in behaviour in `ui.js`.
- A store's search URL or parser lives in **both** `app.js` and
  `worker.js` (the worker copy serves live searches, the `app.js` copy
  is the fallback) — change both, and keep the per-store cap the same
  in both.
- After changing `styles.css`, `app.js`, or `ui.js`, bump its `?v=`
  number by 1 so visitors get the fresh file instead of a cached copy.
- Never add a secret anywhere in this folder. Sign-in uses Google
  Identity Services ID-token verification and needs no client secret;
  the public client id is the only Google credential that belongs here.

## Deploying

- The worker is uploaded through the Cloudflare API as the script
  `seforim-search`, with a KV namespace bound as `SEFORIM_KV` and a
  plain-text `GOOGLE_CLIENT_ID` variable, and its `workers.dev` route
  enabled. `WORKER_URL` at the top of `app.js` must be that URL.
- The site itself is published with GitHub Pages: push these files to
  the `main` branch at the repository root, then Settings → Pages →
  Deploy from a branch, `main`, `/ (root)`.
