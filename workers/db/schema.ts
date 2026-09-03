// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
	id: text("id").primaryKey(),
	oauth_provider: text("oauth_provider").notNull().default("oauth"),
	oauth_id: text("oauth_id").notNull().unique(),
	email: text("email").notNull(),
	name: text("name").notNull(),
	role: text("role").notNull().default("Admin"),
	custom_ai_endpoint: text("custom_ai_endpoint"),
	custom_ai_key: text("custom_ai_key"),
	custom_ai_model: text("custom_ai_model"),
	created_at: text("created_at").notNull(),
	updated_at: text("updated_at").notNull(),
});

export const sessions = sqliteTable("sessions", {
	id: text("id").primaryKey(),
	user_id: text("user_id")
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
	expires_at: integer("expires_at").notNull(),
	created_at: text("created_at").notNull(),
});

export const mailboxes = sqliteTable("mailboxes", {
	id: text("id").primaryKey(), // The email address alias, e.g. "alex@example.com"
	user_id: text("user_id")
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
	name: text("name").notNull(),
	is_default: integer("is_default").notNull().default(0),
	settings: text("settings"), // JSON string
	created_at: text("created_at").notNull(),
	updated_at: text("updated_at").notNull(),
}, (table) => [
	index("idx_mailboxes_user_id").on(table.user_id),
]);

export const folders = sqliteTable("folders", {
	id: text("id").primaryKey(), // `${mailbox_id}:${slug}`
	mailbox_id: text("mailbox_id")
		.notNull()
		.references(() => mailboxes.id, { onDelete: "cascade" }),
	slug: text("slug").notNull(),
	name: text("name").notNull(),
	is_deletable: integer("is_deletable").notNull().default(1),
}, (table) => [
	index("idx_folders_mailbox_id").on(table.mailbox_id),
]);

export const emails = sqliteTable("emails", {
	id: text("id").primaryKey(),
	mailbox_id: text("mailbox_id")
		.notNull()
		.references(() => mailboxes.id, { onDelete: "cascade" }),
	folder_id: text("folder_id")
		.notNull()
		.references(() => folders.id, { onDelete: "cascade" }),
	subject: text("subject"),
	sender: text("sender"),
	recipient: text("recipient"),
	cc: text("cc"),
	bcc: text("bcc"),
	date: text("date"),
	read: integer("read").default(0),
	starred: integer("starred").default(0),
	body: text("body"),
	in_reply_to: text("in_reply_to"),
	email_references: text("email_references"),
	thread_id: text("thread_id"),
	message_id: text("message_id"),
	raw_headers: text("raw_headers"),
}, (table) => [
	index("idx_emails_mailbox_folder").on(table.mailbox_id, table.folder_id),
	index("idx_emails_mailbox_thread").on(table.mailbox_id, table.thread_id),
	index("idx_emails_date").on(table.mailbox_id, table.date),
]);

export const attachments = sqliteTable("attachments", {
	id: text("id").primaryKey(),
	mailbox_id: text("mailbox_id")
		.notNull()
		.references(() => mailboxes.id, { onDelete: "cascade" }),
	email_id: text("email_id")
		.notNull()
		.references(() => emails.id, { onDelete: "cascade" }),
	filename: text("filename").notNull(),
	mimetype: text("mimetype").notNull(),
	size: integer("size").notNull(),
	content_id: text("content_id"),
	disposition: text("disposition"),
	storage_key: text("storage_key").notNull(),
}, (table) => [
	index("idx_attachments_email_id").on(table.email_id),
	index("idx_attachments_mailbox_id").on(table.mailbox_id),
]);
