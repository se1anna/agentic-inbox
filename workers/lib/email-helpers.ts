// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Shared email helpers to eliminate duplication across API routes, MCP, and agent.
 *
 * Includes: sender validation, message-ID generation,
 * threading, HTML utilities, and D1 email/thread fetching.
 */
import type { D1MailboxService } from "../db/d1-queries";
import type { EmailFull } from "./schemas";
import { Folders } from "../../shared/folders";
import { formatQuotedDate } from "../../shared/dates";

// ── Sender Validation ──────────────────────────────────────────────

/**
 * Normalise to/from addresses and validate the sender matches the mailbox.
 * Returns the normalised values or throws with a user-facing message.
 */
export function validateSender(
	to: string | string[],
	from: string | { email: string; name: string },
	mailboxId: string,
): { toStr: string; fromEmail: string; fromDomain: string } {
	const toStr = (Array.isArray(to) ? to.join(", ") : to).toLowerCase();
	const fromEmail = (typeof from === "string" ? from : from.email).toLowerCase();

	if (fromEmail !== mailboxId.toLowerCase()) {
		throw new SenderValidationError("From address must match the mailbox email address");
	}

	const fromDomain = fromEmail.split("@")[1];
	if (!fromDomain) {
		throw new SenderValidationError("Invalid sender email address");
	}

	return { toStr, fromEmail, fromDomain };
}

export class SenderValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SenderValidationError";
	}
}

// ── Message ID ─────────────────────────────────────────────────────

/**
 * Generate an internal UUID and a proper RFC 2822 Message-ID.
 */
export function generateMessageId(fromDomain: string): {
	messageId: string;
	outgoingMessageId: string;
} {
	const messageId = crypto.randomUUID();
	const outgoingMessageId = `${messageId}@${fromDomain}`;
	return { messageId, outgoingMessageId };
}

// ── Threading ──────────────────────────────────────────────────────

/**
 * Build the References chain and In-Reply-To from an original email.
 */
export function buildReferencesChain(original: EmailFull | any): {
	originalMsgId: string;
	references: string[];
	threadId: string;
} {
	const originalMsgId = original.message_id || original.id;
	let existingRefs: string[] = [];
	if (original.email_references) {
		try {
			existingRefs = JSON.parse(original.email_references);
		} catch {
			// Malformed JSON in email_references — treat as empty
		}
	}
	const references = [...existingRefs, originalMsgId].filter(Boolean);
	const threadId = original.thread_id || original.id;
	return { originalMsgId, references, threadId };
}

/**
 * Build threading headers (In-Reply-To + References) for the email binding.
 */
export function buildThreadingHeaders(
	originalMsgId: string,
	references: string[],
): Record<string, string> {
	return {
		"In-Reply-To": `<${originalMsgId}>`,
		...(references.length > 0
			? { References: references.map((r) => `<${r}>`).join(" ") }
			: {}),
	};
}

// ── Draft-follows-in_reply_to ──────────────────────────────────────

/**
 * If the given email is a draft with an in_reply_to, resolve the real original.
 * Used by reply/forward routes to avoid threading against the draft itself.
 */
export async function resolveOriginalEmail(
	mailboxService: D1MailboxService,
	mailboxId: string,
	email: EmailFull | any,
): Promise<EmailFull | any> {
	if ((email.folder_id === Folders.DRAFT || email.folder_id === "draft") && email.in_reply_to) {
		const realOriginal = await mailboxService.getEmail(mailboxId, email.in_reply_to);
		if (realOriginal) return realOriginal;
	}
	return email;
}

// ── HTML Utilities ─────────────────────────────────────────────────

/**
 * Escape all five OWASP-recommended HTML special characters in plain text.
 * Safe for use in both text content and attribute contexts.
 */
export function escapeHtml(text: string): string {
	if (!text) return "";
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/**
 * Convert plain text to a simple HTML block with preserved whitespace.
 */
export function textToHtml(text: string): string {
	if (!text) return "";
	const escaped = escapeHtml(text).replace(/\n/g, "<br>");
	return `<div style="white-space:pre-wrap">${escaped}</div>`;
}

/**
 * Strip HTML tags and normalize whitespace to produce plain text.
 * Removes <style> and <script> blocks first to avoid injecting their
 * content into the output.
 */
export function stripHtmlToText(html: string): string {
	if (!html) return "";
	return html
		.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
		.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

export const formatEmailDate = formatQuotedDate;

/**
 * Build a quoted reply block HTML string from original email data.
 */
export function buildQuotedReplyBlock(original: {
	date?: string;
	sender?: string;
	body?: string;
}): string {
	if (!original.body) return "";
	
	// HTML-escape sender and date to prevent injection
	const originalSender = escapeHtml(original.sender || "unknown");
	const originalDate = escapeHtml(formatEmailDate(original.date || ""));

	const plainBody = stripHtmlToText(original.body);
	const bodyToQuote = escapeHtml(plainBody).replace(/\n/g, "<br>");

	return `<br><blockquote style="border-left: 2px solid #ccc; margin: 0; padding-left: 1em; color: #666;">On ${originalDate}, ${originalSender} wrote:<br><br>${bodyToQuote}</blockquote>`;
}

// ── D1 Email and Thread Helpers ────────────────────────────────────

export async function getFullEmail(
	mailboxService: D1MailboxService,
	mailboxId: string,
	emailId: string,
) {
	const email = await mailboxService.getEmail(mailboxId, emailId);
	if (!email) return null;

	const textBody = email.body ? stripHtmlToText(email.body) : "";
	return { ...email, body_text: textBody, body_html: email.body };
}

export async function getFullThread(
	mailboxService: D1MailboxService,
	mailboxId: string,
	threadId: string,
) {
	const emails = await mailboxService.getThreadEmails(mailboxId, threadId);
	const enriched = emails.map((email) => {
		const textBody = email.body ? stripHtmlToText(email.body) : "";
		return { ...email, body_text: textBody };
	});

	enriched.sort(
		(a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
	);

	return { thread_id: threadId, message_count: enriched.length, messages: enriched };
}
