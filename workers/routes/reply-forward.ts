// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Context } from "hono";
import { sendEmail } from "../email-sender";
import { storeAttachments } from "../lib/attachments";
import {
	validateSender,
	SenderValidationError,
	generateMessageId,
	buildReferencesChain,
	buildThreadingHeaders,
	resolveOriginalEmail,
} from "../lib/email-helpers";
import { SendEmailRequestSchema } from "../lib/schemas";
import { Folders } from "../../shared/folders";
import type { AuthContext } from "../auth/middleware";

type AppContext = Context<AuthContext>;

export async function handleReplyEmail(c: AppContext) {
	const mailboxId = c.req.param("mailboxId") ?? "";
	const id = c.req.param("id") ?? "";
	const body = SendEmailRequestSchema.parse(await c.req.json());
	const { to, cc, bcc, from, subject, html, text, attachments } = body;

	const mailboxService = c.var.mailboxService;
	const rawOriginal = await mailboxService.getEmail(mailboxId, id);

	if (!rawOriginal) {
		return c.json({ error: "Original email not found" }, 404);
	}

	const originalEmail = await resolveOriginalEmail(mailboxService, mailboxId, rawOriginal);
	const { originalMsgId, references, threadId: thread_id } = buildReferencesChain(originalEmail);

	let toStr: string, fromEmail: string, fromDomain: string;
	try {
		({ toStr, fromEmail, fromDomain } = validateSender(to, from, mailboxId));
	} catch (e) {
		if (e instanceof SenderValidationError) return c.json({ error: e.message }, 400);
		throw e;
	}

	const { messageId, outgoingMessageId } = generateMessageId(fromDomain);

	const rateLimitError = await mailboxService.checkSendRateLimit(mailboxId);
	if (rateLimitError) {
		return c.json({ error: rateLimitError }, 429);
	}

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
			in_reply_to: originalMsgId,
			email_references: JSON.stringify(references),
			thread_id: thread_id,
			message_id: outgoingMessageId,
			raw_headers: JSON.stringify([
				{ key: "from", value: typeof from === "string" ? from : `${from.name} <${from.email}>` },
				{ key: "to", value: Array.isArray(to) ? to.join(", ") : to },
				...(cc ? [{ key: "cc", value: Array.isArray(cc) ? cc.join(", ") : cc }] : []),
				...(bcc ? [{ key: "bcc", value: Array.isArray(bcc) ? bcc.join(", ") : bcc }] : []),
				{ key: "subject", value: subject },
				{ key: "date", value: new Date().toISOString() },
				{ key: "message-id", value: `<${outgoingMessageId}>` },
				...(originalMsgId ? [{ key: "in-reply-to", value: `<${originalMsgId}>` }] : []),
				...(references.length > 0 ? [{ key: "references", value: references.map((r: string) => `<${r}>`).join(" ") }] : []),
			]),
		},
		attachmentData,
	);

	await mailboxService.markThreadRead(mailboxId, thread_id);

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
				disposition: att.disposition,
				contentId: att.contentId,
			})),
			headers: buildThreadingHeaders(originalMsgId, references),
		}).catch((e) => {
			console.error("Deferred reply delivery failed:", (e as Error).message);
		}),
	);

	return c.json({ id: messageId, status: "sent" }, 202);
}

export async function handleForwardEmail(c: AppContext) {
	const mailboxId = c.req.param("mailboxId") ?? "";
	const id = c.req.param("id") ?? "";
	const body = SendEmailRequestSchema.parse(await c.req.json());
	const { to, cc, bcc, from, subject, html, text, attachments } = body;

	const mailboxService = c.var.mailboxService;
	const rawOriginal = await mailboxService.getEmail(mailboxId, id);

	if (!rawOriginal) {
		return c.json({ error: "Original email not found" }, 404);
	}

	let toStr: string, fromEmail: string, fromDomain: string;
	try {
		({ toStr, fromEmail, fromDomain } = validateSender(to, from, mailboxId));
	} catch (e) {
		if (e instanceof SenderValidationError) return c.json({ error: e.message }, 400);
		throw e;
	}

	const { messageId, outgoingMessageId } = generateMessageId(fromDomain);

	const rateLimitError = await mailboxService.checkSendRateLimit(mailboxId);
	if (rateLimitError) {
		return c.json({ error: rateLimitError }, 429);
	}

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
			in_reply_to: null,
			email_references: null,
			thread_id: messageId,
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
				disposition: att.disposition,
				contentId: att.contentId,
			})),
		}).catch((e) => {
			console.error("Deferred forward delivery failed:", (e as Error).message);
		}),
	);

	return c.json({ id: messageId, status: "sent" }, 202);
}
