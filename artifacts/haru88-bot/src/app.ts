import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";
import router from "./routes";
import { logger } from "./lib/logger";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

// Security: allow CORS for Telegram WebApp origins and same-origin, block others
app.use(cors({
  origin: (origin, callback) => {
    // Allow: no origin (same-origin, curl, mobile apps), Telegram WebApp, localhost dev
    if (!origin) return callback(null, true);
    if (
      origin.includes("telegram.org") ||
      origin.includes("localhost") ||
      origin.includes("replit.dev") ||
      origin.includes("replit.app") ||
      origin.includes("onrender.com")
    ) {
      return callback(null, true);
    }
    return callback(null, false);
  },
  credentials: true,
}));

// Security headers
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

const publicDir = path.join(__dirname, "..", "public");

const apiBase = process.env.API_BASE_PATH ?? "/api";

app.use(
  `${apiBase}/games`,
  express.static(path.join(publicDir, "games", "games"), {
    setHeaders: (res) => {
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("X-Frame-Options", "ALLOWALL");
    },
  }),
);

app.use(apiBase, router);

// Serve admin frontend static files in production (Docker/Render deploy)
// From dist/index.mjs: __dirname = artifacts/api-server/dist
// → ../../haru88-admin/dist/public = artifacts/haru88-admin/dist/public
const adminPublicDir = path.join(
  __dirname,
  "..",
  "..",
  "haru88-admin",
  "dist",
  "public",
);

// Always redirect root → /admin/
app.get("/", (_req, res) => { res.redirect(301, "/admin/"); });

if (existsSync(adminPublicDir)) {
  // Vite builds with base=/admin/ so assets are at /admin/assets/...
  // Must serve under /admin to match those paths
  app.use("/admin", express.static(adminPublicDir));

  // SPA fallback: any /admin/* route that isn't a file → serve index.html
  app.get("/admin", (_req, res) => {
    res.sendFile(path.join(adminPublicDir, "index.html"));
  });
  app.get("/admin/*path", (_req, res) => {
    res.sendFile(path.join(adminPublicDir, "index.html"));
  });
} else {
  // Fallback status page when admin panel is not bundled (e.g. Docker/Render deploy)
  app.get("/", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`<!DOCTYPE html>
<html lang="vi">
<head><meta charset="UTF-8"><title>Haru88 Bot</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0f172a;color:#e2e8f0;}
.box{text-align:center;padding:2rem;border:1px solid #334155;border-radius:1rem;}
h1{color:#38bdf8;margin-bottom:.5rem;}span{color:#4ade80;}</style>
</head>
<body><div class="box">
<h1>🤖 Haru88 Bot</h1>
<p>Server đang chạy bình thường.</p>
<p>Status: <span>✅ Online</span></p>
<p style="color:#94a3b8;font-size:.85rem;">API: <code>/api/healthz</code></p>
</div></body></html>`);
  });
}

export default app;
