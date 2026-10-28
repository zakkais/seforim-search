# Seforim Search (public) — static site

One search box that shows the actual product listings — cover, title, and
price — from eight seforim stores, sorted together in one merged grid
(each card still carries its store badge):

Eichler's · Feldheim · Z. Berman Books · SeforimDeals · SeforimPlace ·
Hamafitz · Greenfield Judaica · eSicha

Clicking a listing opens it on the store's own product page. Filters:
per-store include/exclude checkboxes and sorting (price low→high /
high→low, title A→Z / Z→A, and "Priority: closest match"). Searching
needs no account. Signing in with Google is optional and only syncs
your wishlist across devices; your store choices are kept in your own
browser's local storage.

## Files

- `index.html` — the page layout (Bootstrap 5.3 via CDN, Spectral font).
  Every element id here is looked up by `ui.js`, so don't rename ids
  casually.
- `styles.css` — the bookshop theme on top of Bootstrap. Colours live
  in the `:root` block at the top (including the dark-mode block).
- `ui.js` — page logic: rendering, filters, the wishlist view, and the
  Google sign-in wiring. It imports `app.js` and draws what it returns.
- `app.js` — the store library: search URLs, result parsers, the
  spelling-variant dictionary, merging, and sorting. It is also the
  direct-browser fallback when the worker cannot be reached (see the
  duplication note below).
- `worker.js` — the Cloudflare Worker fetching back-end (see below).
  This is what makes cards actually load for most stores.
- `wrangler.toml` — reference only. The live worker is **not** deployed
  from this file (see "Deploy the fetching worker"); it is kept only
  so the project shape is standard.

## Editing the site (for the site owner)

- **Change the look:** edit `styles.css`. Class names there must match
  `index.html` and the markup built in `ui.js`.
- **Change the page layout or text:** edit `index.html`, keeping every
  element id intact.
- **Change how results render, or the wishlist/sign-in behaviour:**
  edit `ui.js`.
- **Change a store's search URL, or fix a store whose listings stopped
  appearing:** edit the store list and parsers in `app.js` **and** in
  `worker.js`. The two files intentionally contain the same store list
  and the same parsers (see below) — changing only one will leave the
  live site and its fallback disagreeing.
- **Cache-busting:** after changing `styles.css`, `app.js`, or `ui.js`,
  bump its `?v=` number by 1 so visitors get the fresh file instead of
  a cached copy — `styles.css?v=N` and `ui.js?v=N` in `index.html`,
  and `app.js?v=N` in the import at the top of `ui.js`. (If a file is
  unchanged, leave its number alone.)
- **Do not touch casually:** the `GOOGLE_CLIENT_ID` constant in `ui.js`
  (public, but it must match the id the worker was deployed with), the
  sign-in/session code in `worker.js`, and the `?q=` / `&store=` shape
  of the worker's search responses, which `app.js` depends on.
- **Never add a secret anywhere in this folder.** Sign-in uses Google
  Identity Services ID-token verification and needs no client secret;
  the public client id is the only Google credential that belongs here.

## Why the store list and parsers appear twice (intentional)

`worker.js` and `app.js` contain parallel copies of the store list and
the store parsers. This is not leftover duplication to clean up: the
worker copy is authoritative for live site searches, and the `app.js`
copy is the direct-browser fallback the page uses when the worker
cannot be reached (for example, while its URL is not configured).
Edits to a parser or a store URL must be made in **both** places, and
`MAX_PER_STORE` must stay the same in both, or the page will trim the
worker's results to the fallback's cap.

## Deploy the fetching worker (this is what makes cards actually load)

Why it's needed: a static GitHub Pages page cannot read other stores'
search pages directly from a visitor's browser — stores don't send the
CORS headers that would allow it, so without a back-end most stores
would show nothing. A worker runs server-side, where no browser CORS
rule applies: it fetches each store's public search page, parses the
listings, and returns just the cards as JSON. No public third-party
CORS relay is used, and no passwords, payments, or store sign-ins are
handled.

How the live worker was actually deployed (this is the real path —
not `wrangler deploy`):

1. Create a free Cloudflare account at https://dash.cloudflare.com/
   (no credit card needed for the Workers free tier: 100,000
   requests/day).
2. Upload `worker.js` through the Cloudflare API as the script
   `seforim-search` (a `PUT` of the script with metadata naming
   `worker.js` as the main module and `2026-10-27` as the
   compatibility date), with two bindings set in that same upload:
   - a KV namespace bound as `SEFORIM_KV` — sign-in sessions and
     server wishlists live there. Without it, sign-in answers
     "Storage not configured" (search still works).
   - a plain-text variable `GOOGLE_CLIENT_ID` set to the public
     Google client id. Without it, sign-in answers "Google sign-in
     not configured". No client secret is set anywhere, because
     sign-in verifies Google's signed ID token and needs none.
3. Enable the script's `workers.dev` route (the dashboard shows "No
   active routes" until this is done), giving a URL like
   `https://seforim-search.<your-name>.workers.dev`.
4. In `app.js`, `WORKER_URL` at the top must be that URL (no trailing
   slash). It already is for the live site; change it only if the
   worker moves.
5. Test: open the site, search "midrash rabbah" — stores the worker can
   reach should show real cards. Any store that still blocks the worker
   is left out of the grid with no per-store notice (the owner's
   preference), never a faked listing. The worker's own URL with
   `?q=tanya` returns its raw JSON for a quick check.

Search responses are cached for 10 minutes; sign-in and wishlist
responses are never cached. While `WORKER_URL` is empty, the site falls
back to direct browser fetching (blocked by most stores' CORS) and
says so on the results page.

## How the searching works (and its honest limits)

For each included store the worker fetches that store's own search
results and parses the listings out of the response. Up to **100
listings per store** are returned. How a store gets there differs, and
each trick is commented beside the code that uses it:

- **Magento stores (Eichler's, Feldheim, Z. Berman):** one request
  with `product_list_limit=100`. That parameter is honoured (verified:
  `=12` shrinks Eichler's results to 12, `=100` returns all 60 "shut"
  matches in one request).
- **OpenCart stores (SeforimPlace, Hamafitz) and Shopify
  (SeforimDeals):** the search is fetched page by page, in parallel
  (pages 1–5), and merged with duplicates removed. OpenCart ignores
  its `limit` parameter, so paging is the only way past its 20-per-page
  first page.
- **SeforimPlace in particular** needs two things a plain fetch does
  not do on its own: a plain `Mozilla/5.0` user-agent (desktop Chrome
  agents get a 547-byte bot-check page, while the plain agent gets the
  real search page), and an `X-Requested-With: XMLHttpRequest` header
  on pages 2 and later — its theme only honours the page number on
  AJAX requests (its infinite scroll loads that way), so a plain fetch
  of `&page=2` returns page 1 again, while the AJAX-headed one
  correctly returns products 21–40. Eichler's needs the plain
  user-agent too (its firewall blocks desktop Chrome agents).
- **eSicha (WooCommerce product API):** the API fixes its page at 10
  listings (95 total for "tanya"), so pages 1–10 are fetched in
  parallel.
- **Greenfield Judaica** is bot-blocked: its challenge page demands
  JavaScript, which a server-side fetch cannot run. It therefore
  comes back as an honest error and is left out of the grid. Its
  listings can only be reached by searching on greenfieldjudaica.com
  directly. This is expected, not a bug to work around with invented
  listings.

Product images load straight from each store's own image URLs, so
covers always match the listing. Listings are never invented: a store
that cannot be read is left out, and the page never shows a card the
store itself did not return.

## Spelling variants

Searching also searches alternate English transliterations, per word,
and merges the results (deduplicated by product link), with a note
showing which variants were also searched. Examples: midrash/medrash/
midrashim, mishnah/mishna/mishnayos, chumash/humash, gemara/gemorah,
shulchan aruch/oruch, sefer/seforim, halacha/halochos, tefillah/tefila,
and other common a/e/o vowel swaps. This works with or without the
worker configured.

## Google sign-in (optional, Testing mode)

Signing in is Google-only, via Google Identity Services: the page's
Google button returns a signed ID token, the page posts it to the
worker's `/auth/google`, and the worker verifies the token's signature
against Google's own keys, plus its issuer, audience (which must equal
`GOOGLE_CLIENT_ID`), expiry, and verified email. No password and no
client secret is involved at any point. A token that passes gets a
random session id, stored in KV for 30 days and returned as a secure,
HttpOnly cookie.

The Google app is in **Testing mode**: only the test users listed in
the Google Cloud console can sign in. Opening sign-in to everyone is a
separate, later step (publishing the app for Google's verification,
which can take days) and is not done yet. Searching stays open without
signing in either way.

When a visitor signs in, the wishlist merges: the browser's local
saved listings and title-only entries are combined with the server
copy (deduplicated by product URL for listings and case-insensitively
for titles), the merged copy is saved back to the server, and later
saves sync from the browser to the server. Signing in never wipes a
local wishlist. Signing out deletes the server session.

## Publish on GitHub Pages

1. Create a repository (e.g. `seforim-search`) and push these files to
   the `main` branch, keeping them at the repository root.
2. In the repo: **Settings → Pages → Build and deployment → Source:
   Deploy from a branch**, branch `main`, folder `/ (root)`. Save.
3. After a minute the site is live at
   `https://<your-username>.github.io/seforim-search/`.
