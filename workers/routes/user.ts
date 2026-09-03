// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Hono } from "hono";
import { z } from "zod";
import type { AuthContext } from "../auth/middleware";
import { requireAdminAuth } from "../auth/middleware";
import { testCustomAIConnection } from "../lib/custom-ai";

const userRouter = new Hono<AuthContext>();

// Enforce Admin Auth on all user settings routes
userRouter.use("*", requireAdminAuth);

const AISettingsSchema = z.object({
	endpoint: z.string().url().or(z.string().min(1)),
	apiKey: z.string().optional(),
	model: z.string().min(1).default("gpt-4o-mini"),
});

const AITestSchema = z.object({
	endpoint: z.string().url().or(z.string().min(1)),
	apiKey: z.string().optional(),
	model: z.string().min(1).default("gpt-4o-mini"),
});

// ── GET /api/v1/user/settings ──────────────────────────────────────
userRouter.get("/settings", async (c) => {
	const user = c.var.user;
	if (!user) return c.json({ error: "Unauthorized" }, 401);

	// Mask API key for security
	let maskedKey = "";
	if (user.custom_ai_key && user.custom_ai_key.length > 8) {
		maskedKey = `${user.custom_ai_key.substring(0, 4)}...${user.custom_ai_key.substring(user.custom_ai_key.length - 4)}`;
	} else if (user.custom_ai_key) {
		maskedKey = "••••••••";
	}

	return c.json({
		user: {
			id: user.id,
			email: user.email,
			name: user.name,
			role: user.role,
		},
		ai: {
			endpoint: user.custom_ai_endpoint || "",
			model: user.custom_ai_model || "gpt-4o-mini",
			hasKey: !!user.custom_ai_key,
			maskedKey,
		},
	});
});

// ── PUT /api/v1/user/ai-settings ───────────────────────────────────
userRouter.put("/ai-settings", async (c) => {
	const user = c.var.user;
	if (!user) return c.json({ error: "Unauthorized" }, 401);

	const body = await c.req.json();
	const parsed = AISettingsSchema.safeParse(body);
	if (!parsed.success) {
		return c.json({ error: "Invalid AI settings payload", details: parsed.error.format() }, 400);
	}

	const { endpoint, apiKey, model } = parsed.data;
	const now = new Date().toISOString();

	// Keep existing key if not supplied or empty
	const keyToSave = apiKey !== undefined && apiKey.trim() !== "" ? apiKey.trim() : (user.custom_ai_key || null);

	await c.env.DB
		.prepare(
			`UPDATE users
			 SET custom_ai_endpoint = ?1,
			     custom_ai_key = ?2,
			     custom_ai_model = ?3,
			     updated_at = ?4
			 WHERE id = ?5`,
		)
		.bind(endpoint.trim(), keyToSave, model.trim(), now, user.id)
		.run();

	return c.json({
		success: true,
		message: "AI provider settings saved successfully",
		ai: {
			endpoint: endpoint.trim(),
			model: model.trim(),
			hasKey: !!keyToSave,
		},
	});
});

// ── POST /api/v1/user/ai-test ──────────────────────────────────────
userRouter.post("/ai-test", async (c) => {
	const user = c.var.user;
	const body = await c.req.json().catch(() => ({}));
	const parsed = AITestSchema.safeParse(body);

	let endpoint = user?.custom_ai_endpoint || "";
	let apiKey = user?.custom_ai_key || "";
	let model = user?.custom_ai_model || "gpt-4o-mini";

	if (parsed.success) {
		endpoint = parsed.data.endpoint;
		if (parsed.data.apiKey) apiKey = parsed.data.apiKey;
		model = parsed.data.model;
	}

	if (!endpoint) {
		return c.json({ success: false, message: "Please enter an AI endpoint URL first." }, 400);
	}

	const result = await testCustomAIConnection(endpoint, apiKey, model);
	return c.json(result);
});

export { userRouter };
