// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Folders } from "../../shared/folders";
import type { Env, EmailRecord, FolderRecord, MailboxRecord, AttachmentRecord } from "../types";

export interface EmailData {
	id: string;
	subject: string;
	sender: string;
	recipient: string;
	cc?: string | null;
	bcc?: string | null;
	date: string;
	body: string;
	read?: boolean;
	starred?: boolean;
	in_reply_to?: string | null;
	email_references?: string | null;
	thread_id?: string | null;
	message_id?: string | null;
	raw_headers?: string | null;
}

export interface AttachmentData {
	id: string;
	email_id: string;
	filename: string;
	mimetype: string;
	size: number;
	content_id?: string | null;
	disposition?: string | null;
	storage_key: string;
}

export interface GetEmailsOptions {
	folder?: string;
	thread_id?: string;
	page?: number;
	limit?: number;
	sortColumn?: string;
	sortDirection?: "ASC" | "DESC";
}

export interface SearchFilterOptions {
	query: string;
	folder?: string;
	from?: string;
	to?: string;
	subject?: string;
	date_start?: string;
	date_end?: string;
	is_read?: boolean;
	is_starred?: boolean;
	has_attachment?: boolean;
	page?: number;
	limit?: number;
}

const NORMALIZED_SUBJECT_SQL = `LOWER(TRIM(
	REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
		LOWER(subject),
		'aw: ', ''), 'wg: ', ''), 'réf: ', ''), 'sv: ', ''),
		're: ', ''), 'fwd: ', ''), 'fw: ', '')
))`;

export class D1MailboxService {
	constructor(private db: D1Database) {}

	// ── Mailbox Management & Anti-Hijacking ───────────────────────

	async getMailbox(mailboxId: string): Promise<MailboxRecord | null> {
		const res = await this.db
			.prepare("SELECT * FROM mailboxes WHERE id = ?1")
			.bind(mailboxId.toLowerCase())
			.first<MailboxRecord>();
		return res ?? null;
	}

	async listMailboxesByUser(userId: string): Promise<MailboxRecord[]> {
		const res = await this.db
			.prepare("SELECT * FROM mailboxes WHERE user_id = ?1 ORDER BY is_default DESC, created_at ASC")
			.bind(userId)
			.all<MailboxRecord>();
		return res.results ?? [];
	}

	async createMailbox(
		userId: string,
		email: string,
		name: string,
		settings?: Record<string, unknown>,
		isDefault = 0,
	): Promise<{ success: true; mailbox: MailboxRecord } | { success: false; error: string; status: number }> {
		const lowerEmail = email.toLowerCase().trim();

		// Anti-hijacking guarantee: Check if alias already exists across ANY user
		const existing = await this.getMailbox(lowerEmail);
		if (existing) {
			return {
				success: false,
				error: `Mailbox alias "${lowerEmail}" already exists and cannot be modified or claimed.`,
				status: 409,
			};
		}

		const now = new Date().toISOString();
		const defaultSettings = {
			fromName: name,
			forwarding: { enabled: false, email: "" },
			signature: { enabled: false, text: "" },
			autoReply: { enabled: false, subject: "", message: "" },
		};
		const mergedSettings = JSON.stringify({ ...defaultSettings, ...settings });

		await this.db
			.prepare(
				"INSERT INTO mailboxes (id, user_id, name, is_default, settings, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
			)
			.bind(lowerEmail, userId, name, isDefault ? 1 : 0, mergedSettings, now, now)
			.run();

		// Initialize standard folders for the mailbox
		await this.initDefaultFolders(lowerEmail);

		const created = await this.getMailbox(lowerEmail);
		return { success: true, mailbox: created! };
	}

	async updateMailbox(
		mailboxId: string,
		userId: string,
		updates: { name?: string; settings?: Record<string, unknown>; is_default?: number },
	): Promise<MailboxRecord | null> {
		const existing = await this.getMailbox(mailboxId);
		if (!existing || existing.user_id !== userId) return null;

		const now = new Date().toISOString();
		const name = updates.name ?? existing.name;
		const settings = updates.settings ? JSON.stringify(updates.settings) : existing.settings;
		const isDefault = updates.is_default !== undefined ? updates.is_default : existing.is_default;

		await this.db
			.prepare(
				"UPDATE mailboxes SET name = ?1, settings = ?2, is_default = ?3, updated_at = ?4 WHERE id = ?5 AND user_id = ?6",
			)
			.bind(name, settings, isDefault, now, mailboxId.toLowerCase(), userId)
			.run();

		return this.getMailbox(mailboxId);
	}

	async deleteMailbox(mailboxId: string, userId: string): Promise<boolean> {
		const existing = await this.getMailbox(mailboxId);
		if (!existing || existing.user_id !== userId) return false;

		await this.db
			.prepare("DELETE FROM mailboxes WHERE id = ?1 AND user_id = ?2")
			.bind(mailboxId.toLowerCase(), userId)
			.run();
		return true;
	}

	// ── Folders ────────────────────────────────────────────────────

	async initDefaultFolders(mailboxId: string) {
		const systemFolders = [
			{ slug: Folders.INBOX, name: "Inbox", is_deletable: 0 },
			{ slug: Folders.SENT, name: "Sent", is_deletable: 0 },
			{ slug: Folders.DRAFT, name: "Drafts", is_deletable: 0 },
			{ slug: Folders.ARCHIVE, name: "Archive", is_deletable: 0 },
			{ slug: Folders.TRASH, name: "Trash", is_deletable: 0 },
		];

		for (const f of systemFolders) {
			const folderId = `${mailboxId}:${f.slug}`;
			await this.db
				.prepare(
					"INSERT OR IGNORE INTO folders (id, mailbox_id, slug, name, is_deletable) VALUES (?1, ?2, ?3, ?4, ?5)",
				)
				.bind(folderId, mailboxId, f.slug, f.name, f.is_deletable)
				.run();
		}
	}

	async getFolders(mailboxId: string) {
		const query = `
			SELECT f.id, f.slug, f.name, f.is_deletable,
				COALESCE(SUM(CASE WHEN e.read = 0 THEN 1 ELSE 0 END), 0) as unreadCount
			FROM folders f
			LEFT JOIN emails e ON e.folder_id = f.id AND e.mailbox_id = f.mailbox_id
			WHERE f.mailbox_id = ?1
			GROUP BY f.id, f.slug, f.name, f.is_deletable
			ORDER BY 
				CASE f.slug 
					WHEN 'inbox' THEN 1 
					WHEN 'sent' THEN 2 
					WHEN 'draft' THEN 3 
					WHEN 'archive' THEN 4 
					WHEN 'trash' THEN 5 
					ELSE 6 
				END, f.name ASC
		`;
		const res = await this.db.prepare(query).bind(mailboxId).all<{
			id: string;
			slug: string;
			name: string;
			is_deletable: number;
			unreadCount: number;
		}>();
		return res.results.map((r) => ({
			id: r.slug, // Keep frontend compatibility using folder slug as ID
			fullId: r.id,
			name: r.name,
			unreadCount: Number(r.unreadCount || 0),
			is_deletable: r.is_deletable,
		}));
	}

	async getFolderBySlug(mailboxId: string, slug: string): Promise<FolderRecord | null> {
		const res = await this.db
			.prepare("SELECT * FROM folders WHERE mailbox_id = ?1 AND (slug = ?2 OR id = ?2) LIMIT 1")
			.bind(mailboxId, slug)
			.first<FolderRecord>();
		return res ?? null;
	}

	async createFolder(mailboxId: string, slug: string, name: string) {
		const folderId = `${mailboxId}:${slug}`;
		try {
			await this.db
				.prepare("INSERT INTO folders (id, mailbox_id, slug, name, is_deletable) VALUES (?1, ?2, ?3, ?4, 1)")
				.bind(folderId, mailboxId, slug, name)
				.run();
			return { id: slug, name, unreadCount: 0 };
		} catch (e: any) {
			if (e?.message?.includes("UNIQUE") || e?.message?.includes("constraint")) return null;
			throw e;
		}
	}

	async updateFolder(mailboxId: string, slug: string, name: string) {
		await this.db
			.prepare("UPDATE folders SET name = ?1 WHERE mailbox_id = ?2 AND slug = ?3")
			.bind(name, mailboxId, slug)
			.run();
		return { id: slug, name };
	}

	async deleteFolder(mailboxId: string, slug: string): Promise<boolean> {
		const folder = await this.getFolderBySlug(mailboxId, slug);
		if (!folder || folder.is_deletable === 0) return false;

		await this.db
			.prepare("DELETE FROM folders WHERE mailbox_id = ?1 AND slug = ?2")
			.bind(mailboxId, slug)
			.run();
		return true;
	}

	// ── Email Listing & Threading ──────────────────────────────────

	async getEmails(mailboxId: string, options: GetEmailsOptions = {}) {
		const { folder, thread_id, page = 1, limit: rawLimit = 25, sortColumn = "date", sortDirection = "DESC" } = options;
		const limit = Math.min(Math.max(rawLimit, 1), 100);
		const offset = (page - 1) * limit;

		let folderRecord: FolderRecord | null = null;
		if (folder) {
			folderRecord = await this.getFolderBySlug(mailboxId, folder);
			if (!folderRecord) return [];
		}

		const conditions: string[] = ["e.mailbox_id = ?1"];
		const params: (string | number)[] = [mailboxId];

		if (folderRecord) {
			params.push(folderRecord.id);
			conditions.push(`e.folder_id = ?${params.length}`);
		}
		if (thread_id) {
			params.push(thread_id);
			conditions.push(`e.thread_id = ?${params.length}`);
		}

		const allowedSorts = ["date", "subject", "sender", "recipient", "read", "starred"];
		const safeSort = allowedSorts.includes(sortColumn) ? sortColumn : "date";
		const safeDir = sortDirection === "ASC" ? "ASC" : "DESC";

		params.push(limit, offset);
		const query = `
			SELECT e.id, e.subject, e.sender, e.recipient, e.cc, e.bcc, e.date,
				e.read, e.starred, e.in_reply_to, e.email_references, e.thread_id,
				f.slug as folder_id,
				SUBSTR(e.body, 1, 300) as snippet
			FROM emails e
			LEFT JOIN folders f ON e.folder_id = f.id
			WHERE ${conditions.join(" AND ")}
			ORDER BY e.${safeSort} ${safeDir}
			LIMIT ?${params.length - 1} OFFSET ?${params.length}
		`;

		const res = await this.db.prepare(query).bind(...params).all<any>();
		return res.results.map((e) => ({
			...e,
			read: !!e.read,
			starred: !!e.starred,
		}));
	}

	async countEmails(mailboxId: string, options: { folder?: string; thread_id?: string } = {}) {
		const { folder, thread_id } = options;
		const conditions: string[] = ["mailbox_id = ?1"];
		const params: (string | number)[] = [mailboxId];

		if (folder) {
			const folderRecord = await this.getFolderBySlug(mailboxId, folder);
			if (!folderRecord) return 0;
			params.push(folderRecord.id);
			conditions.push(`folder_id = ?${params.length}`);
		}
		if (thread_id) {
			params.push(thread_id);
			conditions.push(`thread_id = ?${params.length}`);
		}

		const query = `SELECT COUNT(*) as total FROM emails WHERE ${conditions.join(" AND ")}`;
		const res = await this.db.prepare(query).bind(...params).first<{ total: number }>();
		return res?.total ?? 0;
	}

	async getThreadedEmails(mailboxId: string, options: GetEmailsOptions = {}) {
		const { folder, page = 1, limit: rawLimit = 25 } = options;
		if (!folder) return this.getEmails(mailboxId, options);

		const folderRecord = await this.getFolderBySlug(mailboxId, folder);
		if (!folderRecord) return [];

		const limit = Math.min(Math.max(rawLimit, 1), 100);
		const offset = (page - 1) * limit;
		const isDraftFolder = folder === Folders.DRAFT || folderRecord.slug === Folders.DRAFT;

		if (isDraftFolder) {
			const query = `
				WITH folder_emails AS (
					SELECT *, COALESCE(in_reply_to, id) as draft_group_key
					FROM emails
					WHERE mailbox_id = ?1 AND folder_id = ?2
				),
				draft_stats AS (
					SELECT draft_group_key, COUNT(*) as thread_count,
						SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END) as thread_unread_count,
						GROUP_CONCAT(DISTINCT sender) as participants
					FROM folder_emails
					GROUP BY draft_group_key
				),
				latest_per_group AS (
					SELECT fe.*, ROW_NUMBER() OVER (PARTITION BY fe.draft_group_key ORDER BY fe.date DESC) as rn
					FROM folder_emails fe
				)
				SELECT lp.id, lp.subject, lp.sender, lp.recipient, lp.date,
					lp.read, lp.starred, lp.thread_id, ?3 as folder_id,
					lp.in_reply_to, lp.email_references,
					SUBSTR(lp.body, 1, 300) as snippet,
					ds.thread_count, ds.thread_unread_count, ds.participants
				FROM latest_per_group lp
				JOIN draft_stats ds ON lp.draft_group_key = ds.draft_group_key
				WHERE lp.rn = 1
				ORDER BY lp.date DESC
				LIMIT ?4 OFFSET ?5
			`;
			const res = await this.db.prepare(query).bind(mailboxId, folderRecord.id, folderRecord.slug, limit, offset).all<any>();
			return res.results.map((r) => ({
				...r,
				read: !!r.read,
				starred: !!r.starred,
				thread_count: r.thread_count || 1,
				thread_unread_count: r.thread_unread_count || 0,
				participants: r.participants || r.sender,
			}));
		}

		// Non-draft folders
		const query = `
			WITH folder_emails AS (
				SELECT *, COALESCE(thread_id, id) as raw_thread_id,
					${NORMALIZED_SUBJECT_SQL} as normalized_subject
				FROM emails
				WHERE mailbox_id = ?1 AND folder_id = ?2
			),
			thread_to_conversation AS (
				SELECT raw_thread_id, normalized_subject,
					CASE WHEN thread_id IS NOT NULL THEN raw_thread_id
						ELSE MIN(raw_thread_id) OVER (PARTITION BY normalized_subject)
					END as conversation_id
				FROM folder_emails
				GROUP BY raw_thread_id, normalized_subject, thread_id
			),
			all_emails_with_conv AS (
				SELECT e.*, COALESCE(tc.conversation_id, COALESCE(e.thread_id, e.id)) as conversation_id
				FROM emails e
				LEFT JOIN thread_to_conversation tc ON COALESCE(e.thread_id, e.id) = tc.raw_thread_id
				WHERE e.mailbox_id = ?1
			),
			conversation_stats AS (
				SELECT conversation_id, COUNT(*) as thread_count,
					SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END) as thread_unread_count,
					SUM(CASE WHEN read = 1 THEN 1 ELSE 0 END) as thread_read_count,
					GROUP_CONCAT(DISTINCT sender) as participants,
					SUM(CASE WHEN folder_id = (SELECT id FROM folders WHERE mailbox_id = ?1 AND slug = 'draft' LIMIT 1) THEN 1 ELSE 0 END) as has_draft
				FROM all_emails_with_conv
				WHERE conversation_id IN (
					SELECT DISTINCT conversation_id FROM all_emails_with_conv WHERE folder_id = ?2
				)
				GROUP BY conversation_id
			),
			latest_message_per_conversation AS (
				SELECT conversation_id, folder_id,
					ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY date DESC) as rn
				FROM all_emails_with_conv
			),
			latest_in_folder AS (
				SELECT fe.*, COALESCE(tc.conversation_id, fe.raw_thread_id) as conversation_id,
					ROW_NUMBER() OVER (
						PARTITION BY COALESCE(tc.conversation_id, fe.raw_thread_id)
						ORDER BY fe.date DESC
					) as rn
				FROM folder_emails fe
				LEFT JOIN thread_to_conversation tc ON fe.raw_thread_id = tc.raw_thread_id
			)
			SELECT lif.id, lif.subject, lif.sender, lif.recipient, lif.date,
				lif.read, lif.starred, lif.thread_id, ?3 as folder_id,
				lif.in_reply_to, lif.email_references,
				SUBSTR(lif.body, 1, 300) as snippet,
				cs.thread_count, cs.thread_unread_count, cs.participants,
				CASE WHEN lmc.folder_id != (SELECT id FROM folders WHERE mailbox_id = ?1 AND slug = 'sent' LIMIT 1)
					AND lmc.folder_id != (SELECT id FROM folders WHERE mailbox_id = ?1 AND slug = 'draft' LIMIT 1)
					AND cs.thread_read_count > 0
					THEN 1 ELSE 0 END as needs_reply,
				CASE WHEN cs.has_draft > 0 THEN 1 ELSE 0 END as has_draft
			FROM latest_in_folder lif
			JOIN conversation_stats cs ON lif.conversation_id = cs.conversation_id
			LEFT JOIN latest_message_per_conversation lmc
				ON lmc.conversation_id = lif.conversation_id AND lmc.rn = 1
			WHERE lif.rn = 1
			ORDER BY lif.date DESC
			LIMIT ?4 OFFSET ?5
		`;

		const res = await this.db.prepare(query).bind(mailboxId, folderRecord.id, folderRecord.slug, limit, offset).all<any>();
		return res.results.map((r) => ({
			...r,
			read: !!r.read,
			starred: !!r.starred,
			thread_count: r.thread_count || 1,
			thread_unread_count: r.thread_unread_count || 0,
			participants: r.participants || r.sender,
			needs_reply: !!r.needs_reply,
			has_draft: !!r.has_draft,
		}));
	}

	async countThreadedEmails(mailboxId: string, folder: string): Promise<number> {
		const folderRecord = await this.getFolderBySlug(mailboxId, folder);
		if (!folderRecord) return 0;

		const isDraftFolder = folder === Folders.DRAFT || folderRecord.slug === Folders.DRAFT;
		if (isDraftFolder) {
			const res = await this.db
				.prepare(
					"SELECT COUNT(DISTINCT COALESCE(in_reply_to, id)) as total FROM emails WHERE mailbox_id = ?1 AND folder_id = ?2",
				)
				.bind(mailboxId, folderRecord.id)
				.first<{ total: number }>();
			return res?.total ?? 0;
		}

		const query = `
			WITH folder_emails AS (
				SELECT COALESCE(thread_id, id) as raw_thread_id, thread_id,
					${NORMALIZED_SUBJECT_SQL} as normalized_subject
				FROM emails
				WHERE mailbox_id = ?1 AND folder_id = ?2
			),
			thread_to_conv AS (
				SELECT raw_thread_id,
					CASE WHEN thread_id IS NOT NULL THEN raw_thread_id
						WHEN normalized_subject != '' THEN MIN(raw_thread_id) OVER (PARTITION BY normalized_subject)
						ELSE raw_thread_id
					END as conversation_id
				FROM folder_emails
				GROUP BY raw_thread_id, normalized_subject, thread_id
			)
			SELECT COUNT(DISTINCT conversation_id) as total FROM thread_to_conv
		`;
		const res = await this.db.prepare(query).bind(mailboxId, folderRecord.id).first<{ total: number }>();
		return res?.total ?? 0;
	}

	// ── Single Email & Thread Operations ───────────────────────────

	async getEmail(mailboxId: string, id: string) {
		const email = await this.db
			.prepare(
				`SELECT e.*, f.slug as folder_id
				 FROM emails e
				 LEFT JOIN folders f ON e.folder_id = f.id
				 WHERE e.mailbox_id = ?1 AND e.id = ?2`,
			)
			.bind(mailboxId, id)
			.first<any>();

		if (!email) return null;

		const attachments = await this.db
			.prepare("SELECT * FROM attachments WHERE mailbox_id = ?1 AND email_id = ?2")
			.bind(mailboxId, id)
			.all<AttachmentRecord>();

		return {
			...email,
			read: !!email.read,
			starred: !!email.starred,
			attachments: attachments.results ?? [],
		};
	}

	async getThreadEmails(mailboxId: string, threadId: string) {
		const emailRows = await this.db
			.prepare(
				`SELECT e.*, f.slug as folder_id
				 FROM emails e
				 LEFT JOIN folders f ON e.folder_id = f.id
				 WHERE e.mailbox_id = ?1 AND e.thread_id = ?2
				 ORDER BY e.date ASC`,
			)
			.bind(mailboxId, threadId)
			.all<any>();

		if (!emailRows.results.length) return [];

		const emailIds = emailRows.results.map((e) => e.id as string);
		const placeholders = emailIds.map((_, i) => `?${i + 2}`).join(",");

		const attRows = await this.db
			.prepare(`SELECT * FROM attachments WHERE mailbox_id = ?1 AND email_id IN (${placeholders})`)
			.bind(mailboxId, ...emailIds)
			.all<AttachmentRecord>();

		const attachmentsByEmail = new Map<string, AttachmentRecord[]>();
		for (const att of attRows.results) {
			const list = attachmentsByEmail.get(att.email_id) || [];
			list.push(att);
			attachmentsByEmail.set(att.email_id, list);
		}

		return emailRows.results.map((email) => ({
			...email,
			read: !!email.read,
			starred: !!email.starred,
			attachments: attachmentsByEmail.get(email.id) || [],
		}));
	}

	async updateEmail(mailboxId: string, id: string, data: { read?: boolean; starred?: boolean }) {
		const sets: string[] = [];
		const params: (string | number)[] = [];

		if (data.read !== undefined) {
			params.push(data.read ? 1 : 0);
			sets.push(`read = ?${params.length}`);
		}
		if (data.starred !== undefined) {
			params.push(data.starred ? 1 : 0);
			sets.push(`starred = ?${params.length}`);
		}

		if (sets.length > 0) {
			params.push(mailboxId, id);
			await this.db
				.prepare(`UPDATE emails SET ${sets.join(", ")} WHERE mailbox_id = ?${params.length - 1} AND id = ?${params.length}`)
				.bind(...params)
				.run();
		}
		return this.getEmail(mailboxId, id);
	}

	async markThreadRead(mailboxId: string, threadId: string) {
		await this.db
			.prepare("UPDATE emails SET read = 1 WHERE mailbox_id = ?1 AND thread_id = ?2 AND read = 0")
			.bind(mailboxId, threadId)
			.run();
		return { threadId, markedRead: true };
	}

	async moveEmail(mailboxId: string, id: string, folderSlug: string): Promise<boolean> {
		const folder = await this.getFolderBySlug(mailboxId, folderSlug);
		if (!folder) return false;

		const res = await this.db
			.prepare("UPDATE emails SET folder_id = ?1 WHERE mailbox_id = ?2 AND id = ?3")
			.bind(folder.id, mailboxId, id)
			.run();
		return (res.meta?.changes ?? 0) > 0;
	}

	async deleteEmail(mailboxId: string, id: string): Promise<AttachmentRecord[] | null> {
		const email = await this.getEmail(mailboxId, id);
		if (!email) return null;

		const atts = (email.attachments ?? []) as AttachmentRecord[];
		await this.db
			.prepare("DELETE FROM emails WHERE mailbox_id = ?1 AND id = ?2")
			.bind(mailboxId, id)
			.run();

		return atts;
	}

	async createEmail(mailboxId: string, folderSlug: string, email: EmailData, attachments: AttachmentData[] = []) {
		const folder = await this.getFolderBySlug(mailboxId, folderSlug);
		if (!folder) throw new Error(`Folder "${folderSlug}" not found for mailbox "${mailboxId}"`);

		const isSent = folder.slug === Folders.SENT;
		const readVal = isSent ? 1 : (email.read ? 1 : 0);

		await this.db
			.prepare(
				`INSERT INTO emails (
					id, mailbox_id, folder_id, subject, sender, recipient,
					cc, bcc, date, read, starred, body, in_reply_to,
					email_references, thread_id, message_id, raw_headers
				) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)`,
			)
			.bind(
				email.id,
				mailboxId,
				folder.id,
				email.subject || "",
				email.sender || "",
				email.recipient || "",
				email.cc ?? null,
				email.bcc ?? null,
				email.date,
				readVal,
				email.starred ? 1 : 0,
				email.body || "",
				email.in_reply_to ?? null,
				email.email_references ?? null,
				email.thread_id ?? email.id,
				email.message_id ?? null,
				email.raw_headers ?? null,
			)
			.run();

		for (const att of attachments) {
			await this.db
				.prepare(
					`INSERT INTO attachments (
						id, mailbox_id, email_id, filename, mimetype, size, content_id, disposition, storage_key
					) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
				)
				.bind(
					att.id,
					mailboxId,
					email.id,
					att.filename,
					att.mimetype,
					att.size,
					att.content_id ?? null,
					att.disposition ?? "attachment",
					att.storage_key,
				)
				.run();
		}
	}

	async getAttachment(mailboxId: string, attachmentId: string): Promise<AttachmentRecord | null> {
		const res = await this.db
			.prepare("SELECT * FROM attachments WHERE mailbox_id = ?1 AND id = ?2")
			.bind(mailboxId, attachmentId)
			.first<AttachmentRecord>();
		return res ?? null;
	}

	// ── Full-Text Search ───────────────────────────────────────────

	async searchEmails(mailboxId: string, options: SearchFilterOptions) {
		const { query, folder, from, to, subject, date_start, date_end, is_read, is_starred, has_attachment, page = 1, limit: rawLimit = 25 } = options;
		const limit = Math.min(Math.max(rawLimit, 1), 100);
		const offset = (page - 1) * limit;

		const conditions: string[] = ["e.mailbox_id = ?1"];
		const params: (string | number)[] = [mailboxId];

		if (query) {
			const p = `%${query}%`;
			params.push(p, p, p, p);
			const idx = params.length - 3;
			conditions.push(`(e.subject LIKE ?${idx} OR e.body LIKE ?${idx + 1} OR e.sender LIKE ?${idx + 2} OR e.recipient LIKE ?${idx + 3} OR e.cc LIKE ?${idx + 3} OR e.bcc LIKE ?${idx + 3})`);
		}

		if (folder) {
			const folderRecord = await this.getFolderBySlug(mailboxId, folder);
			if (folderRecord) {
				params.push(folderRecord.id);
				conditions.push(`e.folder_id = ?${params.length}`);
			}
		}
		if (from) { params.push(`%${from}%`); conditions.push(`e.sender LIKE ?${params.length}`); }
		if (to) { params.push(`%${to}%`); conditions.push(`(e.recipient LIKE ?${params.length} OR e.cc LIKE ?${params.length} OR e.bcc LIKE ?${params.length})`); }
		if (subject) { params.push(`%${subject}%`); conditions.push(`e.subject LIKE ?${params.length}`); }
		if (date_start) { params.push(date_start); conditions.push(`e.date >= ?${params.length}`); }
		if (date_end) { params.push(date_end); conditions.push(`e.date <= ?${params.length}`); }
		if (is_read !== undefined) { params.push(is_read ? 1 : 0); conditions.push(`e.read = ?${params.length}`); }
		if (is_starred !== undefined) { params.push(is_starred ? 1 : 0); conditions.push(`e.starred = ?${params.length}`); }
		if (has_attachment) { conditions.push(`e.id IN (SELECT DISTINCT email_id FROM attachments WHERE mailbox_id = e.mailbox_id)`); }

		params.push(limit, offset);
		const sql = `
			SELECT e.id, e.subject, e.sender, e.recipient, e.cc, e.bcc, e.date,
				e.read, e.starred, e.in_reply_to, e.email_references, e.thread_id,
				f.slug as folder_id, f.name as folder_name,
				SUBSTR(e.body, 1, 300) as snippet
			FROM emails e
			LEFT JOIN folders f ON e.folder_id = f.id
			WHERE ${conditions.join(" AND ")}
			ORDER BY e.date DESC
			LIMIT ?${params.length - 1} OFFSET ?${params.length}
		`;

		const res = await this.db.prepare(sql).bind(...params).all<any>();
		return res.results.map((r) => ({
			...r,
			read: !!r.read,
			starred: !!r.starred,
		}));
	}

	async countSearchResults(mailboxId: string, options: SearchFilterOptions): Promise<number> {
		const { query, folder, from, to, subject, date_start, date_end, is_read, is_starred, has_attachment } = options;
		const conditions: string[] = ["mailbox_id = ?1"];
		const params: (string | number)[] = [mailboxId];

		if (query) {
			const p = `%${query}%`;
			params.push(p, p, p, p);
			const idx = params.length - 3;
			conditions.push(`(subject LIKE ?${idx} OR body LIKE ?${idx + 1} OR sender LIKE ?${idx + 2} OR recipient LIKE ?${idx + 3} OR cc LIKE ?${idx + 3} OR bcc LIKE ?${idx + 3})`);
		}
		if (folder) {
			const folderRecord = await this.getFolderBySlug(mailboxId, folder);
			if (folderRecord) {
				params.push(folderRecord.id);
				conditions.push(`folder_id = ?${params.length}`);
			}
		}
		if (from) { params.push(`%${from}%`); conditions.push(`sender LIKE ?${params.length}`); }
		if (to) { params.push(`%${to}%`); conditions.push(`(recipient LIKE ?${params.length} OR cc LIKE ?${params.length} OR bcc LIKE ?${params.length})`); }
		if (subject) { params.push(`%${subject}%`); conditions.push(`subject LIKE ?${params.length}`); }
		if (date_start) { params.push(date_start); conditions.push(`date >= ?${params.length}`); }
		if (date_end) { params.push(date_end); conditions.push(`date <= ?${params.length}`); }
		if (is_read !== undefined) { params.push(is_read ? 1 : 0); conditions.push(`read = ?${params.length}`); }
		if (is_starred !== undefined) { params.push(is_starred ? 1 : 0); conditions.push(`starred = ?${params.length}`); }
		if (has_attachment) { conditions.push(`id IN (SELECT DISTINCT email_id FROM attachments WHERE mailbox_id = mailbox_id)`); }

		const sql = `SELECT COUNT(*) as total FROM emails WHERE ${conditions.join(" AND ")}`;
		const res = await this.db.prepare(sql).bind(...params).first<{ total: number }>();
		return res?.total ?? 0;
	}

	async findThreadBySubject(mailboxId: string, subject: string, senderAddress?: string): Promise<string | null> {
		const normalized = subject
			.replace(/^(?:(?:re|fwd?|fw|aw|wg|r[eé]f|sv)\s*:\s*)+/i, "")
			.trim()
			.toLowerCase();
		if (!normalized) return null;

		const query = `
			SELECT thread_id, subject,
				GROUP_CONCAT(DISTINCT LOWER(sender)) as senders,
				GROUP_CONCAT(DISTINCT LOWER(recipient)) as recipients
			FROM emails
			WHERE mailbox_id = ?1
				AND thread_id IS NOT NULL
				AND thread_id != id
				AND date >= datetime('now', '-7 days')
			GROUP BY thread_id
			ORDER BY MAX(date) DESC
			LIMIT 50
		`;
		const res = await this.db.prepare(query).bind(mailboxId).all<any>();
		const normalizedSender = senderAddress?.toLowerCase().trim();

		for (const row of res.results) {
			const rowSubject = String(row.subject || "")
				.replace(/^(?:(?:re|fwd?|fw|aw|wg|r[eé]f|sv)\s*:\s*)+/i, "")
				.trim()
				.toLowerCase();
			if (rowSubject !== normalized) continue;

			if (normalizedSender) {
				const allParticipants = `${row.senders || ""},${row.recipients || ""}`;
				if (!allParticipants.includes(normalizedSender)) continue;
			}
			return String(row.thread_id);
		}
		return null;
	}

	async checkSendRateLimit(mailboxId: string): Promise<string | null> {
		const hourRow = await this.db
			.prepare(
				`SELECT COUNT(*) as cnt FROM emails e
				 JOIN folders f ON e.folder_id = f.id
				 WHERE e.mailbox_id = ?1 AND f.slug = 'sent' AND e.date >= datetime('now', '-1 hour')`,
			)
			.bind(mailboxId)
			.first<{ cnt: number }>();

		if ((hourRow?.cnt ?? 0) >= 20) {
			return "Rate limit exceeded: max 20 emails per hour per mailbox";
		}

		const dayRow = await this.db
			.prepare(
				`SELECT COUNT(*) as cnt FROM emails e
				 JOIN folders f ON e.folder_id = f.id
				 WHERE e.mailbox_id = ?1 AND f.slug = 'sent' AND e.date >= datetime('now', '-1 day')`,
			)
			.bind(mailboxId)
			.first<{ cnt: number }>();

		if ((dayRow?.cnt ?? 0) >= 100) {
			return "Rate limit exceeded: max 100 emails per day per mailbox";
		}

		return null;
	}
}
