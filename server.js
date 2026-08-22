/*
 * Bespoke Mattress Price Calculator — server
 * Serves the calculator (public/index.html) AND a tiny API backed by Postgres.
 * Every saved order lands in the `orders` table = the "Invoiced Orders" log.
 *
 * Env:
 *   DATABASE_URL  — provided automatically by Railway's Postgres plugin
 *   PGSSL         — set to "true" only if you connect over Postgres' PUBLIC url
 *   PORT          — provided automatically by Railway
 *   RESEND_API_KEY — switches on the "Check price" supplier email (see the check-price block below);
 *                    optional companions EMAIL_FROM / EMAIL_FROM_NAME / EMAIL_REPLY_TO / EMAIL_SIGNOFF
 *                    and CHECK_PRICE_TO / CHECK_PRICE_CC to override the built-in recipients
 */
const express = require("express");
const path = require("path");
const fs = require("fs");
const { Pool } = require("pg");
const catalog = require("./catalog");

const app = express();
app.use(express.json({ limit: "1mb" }));

// ---- Per-supplier page: inject ONLY this deployment's supplier catalogue into the HTML ----
// SUPPLIER env picks which one (default "southern"). The browser therefore never receives
// another supplier's prices — true separation, no login needed.
const SUPPLIER = (process.env.SUPPLIER || "southern").toLowerCase();
// Owner gate: when OWNER_CODE is set, the reconciliation data (calculated price + price breakdown) is
// withheld from /api/orders unless the request proves ownership with the code. Southern is supplier-
// facing so it's gated by default (env override wins); Mattressshire is private so it stays ungated
// unless an OWNER_CODE env is explicitly set on that service.
const OWNER_CODE = process.env.OWNER_CODE || (SUPPLIER === "southern" ? "73371991aaA" : null);
const INDEX_PATH = path.join(__dirname, "public", "index.html");
let RENDERED_INDEX = null;
function getIndexHtml() {
  if (RENDERED_INDEX) return RENDERED_INDEX;
  const cat = catalog[SUPPLIER] || catalog.southern;
  const raw = fs.readFileSync(INDEX_PATH, "utf8");
  const json = JSON.stringify(cat).replace(/</g, "\\u003c"); // guard against </script>
  const inject = "<script>window.__CATALOG__=" + json + ";</script>\n";
  // inject before the FIRST <script> (the app script) — robust to line endings
  if (raw.indexOf("<script>") === -1) throw new Error("index.html has no <script> to inject before");
  RENDERED_INDEX = raw.replace("<script>", inject + "<script>");
  console.log("Serving catalogue for supplier: " + (cat && cat.key) + " (" + ((cat && cat.skus) || []).length + " SKUs)");
  return RENDERED_INDEX;
}
app.get(["/", "/index.html"], function (_req, res) {
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.type("html").send(getIndexHtml());
});

// static assets only (index.html is served above with the catalogue injected)
app.use(express.static(path.join(__dirname, "public"), {
  index: false,
  setHeaders: function (res, filePath) {
    if (filePath.endsWith(".html")) {
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    }
  }
}));

const hasDb = !!process.env.DATABASE_URL;
const pool = hasDb
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: false } : false,
    })
  : null;

async function initDb() {
  if (!pool) { console.warn("No DATABASE_URL set — API will report unavailable."); return; }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id          SERIAL PRIMARY KEY,
      order_no    TEXT NOT NULL,
      model       TEXT,
      size        TEXT,
      depth       TEXT,
      calc        NUMERIC,
      agreed      NUMERIC,
      carriage    TEXT,
      lines       JSONB,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS diagram TEXT`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS supplier TEXT`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS invoice TEXT`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS invoice_total NUMERIC`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS box_qty NUMERIC`);
  // Every "check price" email is logged here so the outstanding ones can be chased. A row is
  // OUTSTANDING until replied_at is stamped by the owner ticking it off.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS price_requests (
      id         SERIAL PRIMARY KEY,
      order_no   TEXT NOT NULL,
      invoice    TEXT,
      supplier   TEXT,
      sent_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      replied_at TIMESTAMPTZ
    );
  `);
  // Backfill legacy rows (saved before per-supplier tagging): Comfi/Imperial = Mattressshire, else Southern.
  await pool.query(`UPDATE orders SET supplier = 'mattressshire' WHERE supplier IS NULL AND (model ILIKE '%comfi%' OR model ILIKE '%imperial%')`);
  await pool.query(`UPDATE orders SET supplier = 'southern' WHERE supplier IS NULL`);
  console.log("Database ready. This deployment's supplier: " + SUPPLIER);
}

// health: the front-end pings this to decide DB vs local-storage mode
app.get("/api/health", async (_req, res) => {
  if (!pool) return res.status(503).json({ ok: false });
  try { await pool.query("SELECT 1"); res.json({ ok: true }); }
  catch (e) { res.status(503).json({ ok: false }); }
});

// owner gate: is this deployment gated, and does a code unlock it?
app.get("/api/owner/enabled", (_req, res) => res.json({ gated: !!OWNER_CODE }));
app.post("/api/owner/unlock", (req, res) => {
  const code = (req.body && req.body.code) || "";
  res.json({ ok: !!OWNER_CODE && String(code) === OWNER_CODE });
});

// list — newest first, scoped to THIS deployment's supplier ("combined" sees all).
// When gated (OWNER_CODE set) and the caller isn't the owner, WITHHOLD the calculated price + line
// breakdown so the supplier-facing view can't reveal any discrepancy — the data never reaches them.
app.get("/api/orders", async (req, res) => {
  if (!pool) return res.status(503).json([]);
  try {
    let where = "", params = [];
    if (SUPPLIER !== "combined") { where = "WHERE supplier = $1"; params = [SUPPLIER]; }
    const { rows } = await pool.query(
      `SELECT id, order_no AS "order", created_at AS ts, model, size, depth, calc, agreed, carriage, lines, diagram, supplier, invoice, invoice_total AS "invoiceTotal", box_qty AS "boxQty"
         FROM orders ${where} ORDER BY created_at DESC LIMIT 2000`, params
    );
    const gated = OWNER_CODE && req.get("x-owner-code") !== OWNER_CODE;
    if (gated) rows.forEach((r) => { delete r.calc; delete r.lines; });
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json([]); }
});

// save one order
app.post("/api/orders", async (req, res) => {
  if (!pool) return res.status(503).json({ error: "no database" });
  const b = req.body || {};
  if (!b.order) return res.status(400).json({ error: "order number required" });
  try {
    const { rows } = await pool.query(
      `INSERT INTO orders (order_no, model, size, depth, calc, agreed, carriage, lines, diagram, supplier, invoice, invoice_total, box_qty)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [b.order, b.model || null, b.size || null, b.depth || null,
       b.calc == null ? null : b.calc, b.agreed == null ? null : b.agreed,
       b.carriage || null, JSON.stringify(b.lines || []), b.diagram || null,
       SUPPLIER,  // tag with THIS deployment's supplier so each calculator lists only its own
       b.invoice || null,
       (b.invoiceTotal == null || b.invoiceTotal === "") ? null : b.invoiceTotal,
       (b.boxQty == null || b.boxQty === "") ? null : b.boxQty]
    );
    res.json({ ok: true, id: rows[0].id });
  } catch (e) { console.error(e); res.status(500).json({ error: "save failed" }); }
});

// delete one
app.delete("/api/orders/:id", async (req, res) => {
  if (!pool) return res.status(503).json({ error: "no database" });
  if (OWNER_CODE && req.get("x-owner-code") !== OWNER_CODE) return res.status(403).json({ error: "locked" }); // supplier can't delete
  try { await pool.query("DELETE FROM orders WHERE id = $1", [req.params.id]); res.json({ ok: true }); }
  catch (e) { console.error(e); res.status(500).json({ error: "delete failed" }); }
});

// ---- "Check price" supplier email (Resend HTTP API) ----
// One click on a saved order emails THIS deployment's supplier asking for that order's price
// breakdown. Owner-gated exactly like DELETE, so on the shared Southern tool only the owner can
// fire it (Mattressshire has no OWNER_CODE — it's private to the owner already).
// Mechanism copied from the quote app (shopify-mattress-quote-system/backend/services/email-sender.js):
// a plain HTTPS POST to Resend, no SMTP. Set RESEND_API_KEY on the Railway service to switch it on —
// the key is deliberately NOT defaulted in code the way OWNER_CODE is, because it's a real secret.
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const EMAIL_FROM = process.env.EMAIL_FROM || "quotes@mybespokemattress.com"; // verified Resend sender
const EMAIL_FROM_NAME = process.env.EMAIL_FROM_NAME || "My Bespoke Order";
const EMAIL_REPLY_TO = process.env.EMAIL_REPLY_TO || "hello@mybespokemattress.com"; // monitored inbox
const EMAIL_SIGNOFF = process.env.EMAIL_SIGNOFF || "Angelo";

// Who each supplier's price queries go to. Cc is the shared inbox that covers holidays/absence.
const CHECK_PRICE_RECIPIENTS = {
  southern:      { to: ["michele@southernfoam.co.uk"], cc: ["mbm@southernfoam.co.uk"] },
  mattressshire: { to: ["mattressshire.wmltd@gmail.com"], cc: [] },
};
function envList(name) {
  const raw = (process.env[name] || "").trim();
  if (!raw) return null;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}
// The owner is always copied in, so the request lands in the SAME inbox the reply comes back to
// (EMAIL_REPLY_TO) and can be flagged there and chased until the supplier answers. Set the env to an
// empty string to switch the copy off.
const EMAIL_COPY_TO = process.env.EMAIL_COPY_TO === undefined
  ? "hello@mybespokemattress.com"
  : process.env.EMAIL_COPY_TO.trim();

const recipients = CHECK_PRICE_RECIPIENTS[SUPPLIER] || { to: [], cc: [] };
const CHECK_TO = envList("CHECK_PRICE_TO") || recipients.to;
const CHECK_CC = (envList("CHECK_PRICE_CC") || recipients.cc)
  .concat(EMAIL_COPY_TO ? [EMAIL_COPY_TO] : [])
  .filter((a, i, all) => a && all.indexOf(a) === i); // de-dupe, in case the copy is already listed
const checkPriceEnabled = !!(RESEND_API_KEY && CHECK_TO.length);

function isOwner(req) { return !OWNER_CODE || req.get("x-owner-code") === OWNER_CODE; }
function escHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// The wording the operator sees in the compose box IS the wording that gets sent — both come from
// here, so the preview can never drift from the email that actually goes out.
function subjectFor(order, invoice) {
  return "Price breakdown request — order " + order + (invoice ? " (invoice " + invoice + ")" : "");
}
function defaultBody(order, invoice) {
  return [
    "Hello,",
    "",
    "Please could you send me a price breakdown for " +
      (invoice ? "order " + order + " on invoice " + invoice : "order " + order),
    "",
    "Many thanks,",
    EMAIL_SIGNOFF,
  ].join("\n");
}
// The body is operator-typed, so it is escaped before going anywhere near the HTML part.
function bodyToHtml(body) {
  return '<div style="font-family: Arial, sans-serif; color: #111827; line-height: 1.6;">' +
    escHtml(body).replace(/\n/g, "<br>") + "</div>";
}

async function sendViaResend({ to, cc, subject, html, text }) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + RESEND_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: EMAIL_FROM_NAME + " <" + EMAIL_FROM + ">",
      to: to,
      cc: cc && cc.length ? cc : undefined,
      reply_to: EMAIL_REPLY_TO,
      subject: subject,
      html: html,
      text: text || undefined,
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.message || JSON.stringify(data));
  return data.id;
}

// Is the button available, and (owner only) who would it email?
app.get("/api/check-price/enabled", (req, res) => {
  if (!checkPriceEnabled || !isOwner(req)) return res.json({ enabled: false });
  res.json({ enabled: true, to: CHECK_TO, cc: CHECK_CC });
});

// What would be sent for this order — fills the compose box before the operator edits it.
app.get("/api/check-price/draft", (req, res) => {
  if (!checkPriceEnabled || !isOwner(req)) return res.status(403).json({ error: "locked" });
  const order = String(req.query.order || "").trim();
  if (!order) return res.status(400).json({ error: "order number required" });
  const invoice = String(req.query.invoice || "").trim();
  res.json({ subject: subjectFor(order, invoice), body: defaultBody(order, invoice), to: CHECK_TO, cc: CHECK_CC });
});

app.post("/api/check-price", async (req, res) => {
  if (!checkPriceEnabled) return res.status(503).json({ error: "email not configured" });
  if (!isOwner(req)) return res.status(403).json({ error: "locked" });
  const b = req.body || {};
  const order = String(b.order || "").trim();
  if (!order) return res.status(400).json({ error: "order number required" });
  const invoice = String(b.invoice || "").trim();

  // Whatever the operator left in the compose box is what goes out, verbatim. The default is only
  // the starting point — and the fallback for a caller that sends no body at all.
  const edited = typeof b.message === "string" ? b.message.trim() : "";
  if (edited.length > 5000) return res.status(400).json({ error: "message too long" });
  const text = edited || defaultBody(order, invoice);
  const subject = subjectFor(order, invoice);
  const html = bodyToHtml(text);

  try {
    const id = await sendViaResend({ to: CHECK_TO, cc: CHECK_CC, subject: subject, html: html, text: text });
    console.log("check-price email sent for " + order + " -> " + CHECK_TO.join(", ") + " (" + id + ")");
    // Log it as outstanding. The email has already gone, so a logging failure must not read as a
    // send failure — report the send as the success it was and just note the lost reminder.
    let requestId = null;
    if (pool) {
      try {
        const r = await pool.query(
          "INSERT INTO price_requests (order_no, invoice, supplier) VALUES ($1,$2,$3) RETURNING id",
          [order, invoice || null, SUPPLIER]
        );
        requestId = r.rows[0].id;
      } catch (e) { console.error("check-price: sent but not logged:", e.message); }
    }
    res.json({ ok: true, id: id, requestId: requestId, to: CHECK_TO, cc: CHECK_CC });
  } catch (e) {
    console.error("check-price send failed:", e.message);
    res.status(502).json({ error: "send failed" });
  }
});

// Record a request that was already made — sent before this log existed, or asked by phone or
// from a normal mail client — so it joins the chase list WITHOUT emailing the supplier again.
app.post("/api/check-price/log", async (req, res) => {
  if (!pool) return res.status(503).json({ error: "no database" });
  if (!isOwner(req)) return res.status(403).json({ error: "locked" });
  const b = req.body || {};
  const order = String(b.order || "").trim();
  if (!order) return res.status(400).json({ error: "order number required" });
  const invoice = String(b.invoice || "").trim() || null;
  // sentAt is optional; without it the wait is timed from now, which understates an older request
  let sentAt = null;
  if (b.sentAt) {
    sentAt = new Date(b.sentAt);
    if (isNaN(sentAt.getTime())) return res.status(400).json({ error: "bad sentAt" });
  }
  try {
    const { rows } = await pool.query(
      "INSERT INTO price_requests (order_no, invoice, supplier, sent_at) VALUES ($1,$2,$3, COALESCE($4, now())) RETURNING id, sent_at",
      [order, invoice, SUPPLIER, sentAt]
    );
    console.log("check-price request logged (not emailed) for " + order);
    res.json({ ok: true, id: rows[0].id, sentAt: rows[0].sent_at });
  } catch (e) { console.error(e); res.status(500).json({ error: "log failed" }); }
});

// Outstanding price-breakdown requests: what's been asked for and not yet answered.
app.get("/api/check-price/pending", async (req, res) => {
  if (!pool || !isOwner(req)) return res.json([]);
  try {
    const { rows } = await pool.query(
      `SELECT id, order_no AS "order", invoice, sent_at AS "sentAt"
         FROM price_requests
        WHERE replied_at IS NULL AND supplier = $1
        ORDER BY sent_at ASC`, [SUPPLIER]
    );
    res.json(rows);
  } catch (e) { console.error(e); res.json([]); }
});

// Tick one off once the supplier answers (or untick it — a mis-click shouldn't lose the chase).
app.post("/api/check-price/:id/replied", async (req, res) => {
  if (!pool) return res.status(503).json({ error: "no database" });
  if (!isOwner(req)) return res.status(403).json({ error: "locked" });
  const replied = !(req.body && req.body.replied === false);
  try {
    await pool.query("UPDATE price_requests SET replied_at = $1 WHERE id = $2",
      [replied ? new Date() : null, req.params.id]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: "update failed" }); }
});

// ---- Order-app bridge (server-side; key + order-app URL never reach the browser) ----
const ORDER_APP_URL = (process.env.ORDER_APP_URL || "").replace(/\/$/, "");
const PRICING_API_KEY = process.env.PRICING_API_KEY || "";
const lookupEnabled = !!(ORDER_APP_URL && PRICING_API_KEY);

app.get("/api/order/enabled", (_req, res) => res.json({ enabled: lookupEnabled }));

app.get("/api/order/search", async (req, res) => {
  if (!lookupEnabled) return res.json([]);
  try {
    const u = ORDER_APP_URL + "/api/pricing/search?q=" + encodeURIComponent(req.query.q || "");
    const r = await fetch(u, { headers: { "x-api-key": PRICING_API_KEY } });
    res.json(r.ok ? await r.json() : []);
  } catch (e) { console.error("order/search", e.message); res.json([]); }
});

app.get("/api/order/lookup/:orderNumber", async (req, res) => {
  if (!lookupEnabled) return res.status(503).json({ error: "lookup disabled" });
  try {
    const u = ORDER_APP_URL + "/api/pricing/lookup/" + encodeURIComponent(req.params.orderNumber);
    const r = await fetch(u, { headers: { "x-api-key": PRICING_API_KEY } });
    if (!r.ok) return res.status(r.status).json({ error: "order not found" });
    res.json(await r.json());
  } catch (e) { console.error("order/lookup", e.message); res.status(502).json({ error: "order app unreachable" }); }
});

const PORT = process.env.PORT || 3000;
initDb()
  .catch((e) => console.error("DB init error:", e))
  .finally(() => app.listen(PORT, () => console.log("Listening on " + PORT)));
