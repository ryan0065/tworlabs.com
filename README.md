# TwoRLabs.com

Coming soon site for TwoRLabs, a kids' tech and AI studio.

Two brothers. Big ideas. Building a new world.

Everything Cloudflare Pages deploys lives in [`production/`](production/). That folder is the Pages root directory. It is plain HTML, CSS, and JavaScript, plus one Pages Function. There is no build step.

## Layout

```
wrangler.toml                 Local / Wrangler config (pages_build_output_dir = ./production)
functions -> production/functions
production/
  index.html                  Coming soon page
  404.html                    Custom not-found page
  _headers                    Security and cache headers for static files
  _routes.json                Run the Function only for /api/*
  robots.txt
  sitemap.xml
  site.webmanifest
  favicon.ico, favicon-16.png, favicon-32.png, apple-touch-icon.png
  css/styles.css
  js/main.js
  fonts/press-start-2p-latin.woff2
  assets/                     Logo (transparent PNG + WebP), icons, OG image, scenery
  functions/api/subscribe.js  POST /api/subscribe
```

Social links are the list in `production/index.html` marked "Edit social links in this list."

The shield logo is a cutout of the textured-hair master (edge flood-fill). `scripts/build_assets.py` rebuilds the images if you still have that master locally.

## Run it locally

In-memory signups, no Cloudflare account:

```bash
npm run preview
```

Opens at http://127.0.0.1:4173. The form posts to the real function.

With Wrangler (from the repo root; `functions` is a symlink so Pages dev can see it):

```bash
npx wrangler pages dev --kv SIGNUPS
```

Signup tests:

```bash
npm test
```

## Deploy on Cloudflare Pages

Create a Pages project from this Git repository.

| Setting | Value |
| --- | --- |
| Production branch | `main` |
| Root directory | `production` |
| Build command | *(leave empty)* |
| Build output directory | *(leave empty — the root directory is already the site)* |

Framework preset: None.

The `functions/` folder inside that root becomes Pages Functions. `/api/subscribe` is `production/functions/api/subscribe.js`.

### KV binding

The function reads `env.SIGNUPS`. No environment variables or secrets are required.

1. Create a Workers KV namespace (name it something like `tworlabs-signups`).

   ```bash
   npx wrangler kv namespace create SIGNUPS
   ```

2. In the Pages project go to **Settings → Bindings → Add → KV namespace**.
   - **Variable name:** `SIGNUPS` (exact spelling and case)
   - **KV namespace:** the namespace from step 1
   - Add it for **Production** and **Preview** (use a second namespace for preview if you do not want test emails mixed with real ones).
3. Redeploy. Bindings apply on the next deployment.

Git builds use the dashboard root directory `production`, so they do **not** read the repo-root `wrangler.toml`. The dashboard binding above is what production uses.

`wrangler.toml` is for Wrangler itself (`pages_build_output_dir = "./production"` and the same `SIGNUPS` binding, namespace id `0b522ad5f19244a6b5e3fcd58425440f`). A Wrangler file that Pages treats as the source of truth locks the matching dashboard fields.

### Read the signups

Each signup is one KV key: the email in lowercase. The value is JSON:

```json
{ "timestamp": "2026-11-10T18:00:00.000Z", "userAgent": "...", "country": "US" }
```

`country` comes from `request.cf.country` and is `null` when Cloudflare does not provide it. Keys that start with `rl:` are hourly rate-limit counters (5 posts per IP per hour). They expire and are not signups.

Dashboard: **Workers & Pages → KV → your namespace**.

Wrangler, using the namespace id from step 1:

```bash
npx wrangler kv key list --namespace-id YOUR_NAMESPACE_ID --remote
npx wrangler kv key get "someone@example.com" --namespace-id YOUR_NAMESPACE_ID --remote
```

## What the form does

`POST /api/subscribe` accepts JSON or a normal form body.

- Validates and lowercases the email. Duplicates stay on the list and keep the original record.
- A hidden `fax_number` field is a honeypot. If it is filled, the response still says "You're on the list!" and nothing is stored.
- The page submits with `fetch` and shows success or the error under the field. With JavaScript off, the form posts normally and the function returns a small HTML page.
