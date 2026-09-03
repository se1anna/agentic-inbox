// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types";
import { requireAdminAuth, type AuthContext } from "./auth/middleware";
import { authRouter } from "./routes/auth";
import { userRouter } from "./routes/user";
import { mailboxRouter } from "./routes/mailboxes";
import { emailRouter } from "./routes/emails";
import { agentRouter } from "./routes/agent";
import { receiveEmail } from "./inbound-email";

const apiApp = new Hono<AuthContext>();

// Global Error Handler
apiApp.onError((err, c) => {
	console.error("[API Unhandled Error]:", err.message, err.stack);
	return c.json({ error: err.message || "Internal Server Error" }, 500);
});

// CORS configuration
apiApp.use(
	"/api/*",
	cors({
		origin: (origin) => {
			if (!origin) return origin;
			try {
				const url = new URL(origin);
				if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return origin;
			} catch {}
			return undefined;
		},
		credentials: true,
	}),
);

// ── Public Config Endpoint ─────────────────────────────────────────
apiApp.get("/api/v1/config", (c) => {
	const domainsRaw = c.env.DOMAINS || "";
	const domains = domainsRaw
		.split(",")
		.map((d) => d.trim())
		.filter(Boolean);
	const emailAddresses = c.env.EMAIL_ADDRESSES ?? [];
	return c.json({ domains, emailAddresses });
});

// ── Public & Protected Auth Routes ─────────────────────────────────
apiApp.route("/api/v1/auth", authRouter);

// ── Protected API Routes (Mandatory Admin Auth) ─────────────────────
apiApp.use("/api/v1/user/*", requireAdminAuth);
apiApp.route("/api/v1/user", userRouter);

apiApp.use("/api/v1/mailboxes/*", requireAdminAuth);
apiApp.use("/api/v1/mailboxes", requireAdminAuth);
apiApp.route("/api/v1/mailboxes", mailboxRouter);
apiApp.route("/api/v1/mailboxes", emailRouter);
apiApp.route("/api/v1/mailboxes", agentRouter);

export { apiApp, receiveEmail };
