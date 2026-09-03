// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export interface UserRecord {
	id: string;
	oauth_provider: string;
	oauth_id: string;
	email: string;
	name: string;
	role: string;
	custom_ai_endpoint: string | null;
	custom_ai_key: string | null;
	custom_ai_model: string | null;
	created_at: string;
	updated_at: string;
}

export interface MailboxRecord {
	id: string; // email address alias
	user_id: string;
	name: string;
	is_default: number;
	settings: string | null; // JSON string
	created_at: string;
	updated_at: string;
}

export interface FolderRecord {
	id: string;
	mailbox_id: string;
	slug: string;
	name: string;
	is_deletable: number;
}

export interface EmailRecord {
	id: string;
	mailbox_id: string;
	folder_id: string;
	subject: string | null;
	sender: string | null;
	recipient: string | null;
	cc: string | null;
	bcc: string | null;
	date: string | null;
	read: number | null;
	starred: number | null;
	body: string | null;
	in_reply_to: string | null;
	email_references: string | null;
	thread_id: string | null;
	message_id: string | null;
	raw_headers: string | null;
}

export interface AttachmentRecord {
	id: string;
	mailbox_id: string;
	email_id: string;
	filename: string;
	mimetype: string;
	size: number;
	content_id: string | null;
	disposition: string | null;
	storage_key: string;
}

export interface Env {
	DB: D1Database;
	BUCKET: R2Bucket;
	EMAIL: SendEmail;
	OAUTH_SERVICE?: Fetcher;
	DOMAINS?: string;
	EMAIL_ADDRESSES?: string[];
	OAUTH_CLIENT_ID: string;
	OAUTH_CLIENT_SECRET: string;
	OAUTH_AUTH_URL: string;
	OAUTH_TOKEN_URL: string;
	OAUTH_USERINFO_URL: string;
	OAUTH_REDIRECT_URI?: string;
	OAUTH_SCOPES?: string;
	OAUTH_ADMIN_ROLE_CLAIM?: string;
	OAUTH_ADMIN_ROLE_VALUE?: string;
	COOKIE_SECRET?: string;
	APP_URL?: string;
}
