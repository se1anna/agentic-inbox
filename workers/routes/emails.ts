// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Hono } from "hono";
import { z } from "zod";
import type { AuthContext } from "../auth/middleware";
import { requireUserMailbox } from "../auth/middleware";
import { sendEmail } from "../email-sender";
import { storeAttachments } from "../lib/attachments";
import {
	validateSender,
	SenderValidationError,
	generateMessageId,
	buildThreadingHeaders,
} from "../lib/email-helpers";
import { SendEmailRequestSchema } from "../lib/schemas";
import { Folders } from "../../shared/folders";
import { handleReplyEmail, handleForwardEmail } from "./reply-forward";

const emailRouter = new Hono<AuthContext>();

const DraftBody = z.object({
	to: z.string().optional(),
	cc: z.string().optional(),
	bcc: z.string().optional(),
	subject: z.string().optional(),
	body: z.string(),
	in_reply_to: z.string().optional(),
	thread_id: z.string().optional(),
	draft_id: z.string().optional(),
});

function slugify(text: string) {
	return text
		.toString()
		.toLowerCase()
		.replace(/\s+/g, "-")
		.replace(/[^\w-]+/g, "")
		.replace(/--+/g, "-")
		.replace(/^-+/, "")
		.replace(/-+$/, "");
}

function intQuery(val: string | undefined): number | undefined {
	if (!val) return undefined;
	const n = Number(val);
	return Number.isNaN(n) ? undefined : n;
}

function boolQuery(val: string | undefined): boolean | undefined {
	if (val === undefined || val === "") return undefined;
	return val === "true" || val === "1";
}

// Apply user mailbox authorization to all routes in this router
emailRouter.use("/:mailboxId/*", requireUserMailbox);

// ── GET /api/v1/mailboxes/:mailboxId/emails ────────────────────────
emailRouter.get("/:mailboxId/emails", async (c) => {
	const mailboxId = c.req.param("mailboxId").toLowerCase();
	const mailboxService = c.var.mailboxService;

	const folder = c.req.query("folder");
	const thread_id = c.req.query("thread_id");
	const threaded = boolQuery(c.req.query("threaded"));
	const page = intQuery(c.req.query("page"));
	const limit = intQuery(c.req.query("limit"));
	const sortColumn = c.req.query("sortColumn");
	const sortDirection = c.req.query("sortDirection") as "ASC" | "DESC" | undefined;

	if (threaded && folder) {
		const emails = await mailboxService.getThreadedEmails(mailboxId, { folder, page, limit });
		const totalCount = await mailboxService.countThreadedEmails(mailboxId, folder);
		return c.json({ emails, totalCount });
	}

	const emails = await mailboxService.getEmails(mailboxId, {
		folder,
		thread_id,
		page,
		limit,
		sortColumn,
		sortDirection,
	});

	if (folder) {
		const totalCount = await mailboxService.countEmails(mailboxId, { folder, thread_id });
		return c.json({ emails, totalCount });
	}
	return c.json(emails);
});

// ── POST /api/v1/mailboxes/:mailboxId/emails ───────────────────────
emailRouter.post("/:mailboxId/emails", async (c) => {
	const mailboxId = c.req.param("mailboxId").toLowerCase();
	const mailboxService = c.var.mailboxService;
	const body = SendEmailRequestSchema.parse(await c.req.json());
	const { to, cc, bcc, from, subject, html, text, attachments, in_reply_to, references, thread_id } = body;

	let toStr: string, fromEmail: string, fromDomain: string;
	try {
		({ toStr, fromEmail, fromDomain } = validateSender(to, from, mailboxId));
	} catch (e) {
		if (e instanceof SenderValidationError) return c.json({ error: e.message }, 400);
		throw e;
	}

	const { messageId, outgoingMessageId } = generateMessageId(fromDomain);
	const rateLimitError = await mailboxService.checkSendRateLimit(mailboxId);
	if (rateLimitError) return c.json({ error: rateLimitError }, 429);

	const attachmentData = await storeAttachments(c.env.BUCKET, messageId, attachments);

	await mailboxService.createEmail(
		mailboxId,
		Folders.SENT,
		{
			id: messageId,
			subject,
			sender: fromEmail,
			recipient: toStr,
			cc: cc ? (Array.isArray(cc) ? cc.join(", ") : cc).toLowerCase() : null,
			bcc: bcc ? (Array.isArray(bcc) ? bcc.join(", ") : bcc).toLowerCase() : null,
			date: new Date().toISOString(),
			body: html || text || "",
			in_reply_to: in_reply_to || null,
			email_references: references ? JSON.stringify(references) : null,
			thread_id: thread_id || in_reply_to || messageId,
			message_id: outgoingMessageId,
			raw_headers: JSON.stringify([
				{ key: "from", value: typeof from === "string" ? from : `${from.name} <${from.email}>` },
				{ key: "to", value: Array.isArray(to) ? to.join(", ") : to },
				...(cc ? [{ key: "cc", value: Array.isArray(cc) ? cc.join(", ") : cc }] : []),
				...(bcc ? [{ key: "bcc", value: Array.isArray(bcc) ? bcc.join(", ") : bcc }] : []),
				{ key: "subject", value: subject },
				{ key: "date", value: new Date().toISOString() },
				{ key: "message-id", value: `<${outgoingMessageId}>` },
			]),
		},
		attachmentData,
	);

	c.executionCtx.waitUntil(
		sendEmail(c.env.EMAIL, {
			to,
			cc,
			bcc,
			from,
			subject,
			html,
			text,
			attachments: attachments?.map((att) => ({
				content: att.content,
				filename: att.filename,
				type: att.type,
				disposition: att.disposition || "attachment",
				contentId: att.contentId,
			})),
			...(in_reply_to ? { headers: buildThreadingHeaders(in_reply_to, references || []) } : {}),
		}).catch((e) => console.error("Deferred email delivery failed:", (e as Error).message)),
	);

	return c.json({ id: messageId, status: "sent" }, 202);
});

// ── POST /api/v1/mailboxes/:mailboxId/drafts ───────────────────────
emailRouter.post("/:mailboxId/drafts", async (c) => {
	const mailboxId = c.req.param("mailboxId").toLowerCase();
	const mailboxService = c.var.mailboxService;
	const { to, cc, bcc, subject, body, in_reply_to, thread_id, draft_id } = DraftBody.parse(await c.req.json());

	if (draft_id) {
		await mailboxService.deleteEmail(mailboxId, draft_id);
	}

	const messageId = crypto.randomUUID();
	const now = new Date().toISOString();

	await mailboxService.createEmail(
		mailboxId,
		Folders.DRAFT,
		{
			id: messageId,
			subject: subject || "",
			sender: mailboxId.toLowerCase(),
			recipient: (to || "").toLowerCase(),
			cc: cc?.toLowerCase() || null,
			bcc: bcc?.toLowerCase() || null,
			date: now,
			body,
			in_reply_to: in_reply_to || null,
			email_references: null,
			thread_id: thread_id || in_reply_to || messageId,
		},
		[],
	);

	return c.json({ id: messageId, status: "draft", subject: subject || "", recipient: to || "", date: now }, 201);
});

// ── Single Email Operations ────────────────────────────────────────
emailRouter.get("/:mailboxId/emails/:id", async (c) => {
	const mailboxId = c.req.param("mailboxId").toLowerCase();
	const email = await c.var.mailboxService.getEmail(mailboxId, c.req.param("id"));
	if (!email) return c.json({ error: "Email not found" }, 404);
	return c.json(email);
});

emailRouter.put("/:mailboxId/emails/:id", async (c) => {
	const mailboxId = c.req.param("mailboxId").toLowerCase();
	const { read, starred } = (await c.req.json()) as { read?: boolean; starred?: boolean };
	const email = await c.var.mailboxService.updateEmail(mailboxId, c.req.param("id"), { read, starred });
	return email ? c.json(email) : c.json({ error: "Email not found" }, 404);
});

emailRouter.delete("/:mailboxId/emails/:id", async (c) => {
	const mailboxId = c.req.param("mailboxId").toLowerCase();
	const id = c.req.param("id");
	const attachments = await c.var.mailboxService.deleteEmail(mailboxId, id);
	if (attachments === null) return c.json({ error: "Not found" }, 404);

	if (attachments.length > 0) {
		await c.env.BUCKET.delete(attachments.map((att) => att.storage_key));
	}
	return c.body(null, 204);
});

emailRouter.post("/:mailboxId/emails/:id/move", async (c) => {
	const mailboxId = c.req.param("mailboxId").toLowerCase();
	const { folderId } = (await c.req.json()) as { folderId: string };
	const success = await c.var.mailboxService.moveEmail(mailboxId, c.req.param("id"), folderId);
	return success ? c.json({ status: "moved" }) : c.json({ error: "Folder not found" }, 400);
});

// ── Threads ────────────────────────────────────────────────────────
emailRouter.get("/:mailboxId/threads/:threadId", async (c) => {
	const mailboxId = c.req.param("mailboxId").toLowerCase();
	return c.json(await c.var.mailboxService.getThreadEmails(mailboxId, c.req.param("threadId")));
});

emailRouter.post("/:mailboxId/threads/:threadId/read", async (c) => {
	const mailboxId = c.req.param("mailboxId").toLowerCase();
	await c.var.mailboxService.markThreadRead(mailboxId, c.req.param("threadId"));
	return c.json({ status: "marked_read" });
});

// ── Reply & Forward ────────────────────────────────────────────────
emailRouter.post("/:mailboxId/emails/:id/reply", handleReplyEmail);
emailRouter.post("/:mailboxId/emails/:id/forward", handleForwardEmail);

// ── Folders ────────────────────────────────────────────────────────
emailRouter.get("/:mailboxId/folders", async (c) => {
	const mailboxId = c.req.param("mailboxId").toLowerCase();
	return c.json(await c.var.mailboxService.getFolders(mailboxId));
});

emailRouter.post("/:mailboxId/folders", async (c) => {
	const mailboxId = c.req.param("mailboxId").toLowerCase();
	const { name } = (await c.req.json()) as { name: string };
	const slug = slugify(name);
	if (!slug) return c.json({ error: "Folder name must contain alphanumeric characters" }, 400);
	const f = await c.var.mailboxService.createFolder(mailboxId, slug, name);
	return f ? c.json(f, 201) : c.json({ error: "Folder with this name already exists" }, 409);
});

emailRouter.put("/:mailboxId/folders/:id", async (c) => {
	const mailboxId = c.req.param("mailboxId").toLowerCase();
	const { name } = (await c.req.json()) as { name: string };
	const f = await c.var.mailboxService.updateFolder(mailboxId, c.req.param("id"), name);
	return f ? c.json(f) : c.json({ error: "Folder not found" }, 404);
});

emailRouter.delete("/:mailboxId/folders/:id", async (c) => {
	const mailboxId = c.req.param("mailboxId").toLowerCase();
	const ok = await c.var.mailboxService.deleteFolder(mailboxId, c.req.param("id"));
	return ok ? c.body(null, 204) : c.json({ error: "Folder not found or cannot be deleted" }, 400);
});

// ── Search ─────────────────────────────────────────────────────────
emailRouter.get("/:mailboxId/search", async (c) => {
	const mailboxId = c.req.param("mailboxId").toLowerCase();
	const searchOpts = {
		query: c.req.query("query") || "",
		folder: c.req.query("folder"),
		from: c.req.query("from"),
		to: c.req.query("to"),
		subject: c.req.query("subject"),
		date_start: c.req.query("date_start"),
		date_end: c.req.query("date_end"),
		is_read: boolQuery(c.req.query("is_read")),
		is_starred: boolQuery(c.req.query("is_starred")),
		has_attachment: boolQuery(c.req.query("has_attachment")),
		page: intQuery(c.req.query("page")),
		limit: intQuery(c.req.query("limit")),
	};

	const emails = await c.var.mailboxService.searchEmails(mailboxId, searchOpts);
	const totalCount = await c.var.mailboxService.countSearchResults(mailboxId, searchOpts);
	return c.json({ emails, totalCount });
});

// ── Attachments ────────────────────────────────────────────────────
emailRouter.get("/:mailboxId/emails/:emailId/attachments/:attachmentId", async (c) => {
	const mailboxId = c.req.param("mailboxId").toLowerCase();
	const attachmentId = c.req.param("attachmentId");

	const attachment = await c.var.mailboxService.getAttachment(mailboxId, attachmentId);
	if (!attachment) return c.json({ error: "Attachment not found" }, 404);

	const obj = await c.env.BUCKET.get(attachment.storage_key);
	if (!obj) return c.json({ error: "Attachment file not found in storage" }, 404);

	const headers = new Headers();
	headers.set("Content-Type", attachment.mimetype);
	const sanitized = attachment.filename.replace(/[\x00-\x1f"\\]/g, "_");
	headers.set(
		"Content-Disposition",
		`attachment; filename="${sanitized}"; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`,
	);
	return new Response(obj.body, { headers });
});

export { emailRouter };
