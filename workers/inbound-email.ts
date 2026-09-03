// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import PostalMime from "postal-mime";
import type { Env, UserRecord } from "./types";
import { D1MailboxService, type AttachmentData } from "./db/d1-queries";
import { Folders } from "../shared/folders";
import { runCustomAIAutoDraft } from "./lib/custom-ai";

// ── Anti-Spam & Storage Hard Limits ────────────────────────────────
const MAX_RAW_EMAIL_SIZE = 10 * 1024 * 1024; // 10MB max raw MIME size
const MAX_ATTACHMENT_SIZE = 5 * 1024 * 1024; // 5MB max per single attachment
const MAX_ATTACHMENTS_COUNT = 3; // Max 3 attachments per email stored to R2
const MAX_BODY_TEXT_LENGTH = 200 * 1024; // 200KB max body stored in D1
const MAX_EMAILS_PER_SENDER_HOURLY = 30; // Max 30 emails per sender/hour to prevent spam bombing

async function streamToArrayBuffer(stream: ReadableStream, streamSize: number) {
	if (streamSize > MAX_RAW_EMAIL_SIZE) {
		throw new Error(`Email too large: ${streamSize} bytes exceeds ${MAX_RAW_EMAIL_SIZE} byte limit`);
	}
	if (streamSize <= 0) throw new Error(`Invalid stream size: ${streamSize}`);

	const result = new Uint8Array(streamSize);
	let bytesRead = 0;
	const reader = stream.getReader();

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (bytesRead + value.length > streamSize) {
			reader.cancel();
			throw new Error("Stream exceeds declared size");
		}
		result.set(value, bytesRead);
		bytesRead += value.length;
	}
	return result;
}

/**
 * Checks if the email is an automated bulk/newsletter/system email that should skip AI processing.
 */
function isAutomatedOrBulkEmail(headers: any[] | Record<string, string> | undefined): boolean {
	if (!headers) return false;
	const headerList = Array.isArray(headers)
		? headers.map((h) => ({ key: (h.key || h.name || "").toLowerCase(), value: String(h.value || "").toLowerCase() }))
		: Object.entries(headers).map(([k, v]) => ({ key: k.toLowerCase(), value: String(v).toLowerCase() }));

	for (const h of headerList) {
		if (h.key === "list-unsubscribe") return true;
		if (h.key === "precedence" && (h.value.includes("bulk") || h.value.includes("junk") || h.value.includes("list"))) return true;
		if (h.key === "auto-submitted" && h.value !== "no") return true;
		if (h.key === "x-autoreply" || h.key === "x-autoresponder") return true;
	}
	return false;
}

export async function receiveEmail(
	event: { raw: ReadableStream; rawSize: number; to?: string; from?: string },
	env: Env,
	ctx: ExecutionContext,
) {
	// 1. Raw Payload Size Defense
	if (event.rawSize > MAX_RAW_EMAIL_SIZE) {
		console.warn(`[Inbound Anti-Spam] Dropped oversized email: ${event.rawSize} bytes > ${MAX_RAW_EMAIL_SIZE}`);
		return;
	}

	const rawEmail = await streamToArrayBuffer(event.raw, event.rawSize);
	const parsedEmail = await new PostalMime().parse(rawEmail);

	const mailboxService = new D1MailboxService(env.DB);

	const envelopeTo = event.to ? [event.to.toLowerCase()] : [];
	const allRecipients = (parsedEmail.to || []).map((t) => t.address?.toLowerCase()).filter(Boolean) as string[];
	const ccRecipients = (parsedEmail.cc || []).map((e) => e.address?.toLowerCase()).filter(Boolean) as string[];
	const bccRecipients = (parsedEmail.bcc || []).map((e) => e.address?.toLowerCase()).filter(Boolean) as string[];
	const candidateAddresses = [...new Set([...envelopeTo, ...allRecipients, ...ccRecipients, ...bccRecipients])];

	if (candidateAddresses.length === 0) {
		console.log("[Inbound Email] Dropped email: No valid recipient addresses found.");
		return;
	}

	// 2. Recipient Whitelist Matching (0-cost drop for unowned aliases)
	let matchedMailbox: { id: string; user_id: string } | null = null;
	for (const addr of candidateAddresses) {
		const found = await mailboxService.getMailbox(addr);
		if (found) {
			matchedMailbox = found;
			break;
		}
	}

	if (!matchedMailbox) {
		console.log(`[Inbound Anti-Spam] Dropped: No registered mailbox for recipients: ${candidateAddresses.join(", ")}`);
		return;
	}

	const mailboxId = matchedMailbox.id;
	const emailSender = (parsedEmail.from?.address || event.from || "").toLowerCase().trim();

	// 3. Sender Throttling / Rate-Limiting Protection
	if (emailSender) {
		const oneHourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
		const recentCountRes = await env.DB.prepare(
			"SELECT COUNT(*) as cnt FROM emails WHERE mailbox_id = ?1 AND sender = ?2 AND date > ?3",
		)
			.bind(mailboxId, emailSender, oneHourAgo)
			.first<{ cnt: number }>();

		const recentCount = recentCountRes?.cnt || 0;
		if (recentCount >= MAX_EMAILS_PER_SENDER_HOURLY) {
			console.warn(
				`[Inbound Anti-Spam] Throttled sender ${emailSender}: ${recentCount} emails received in the past hour (exceeds limit of ${MAX_EMAILS_PER_SENDER_HOURLY}).`,
			);
			return; // Drop email to prevent D1 / R2 flooding
		}
	}

	const messageId = crypto.randomUUID();

	// 4. Attachment Hard Quotas (Protect R2 Storage & Bandwidth)
	const attachmentData: AttachmentData[] = [];
	if (parsedEmail.attachments && parsedEmail.attachments.length > 0) {
		const eligibleAttachments = parsedEmail.attachments.slice(0, MAX_ATTACHMENTS_COUNT);

		for (const att of eligibleAttachments) {
			let bytes: Uint8Array;
			if (typeof att.content === "string") {
				const bin = atob(att.content);
				bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
			} else if (att.content instanceof Uint8Array) {
				bytes = att.content;
			} else {
				bytes = new Uint8Array(att.content);
			}

			// Drop oversized single attachment
			if (bytes.byteLength > MAX_ATTACHMENT_SIZE) {
				console.warn(
					`[Inbound Anti-Spam] Skipped oversized attachment "${att.filename}": ${bytes.byteLength} bytes > ${MAX_ATTACHMENT_SIZE}`,
				);
				continue;
			}

			const attId = crypto.randomUUID();
			const safeFilename = (att.filename || "untitled").replace(/[\/\\:*?"<>|\x00-\x1f]/g, "_");
			const storageKey = `attachments/${messageId}/${attId}/${safeFilename}`;

			await env.BUCKET.put(storageKey, bytes);
			attachmentData.push({
				id: attId,
				email_id: messageId,
				filename: safeFilename,
				mimetype: att.mimeType,
				size: bytes.byteLength,
				content_id: att.contentId || null,
				disposition: att.disposition || "attachment",
				storage_key: storageKey,
			});
		}
	}

	// 5. Threading calculation
	const extractMsgId = (s: string) => {
		const m = s.match(/<([^>]+)>/);
		return m ? m[1] : s.trim().split(/\s+/)[0];
	};
	const inReplyTo = parsedEmail.inReplyTo ? extractMsgId(parsedEmail.inReplyTo) : null;
	const emailReferences = parsedEmail.references ? parsedEmail.references.split(/\s+/).filter(Boolean).map(extractMsgId) : [];
	let threadId = emailReferences[0] || inReplyTo || messageId;

	if (!inReplyTo && emailReferences.length === 0) {
		const subjectThread = await mailboxService.findThreadBySubject(
			mailboxId,
			parsedEmail.subject || "",
			parsedEmail.from?.address || undefined,
		);
		if (subjectThread) threadId = subjectThread;
	}

	const originalMessageId = parsedEmail.messageId ? extractMsgId(parsedEmail.messageId) : null;
	const displayRecipient = allRecipients.length > 0 ? allRecipients.join(", ") : (event.to || mailboxId);

	// 6. Body Text Storage Cap (Truncate if excessively huge)
	let rawBody = parsedEmail.html || parsedEmail.text || "";
	if (rawBody.length > MAX_BODY_TEXT_LENGTH) {
		rawBody = rawBody.substring(0, MAX_BODY_TEXT_LENGTH) + "\n\n[... Email body truncated to 200KB for storage safety ...]";
	}

	// Store in D1
	await mailboxService.createEmail(
		mailboxId,
		Folders.INBOX,
		{
			id: messageId,
			subject: (parsedEmail.subject || "").substring(0, 500),
			sender: emailSender,
			recipient: displayRecipient,
			cc: ccRecipients.join(", ") || null,
			bcc: bccRecipients.join(", ") || null,
			date: new Date().toISOString(),
			body: rawBody,
			in_reply_to: inReplyTo,
			email_references: emailReferences.length > 0 ? JSON.stringify(emailReferences) : null,
			thread_id: threadId,
			message_id: originalMessageId,
			raw_headers: JSON.stringify(parsedEmail.headers),
		},
		attachmentData,
	);

	console.log(`[Inbound Email] Successfully saved email ${messageId} for mailbox ${mailboxId}`);

	// 7. Smart AI Circuit Breaker (Skip newsletters, bulk auto-replies, and check daily budget)
	const isBulk = isAutomatedOrBulkEmail(parsedEmail.headers);
	if (isBulk) {
		console.log(`[Auto-Draft] Skipped AI draft for automated/bulk newsletter email from ${emailSender}`);
		return;
	}

	const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?1").bind(matchedMailbox.user_id).first<UserRecord>();
	if (user && user.custom_ai_endpoint) {
		ctx.waitUntil(
			runCustomAIAutoDraft(
				user,
				mailboxId,
				{
					id: messageId,
					sender: emailSender,
					subject: parsedEmail.subject || "",
					body: rawBody,
					threadId,
				},
				mailboxService,
			).catch((err) => console.error("Auto-draft error:", err)),
		);
	}
}
