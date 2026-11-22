import path from "node:path";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";

export * from "./app.js";
export * from "./auth.js";
export * from "./db.js";
export * from "./git-protocol.js";
export * from "./policy-engine.js";
export * from "./webhooks.js";
export * from "./forges/index.js";
export * from "./local-git-http.js";

const isDirectRun =
  process.argv[1]?.endsWith("/dist/index.js") || process.argv[1]?.endsWith("/src/index.ts");

if (isDirectRun) {
  const port = Number.parseInt(process.env.PORT ?? "4321", 10);
  const dbPath = process.env.AGIT_DB_PATH ?? "./agentic-git.db";
  const bootstrapAdminToken = process.env.AGIT_ADMIN_TOKEN;
  const webDistDir =
    process.env.AGIT_WEB_DIR ?? path.resolve(import.meta.dirname, "../../web/dist");

  const { app, adminToken } = createApp({ dbPath, bootstrapAdminToken, webDistDir });

  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`[agentic-git] Server listening on http://127.0.0.1:${info.port}`);
    console.log(`[agentic-git] SQLite DB: ${dbPath}`);
    if (adminToken) {
      console.log(`[agentic-git] Initial admin token: ${adminToken}`);
    }
  });
}
