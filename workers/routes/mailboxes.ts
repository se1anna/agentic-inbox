// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Hono } from "hono";
import { z } from "zod";
import type { AuthContext } from "../auth/middleware";
import { requireAdminAuth, requireUserMailbox } from "../auth/middleware";

const mailboxRouter = new Hono<AuthContext>();

// Enforce Admin Auth on all mailbox routes
mailboxRouter.use("*", requireAdminAuth);

const CreateMailboxSchema = z.object({
	email: z.string().email(),
	name: z.string().optional(),
	settings: z.record(z.any()).optional(),
});

// ── GET /api/v1/mailboxes ──────────────────────────────────────────
mailboxRouter.get("/", async (c) => {
	try {
		const user = c.var.user;
		const mailboxService = c.var.mailboxService;
		const userMailboxes = await mailboxService.listMailboxesByUser(user.id);

		return c.json(
			userMailboxes.map((m) => ({
				id: m.id,
				email: m.id,
				name: m.name,
				isDefault: m.is_default === 1,
				settings: m.settings ? JSON.parse(m.settings) : {},
			})),
		);
	} catch (err: any) {
		console.error("[GET /api/v1/mailboxes error]:", err);
		return c.json({ error: err?.message || "Failed to list mailboxes" }, 500);
	}
});

// ── POST /api/v1/mailboxes ─────────────────────────────────────────
mailboxRouter.post("/", async (c) => {
	try {
		const user = c.var.user;
		const mailboxService = c.var.mailboxService;

		let body: any;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON payload" }, 400);
		}

		const parsed = CreateMailboxSchema.safeParse(body);
		if (!parsed.success) {
			return c.json({ error: "Invalid mailbox creation request", details: parsed.error.format() }, 400);
		}

		const { email: rawEmail, name: inputName, settings } = parsed.data;
		const email = rawEmail.toLowerCase().trim();
		const name = (inputName || "").trim() || email.split("@")[0];

		// Check domain against configured domains
		const domainsRaw = c.env.DOMAINS || "";
		const allowedDomains = domainsRaw
			.split(",")
			.map((d) => d.trim().toLowerCase())
			.filter(Boolean);

		const emailDomain = email.split("@")[1];
		if (allowedDomains.length > 0 && (!emailDomain || !allowedDomains.includes(emailDomain))) {
			return c.json(
				{
					error: `Domain "${emailDomain}" is not permitted. Allowed domains: ${allowedDomains.join(", ")}`,
				},
				400,
			);
		}

		// Attempt to create mailbox (Anti-hijacking check included inside service)
		const result = await mailboxService.createMailbox(user.id, email, name, settings, 0);
		if (!result.success) {
			return c.json({ error: result.error }, result.status as any);
		}

		const m = result.mailbox;
		return c.json(
			{
				id: m.id,
				email: m.id,
				name: m.name,
				isDefault: m.is_default === 1,
				settings: m.settings ? JSON.parse(m.settings) : {},
			},
			201,
		);
	} catch (err: any) {
		console.error("[POST /api/v1/mailboxes error]:", err);
		return c.json({ error: err?.message || "Failed to create mailbox alias" }, 500);
	}
});

// ── GET /api/v1/mailboxes/:mailboxId ───────────────────────────────
mailboxRouter.get("/:mailboxId", requireUserMailbox, async (c) => {
	const mailbox = c.var.mailbox!;
	return c.json({
		id: mailbox.id,
		email: mailbox.id,
		name: mailbox.name,
		isDefault: mailbox.is_default === 1,
		settings: mailbox.settings ? JSON.parse(mailbox.settings) : {},
	});
});

// ── PUT /api/v1/mailboxes/:mailboxId ───────────────────────────────
mailboxRouter.put("/:mailboxId", requireUserMailbox, async (c) => {
	try {
		const user = c.var.user;
		const mailboxId = c.req.param("mailboxId").toLowerCase();
		const mailboxService = c.var.mailboxService;
		const body = (await c.req.json()) as { name?: string; settings?: Record<string, unknown> };

		const updated = await mailboxService.updateMailbox(mailboxId, user.id, {
			name: body.name,
			settings: body.settings,
		});

		if (!updated) {
			return c.json({ error: "Failed to update mailbox" }, 404);
		}

		return c.json({
			id: updated.id,
			email: updated.id,
			name: updated.name,
			isDefault: updated.is_default === 1,
			settings: updated.settings ? JSON.parse(updated.settings) : {},
		});
	} catch (err: any) {
		console.error("[PUT /api/v1/mailboxes/:id error]:", err);
		return c.json({ error: err?.message || "Failed to update mailbox" }, 500);
	}
});

// ── DELETE /api/v1/mailboxes/:mailboxId ────────────────────────────
mailboxRouter.delete("/:mailboxId", requireUserMailbox, async (c) => {
	try {
		const user = c.var.user;
		const mailboxId = c.req.param("mailboxId").toLowerCase();
		const mailboxService = c.var.mailboxService;

		// Delete from D1 (cascading deletes folders, emails, attachments records)
		const ok = await mailboxService.deleteMailbox(mailboxId, user.id);
		if (!ok) {
			return c.json({ error: "Failed to delete mailbox" }, 404);
		}

		return c.body(null, 204);
	} catch (err: any) {
		console.error("[DELETE /api/v1/mailboxes/:id error]:", err);
		return c.json({ error: err?.message || "Failed to delete mailbox" }, 500);
	}
});

export { mailboxRouter };
