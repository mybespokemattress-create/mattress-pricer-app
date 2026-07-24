# Deploy the Mattress Price Calculator to Railway

This one app serves the calculator **and** stores every saved order in a Postgres
database (the "Invoiced Orders" log). Anyone with the final link can use it.

## What's in this folder
- `server.js` — the web server + API (`/api/orders`)
- `package.json` — dependencies (express, pg)
- `public/index.html` — the calculator itself
- `.gitignore`

You need a free **GitHub** account and a **Railway** account (railway.app).

---

## 1. Put this folder on GitHub
In a terminal, inside the `mattress-pricer-app` folder:

```
git init
git add .
git commit -m "Mattress price calculator + Invoiced Orders DB"
```

Create a new empty repo on github.com (e.g. `mattress-pricer-app`), then:

```
git remote add origin https://github.com/<you>/mattress-pricer-app.git
git branch -M main
git push -u origin main
```

## 2. Create the Railway project
1. Go to **railway.app → New Project → Deploy from GitHub repo**.
2. Pick `mattress-pricer-app`. Railway installs and starts it automatically
   (it runs `npm start`).

## 3. Add the database
1. In the same project: **New → Database → Add PostgreSQL**.
2. Open your **app service → Variables → New Variable**:
   - Name: `DATABASE_URL`
   - Value: `${{Postgres.DATABASE_URL}}`  (Railway autocompletes this — pick the Postgres reference)
3. The app redeploys and creates the `orders` table on start-up.

## 4. Get the public link
1. App service → **Settings → Networking → Generate Domain**.
2. You get a URL like `https://mattress-pricer-production.up.railway.app`.
3. Open it — the calculator loads, and the note under **Invoiced Orders** should say
   *"Stored in the database…"*. Save a test order, refresh — it stays. Done.

Send **that** Railway URL to whoever needs it (it replaces the Netlify link).

---

## 5. Connect it to the order app (auto-fill by order number)
This lets the operator type a `#CARA…` number and have SKU + size + diagram pulled from
the order-processing app. The calculator's **server** calls the order app privately with a
shared key — the supplier's browser never sees the order app or the key.

**On the ORDER app (shopify-mattress-processor):**
1. Add a variable `PRICING_API_KEY` = a long random string (make one up, e.g. a password-generator value).
2. It already has the read-only endpoint (`/api/pricing/...`) — just redeploy so the new key + route are live.

**On THIS calculator app, add two variables:**
- `ORDER_APP_URL` = the order app's Railway URL (e.g. `https://shopify-mattress-processor-production.up.railway.app`)
- `PRICING_API_KEY` = **the same string** you set on the order app.

Redeploy. The order box now autocompletes and auto-fills. If either variable is missing,
the calculator simply works without lookup (plain order-number box) — nothing breaks.

Only pricing data crosses the bridge (order number, SKU, width A / length B, diagram URL) —
**no customer names, emails or addresses.**

## Notes
- **Table:** auto-created on first boot — nothing to run by hand.
- **SSL:** not needed with the `${{Postgres.DATABASE_URL}}` reference (private network).
  Only if you ever use Postgres' **public** URL, add a variable `PGSSL=true`.
- **Updating the tool later:** push a new commit to GitHub → Railway redeploys the same URL.
- **Fallback:** if the database is ever unreachable, the page quietly falls back to
  browser storage so it still works; the note will say "Local demo storage".
- **API:** `GET/POST /api/orders`, `DELETE /api/orders/:id`, `GET /api/health`.
