const express = require("express");
const rateLimit = require("express-rate-limit");
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { sendEmail, maskConfig } = require("./email.js");
const { buildEmailHtml } = require("./emailTemplate.js");

const app = express();
const PORT = process.env.PORT || 8080;
const DB_PATH = process.env.DB_PATH || "/data/billhive.db";

// ── Logging ─────────────────────────────────────────────────────────────────
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const rawLevel = (process.env.LOG_LEVEL || "info").toLowerCase();
const effectiveLevel = LOG_LEVELS.hasOwnProperty(rawLevel) ? rawLevel : "info";
const levelValue = LOG_LEVELS[effectiveLevel];

const log = {
  debug: (...args) => {
    if (levelValue <= 0) console.log("[DEBUG]", ...args);
  },
  info: (...args) => {
    if (levelValue <= 1) console.log("[INFO]", ...args);
  },
  warn: (...args) => {
    if (levelValue <= 2) console.warn("[WARN]", ...args);
  },
  error: (...args) => {
    if (levelValue <= 3) console.error("[ERROR]", ...args);
  },
};
// ─────────────────────────────────────────────────────────────────────────────

// ── Ensure data directory exists ──────────────────────────────────────────────
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// ── Database setup ────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS user_state (
    user_id    TEXT    NOT NULL,
    key        TEXT    NOT NULL,
    value      TEXT    NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (user_id, key)
  );

  CREATE TABLE IF NOT EXISTS email_config (
    user_id    TEXT    NOT NULL PRIMARY KEY,
    config     TEXT    NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS monthly_data (
    user_id    TEXT    NOT NULL,
    month_key  TEXT    NOT NULL,
    data       TEXT    NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (user_id, month_key)
  );
`);

// Prepared statements
const stmts = {
  getState: db.prepare(
    "SELECT value FROM user_state WHERE user_id = ? AND key = ?",
  ),
  setState: db.prepare(
    "INSERT OR REPLACE INTO user_state (user_id, key, value, updated_at) VALUES (?, ?, ?, unixepoch())",
  ),
  getAllState: db.prepare(
    "SELECT key, value FROM user_state WHERE user_id = ?",
  ),
  getMonth: db.prepare(
    "SELECT data FROM monthly_data WHERE user_id = ? AND month_key = ?",
  ),
  setMonth: db.prepare(
    "INSERT OR REPLACE INTO monthly_data (user_id, month_key, data, updated_at) VALUES (?, ?, ?, unixepoch())",
  ),
  getAllMonths: db.prepare(
    "SELECT month_key, data FROM monthly_data WHERE user_id = ? ORDER BY month_key ASC",
  ),
  deleteMonth: db.prepare(
    "DELETE FROM monthly_data WHERE user_id = ? AND month_key = ?",
  ),
  getEmailCfg: db.prepare("SELECT config FROM email_config WHERE user_id = ?"),
  setEmailCfg: db.prepare(
    "INSERT OR REPLACE INTO email_config (user_id, config, updated_at) VALUES (?, ?, unixepoch())",
  ),
};

// ── SSE client tracking ───────────────────────────────────────────────────────
const sseClients = new Map(); // userId -> Set of res objects

function broadcastChange(userId) {
  const clients = sseClients.get(userId);
  if (!clients) return;
  for (const res of clients) {
    res.write("event: data-changed\ndata: {}\n\n");
  }
}

// ── Rate limiting — 300 requests per 15 min per IP (generous for self-hosted) ─
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300 });
app.use(limiter);

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: "2mb" }));

// Auth — reads user identity injected by reverse proxy (Authelia / Authentik).
// Falls back to "local" for single-user mode with no proxy.
app.use((req, res, next) => {
  req.userId =
    req.headers["remote-user"] || // Authelia
    req.headers["x-authentik-username"] || // Authentik
    req.headers["x-forwarded-user"] || // Generic
    req.headers["x-remote-user"] ||
    "local";
  next();
});

// Request logger (skip noisy static asset requests)
app.use((req, _res, next) => {
  if (req.path.startsWith("/api")) {
    log.info(
      `[${new Date().toISOString()}] ${req.method} ${req.path} user=${req.userId}`,
    );
    if (effectiveLevel === "debug") {
      log.debug(
        "userId:",
        req.userId ?? "anon",
        "Content-Length:",
        req.headers["content-length"] ?? 0,
      );
    }
  }
  next();
});

// ── Static frontend ───────────────────────────────────────────────────────────
// Serves index.html (and any future assets) from the /public directory
app.use(
  express.static(path.join(__dirname, "public"), {
    etag: true,
    maxAge: "1h",
  }),
);

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/api/health", (req, res) => {
  res.json({ ok: true, user: req.userId, ts: Date.now() });
});

// ── State API ─────────────────────────────────────────────────────────────────
app.get("/api/state", (req, res) => {
  const rows = stmts.getAllState.all(req.userId);
  const state = {};
  rows.forEach((r) => {
    try {
      state[r.key] = JSON.parse(r.value);
    } catch {
      state[r.key] = r.value;
    }
  });
  res.json(state);
});

app.put("/api/state", (req, res) => {
  const body = req.body;
  if (!body || typeof body !== "object")
    return res.status(400).json({ error: "Invalid body" });
  const saveMany = db.transaction((userId, data) => {
    for (const [key, val] of Object.entries(data)) {
      stmts.setState.run(userId, key, JSON.stringify(val));
    }
  });
  saveMany(req.userId, body);
  res.json({ ok: true });
  broadcastChange(req.userId);
  // Fire webhooks for each key (non-blocking, after response sent)
  for (const [key, val] of Object.entries(body)) {
    fireWebhook(req.userId, key, val);
  }
});

app.patch("/api/state/:key", (req, res) => {
  stmts.setState.run(req.userId, req.params.key, JSON.stringify(req.body));
  res.json({ ok: true });
  broadcastChange(req.userId);
  // Fire webhook (non-blocking, after response sent)
  fireWebhook(req.userId, req.params.key, req.body);
});

// ── Monthly data API ──────────────────────────────────────────────────────────
app.get("/api/months", (req, res) => {
  const rows = stmts.getAllMonths.all(req.userId);
  const months = {};
  rows.forEach((r) => {
    try {
      months[r.month_key] = JSON.parse(r.data);
    } catch {}
  });
  res.json(months);
});

app.get("/api/months/:key", (req, res) => {
  const row = stmts.getMonth.get(req.userId, req.params.key);
  if (!row) return res.json({});
  try {
    res.json(JSON.parse(row.data));
  } catch {
    res.json({});
  }
});

app.put("/api/months/:key", (req, res) => {
  const key = req.params.key;
  if (!/^\d{4}-\d{2}$/.test(key))
    return res
      .status(400)
      .json({ error: "Invalid month key (expected YYYY-MM)" });
  stmts.setMonth.run(req.userId, key, JSON.stringify(req.body));
  res.json({ ok: true });
  broadcastChange(req.userId);
});

app.delete("/api/months/:key", (req, res) => {
  stmts.deleteMonth.run(req.userId, req.params.key);
  res.json({ ok: true });
  broadcastChange(req.userId);
});

// ── Export / Import ───────────────────────────────────────────────────────────
app.get("/api/export", (req, res) => {
  const state = {};
  stmts.getAllState.all(req.userId).forEach((r) => {
    try {
      state[r.key] = JSON.parse(r.value);
    } catch {}
  });
  const monthly = {};
  stmts.getAllMonths.all(req.userId).forEach((r) => {
    try {
      monthly[r.month_key] = JSON.parse(r.data);
    } catch {}
  });
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="billhive-backup-${req.userId}-${Date.now()}.json"`,
  );
  res.json({
    user: req.userId,
    exportedAt: new Date().toISOString(),
    state,
    monthly,
  });
});

app.post("/api/import", (req, res) => {
  const { state, monthly } = req.body;
  const importAll = db.transaction((userId, s, m) => {
    if (s)
      for (const [k, v] of Object.entries(s))
        stmts.setState.run(userId, k, JSON.stringify(v));
    if (m)
      for (const [k, v] of Object.entries(m))
        stmts.setMonth.run(userId, k, JSON.stringify(v));
  });
  importAll(req.userId, state, monthly);
  res.json({ ok: true });
  broadcastChange(req.userId);
});

// ── Email config API ──────────────────────────────────────────────────────────
// GET /api/email/config — returns masked config (never exposes secrets)
app.get("/api/email/config", (req, res) => {
  const row = stmts.getEmailCfg.get(req.userId);
  if (!row) return res.json(null);
  try {
    const cfg = JSON.parse(row.config);
    res.json(maskConfig(cfg));
  } catch {
    res.json(null);
  }
});

// PUT /api/email/config — save full config including secrets
app.put("/api/email/config", (req, res) => {
  const body = req.body;
  if (!body || !body.provider)
    return res.status(400).json({ error: "provider required" });
  // Merge with existing to allow partial updates (so masked fields aren't overwritten with masked values)
  let existing = {};
  const row = stmts.getEmailCfg.get(req.userId);
  if (row) {
    try {
      existing = JSON.parse(row.config);
    } catch {}
  }
  // Only update secret fields if they don't look like masked values
  const secretFields = [
    "mailgunApiKey",
    "sendgridApiKey",
    "resendApiKey",
    "smtpPass",
  ];
  const merged = { ...existing, ...body };
  secretFields.forEach((f) => {
    if (body[f] && body[f].includes("••••")) {
      merged[f] = existing[f]; // keep original if user didn't change it
    }
  });
  stmts.setEmailCfg.run(req.userId, JSON.stringify(merged));
  res.json({ ok: true });
});

// POST /api/email/test — send a test email to the configured from address
app.post("/api/email/test", async (req, res) => {
  const row = stmts.getEmailCfg.get(req.userId);
  if (!row) return res.status(400).json({ error: "No email config saved" });
  let cfg;
  try {
    cfg = JSON.parse(row.config);
  } catch {
    return res.status(400).json({ error: "Invalid config" });
  }
  const { html, text } = buildEmailHtml({
    greeting: "Hey there,",
    personName: "You",
    accentColor: "#F5A800",
    monthLabel: "Test Email",
    bills: [
      { name: "Electric", amount: 85.0 },
      { name: "Internet", amount: 59.99 },
    ],
    total: 144.99,
    payMethod: "none",
    fromName: cfg.fromName || "BillHive",
  });
  try {
    await sendEmail(cfg, cfg.fromEmail, "BillHive — Test Email", html, text);
    res.json({ ok: true, message: `Test email sent to ${cfg.fromEmail}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/email/send — send bill summary to a person
app.post("/api/email/send", async (req, res) => {
  const {
    to,
    greeting,
    personName,
    accentColor,
    monthLabel,
    bills,
    total,
    payMethod,
    payId,
    zelleUrl,
  } = req.body;
  if (!to) return res.status(400).json({ error: "recipient (to) required" });

  const row = stmts.getEmailCfg.get(req.userId);
  if (!row)
    return res.status(400).json({
      error: "No email provider configured. Set it up in Settings → Email.",
    });
  let cfg;
  try {
    cfg = JSON.parse(row.config);
  } catch {
    return res.status(400).json({ error: "Invalid email config" });
  }

  const { html, text } = buildEmailHtml({
    greeting,
    personName,
    accentColor,
    monthLabel,
    bills,
    total,
    payMethod,
    payId,
    zelleUrl,
    fromName: cfg.fromName || "BillHive",
  });

  const subject = `Bills for ${monthLabel}`;
  try {
    await sendEmail(cfg, to, subject, html, text);
    res.json({ ok: true });
  } catch (e) {
    log.error("Email send failed:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/email/send-all — send bill summary to multiple people in one call
app.post("/api/email/send-all", async (req, res) => {
  const { recipients } = req.body;

  // Validate input
  if (!Array.isArray(recipients) || recipients.length === 0) {
    return res
      .status(400)
      .json({ error: "recipients must be a non-empty array" });
  }

  // Pre-flight: check email config once
  const row = stmts.getEmailCfg.get(req.userId);
  if (!row) {
    return res.status(400).json({ error: "No email provider configured" });
  }
  let cfg;
  try {
    cfg = JSON.parse(row.config);
  } catch {
    return res.status(400).json({ error: "Invalid email config" });
  }

  // Fan out — iterate sequentially to avoid overwhelming the SMTP server
  // and to isolate failures
  const results = [];
  for (const recipient of recipients) {
    const recipientEmail = recipient.to ?? recipient.email;
    try {
      const { html, text } = buildEmailHtml({
        greeting: recipient.greeting,
        personName: recipient.personName,
        accentColor: recipient.accentColor,
        monthLabel: recipient.monthLabel,
        bills: recipient.bills,
        total: recipient.total,
        payMethod: recipient.payMethod,
        payId: recipient.payId,
        zelleUrl: recipient.zelleUrl,
        fromName: cfg.fromName || "BillHive",
      });
      const subject = `Bills for ${recipient.monthLabel}`;
      await sendEmail(cfg, recipientEmail, subject, html, text);
      log.info(`[send-all] Sent to ${recipientEmail}`);
      results.push({ to: recipientEmail, ok: true });
    } catch (err) {
      log.error(`[send-all] Failed to send to ${recipientEmail}:`, err.message);
      results.push({ to: recipientEmail, ok: false, error: err.message });
    }
  }

  return res.json({ results });
});

// ── Webhook helpers ─────────────────────────────────────────────────────────

/**
 * Fire an outbound webhook POST on state change.
 * Called asynchronously (not awaited) after the API response is sent.
 *
 * @param {string} userId - the authenticated user ID
 * @param {string} key    - the state key that changed
 * @param {*}      value  - the new value
 */
function fireWebhook(userId, key, value) {
  // Blocklist: never fire webhooks for sensitive config keys
  if (key === "emailConfig" || key === "webhookConfig") return;

  // Read webhook config from user_state
  const row = stmts.getState.get(userId, "webhookConfig");
  if (!row) return;
  let webhookCfg;
  try {
    webhookCfg = JSON.parse(row.value);
  } catch {
    return;
  }
  if (!webhookCfg || !webhookCfg.url) return;

  // Construct payload
  const userIdHash = crypto
    .createHash("sha256")
    .update(userId)
    .digest("hex")
    .slice(0, 16);
  const payload = {
    event: "state.changed",
    userId: userIdHash,
    key,
    value,
    ts: new Date().toISOString(),
  };

  const body = JSON.stringify(payload);
  const headers = { "Content-Type": "application/json" };

  // HMAC signature if secret is configured
  if (webhookCfg.secret) {
    const sig = crypto
      .createHmac("sha256", webhookCfg.secret)
      .update(body)
      .digest("hex");
    headers["X-BillHive-Signature"] = `sha256=${sig}`;
  }

  // Fire and forget with a 3-second timeout
  fetch(webhookCfg.url, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(3000),
  })
    .then((resp) => {
      if (!resp.ok) {
        log.warn(
          `[webhook] delivery failed: HTTP ${resp.status} from ${webhookCfg.url}`,
        );
      }
    })
    .catch((err) => {
      log.warn("[webhook] delivery failed:", err.message);
    });
}

// ── Webhook config API ──────────────────────────────────────────────────────

// PUT /api/webhook/config — save webhook configuration
app.put("/api/webhook/config", (req, res) => {
  const { url, secret } = req.body;
  if (!url || typeof url !== "string" || url.trim() === "") {
    return res.status(400).json({ error: "url is required" });
  }
  if (!url.startsWith("https://") && !url.startsWith("http://")) {
    return res
      .status(400)
      .json({ error: "url must start with https:// or http://" });
  }

  const config = { url };
  if (secret !== undefined) config.secret = secret;

  stmts.setState.run(req.userId, "webhookConfig", JSON.stringify(config));
  res.json({ ok: true });
});

// GET /api/webhook/config — retrieve webhook config with masked secret
app.get("/api/webhook/config", (req, res) => {
  const row = stmts.getState.get(req.userId, "webhookConfig");
  if (!row) return res.json({ configured: false });
  let cfg;
  try {
    cfg = JSON.parse(row.value);
  } catch {
    return res.json({ configured: false });
  }

  let maskedSecret = null;
  if (cfg.secret) {
    maskedSecret =
      cfg.secret.slice(0, 4) +
      "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022";
  }

  res.json({ configured: true, url: cfg.url, secret: maskedSecret });
});

// ── SSE event stream ─────────────────────────────────────────────────────────
app.get("/api/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  res.write("event: connected\ndata: {}\n\n");

  if (!sseClients.has(req.userId)) sseClients.set(req.userId, new Set());
  sseClients.get(req.userId).add(res);

  req.on("close", () => {
    sseClients.get(req.userId)?.delete(res);
  });
});

// ── SPA fallback — serve index.html for any non-API route ────────────────────
app.get("*", limiter, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, "0.0.0.0", () => {
  log.info(
    `BillHive listening on port ${PORT} | db: ${DB_PATH} | log-level: ${effectiveLevel}`,
  );
  log.info(
    `Auth: Remote-User / X-Authentik-Username / X-Forwarded-User (fallback: "local")`,
  );
});
