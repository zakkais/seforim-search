# Seforim Search (public) — static site

One search box that shows the actual product listings — cover, title, and
price — from eight seforim stores, grouped by store:

Eichler's · Feldheim · Z. Berman Books · SeforimDeals · SeforimPlace ·
Hamafitz · Greenfield Judaica · eSicha

Clicking a listing opens it on the store's own product page. Filters:
per-store include/exclude checkboxes and price sorting (low→high /
high→low). No accounts, no login, no checkout, nothing stored anywhere
except the visitor's store choices in their own browser's local storage.

## Files

- `index.html` — the page (Bootstrap 5.3 via CDN, Spectral font)
- `styles.css` — the bookshop theme on top of Bootstrap
- `ui.js` — page logic: rendering, filters, sorting, local storage, spelling variants
- `app.js` — the store library: search URLs, result parsers, fetch chain, variant dictionary
- `worker.js` — the optional Cloudflare Worker fetching back-end (see below)

## Deploy the fetching worker (this is what makes cards actually load)

Why it's needed: a static GitHub Pages page cannot read other stores'
search pages directly from a visitor's browser — stores don't send the
CORS headers that would allow it, so every store section used to say
"couldn't be loaded." A worker runs server-side, where no browser CORS
rule applies: it fetches the store's public search page, parses the
listings, and returns just the cards as JSON. No public third-party
CORS relay is used, and no passwords, payments, or accounts are handled.

1. Create a free Cloudflare account at https://dash.cloudflare.com/
   (no credit card needed for the Workers free tier: 100,000
   requests/day).
2. Install wrangler once, on your own computer:
   `npm install -g wrangler` — then `wrangler login` and approve the
   browser prompt.
3. In this folder, create a file named `wrangler.toml` with:
   ```
   name = "seforim-search"
   main = "worker.js"
   compatibility_date = "2026-10-27"
   ```
4. Deploy: `wrangler deploy` (from this folder). Cloudflare will print
   a URL like `https://seforim-search.<your-name>.workers.dev`.
5. In `app.js`, set `WORKER_URL` at the top to that URL (no trailing
   slash), e.g.:
   `var WORKER_URL = "https://seforim-search.<your-name>.workers.dev";`
   Then commit and push the site files to GitHub Pages again.
6. Test: open the site, search "midrash rabbah" — stores the worker can
   reach should now show real cards instead of "couldn't be loaded."
   Any store that still blocks the worker shows an honest error and
   the link-out button, never a faked listing.

While `WORKER_URL` is empty, the site falls back to direct browser
fetching (blocked by most stores' CORS) plus the link-out button, and
says so on the results page.

## Spelling variants

Searching also searches alternate English transliterations, per word,
and merges the results (deduplicated by product link), with a note
showing which variants were also searched. Examples: midrash/medrash/
midrashim, mishnah/mishna/mishnayos, chumash/humash, gemara/gemorah,
shulchan aruch/oruch, sefer/seforim, halacha/halochos, tefillah/tefila,
and other common a/e/o vowel swaps. This works with or without the
worker configured.

## Publish on GitHub Pages

1. Create a repository (e.g. `seforim-search`) and push these files to the
   `main` branch, keeping them at the repository root.
2. In the repo: **Settings → Pages → Build and deployment → Source:
   Deploy from a branch**, branch `main`, folder `/ (root)`. Save.
3. After a minute the site is live at
   `https://<your-username>.github.io/seforim-search/`.

## How the searching works (and its honest limits)

Without the worker configured, everything runs in the visitor's browser
— there is no server, and no intermediary: the page talks to the eight
stores directly, and nothing else receives the visitor's search. With
the worker configured (recommended, see above), the browser asks your
own worker instead, and the worker fetches the stores — that is the
only way real cards load for stores that don't send CORS headers.

For each included store the page fetches that store's own search results
and parses the listings out of the response. One honest limit: most
stores don't send the CORS headers a browser requires to let one website
read another, so for those stores the browser blocks the read. When that
happens — or when a store answers with a bot-check page, as Greenfield
Judaica currently does to automated visits — that store's section says so
plainly and offers a button opening the store's own search results.
Listings are never invented. Any store that later allows direct reads
(eSicha's product API is the closest candidate) will light up with real
cards automatically, because the parsers for all eight stores are built
in and verified against the stores' real pages.

Product images load straight from each store's own image URLs, so covers
always match the listing.
