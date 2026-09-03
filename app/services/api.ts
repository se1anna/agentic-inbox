// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Email, Folder, Mailbox, UserProfile, AISettings } from "~/types";

const REQUEST_TIMEOUT_MS = 30_000;

export class ApiError extends Error {
	status: number;
	body: Record<string, unknown>;

	constructor(status: number, body: Record<string, unknown>) {
		const msg =
			(typeof body.error === "string" && body.error) ||
			(typeof body.message === "string" && body.message) ||
			(body.details ? JSON.stringify(body.details) : `Request failed: ${status}`);
		super(msg);
		this.name = "ApiError";
		this.status = status;
		this.body = body;
	}
}

async function request<T>(
	url: string,
	options: RequestInit = {},
): Promise<T> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

	const signal = options.signal
		? AbortSignal.any([options.signal, controller.signal])
		: controller.signal;

	try {
		const res = await fetch(url, {
			...options,
			signal,
			headers: {
				"Content-Type": "application/json",
				...(options.headers as Record<string, string>),
			},
		});

		if (res.status === 401 && !url.includes("/api/v1/auth/me")) {
			// Redirect to login on 401 Unauthorized
			if (typeof window !== "undefined" && window.location.pathname !== "/login") {
				window.location.href = "/login";
			}
		}

		if (!res.ok) {
			const body = await res.json().catch(() => ({}));
			throw new ApiError(res.status, body as Record<string, unknown>);
		}

		if (res.status === 204) return undefined as T;

		const contentType = res.headers.get("content-type") ?? "";
		if (contentType.includes("application/json")) {
			return res.json() as Promise<T>;
		}
		return res.blob() as unknown as T;
	} finally {
		clearTimeout(timeout);
	}
}

function get<T>(url: string, opts?: { params?: Record<string, string>; responseType?: string; signal?: AbortSignal }) {
	const query = opts?.params ? `?${new URLSearchParams(opts.params)}` : "";
	return request<T>(`${url}${query}`, {
		method: "GET",
		signal: opts?.signal,
		...(opts?.responseType === "blob" ? { headers: { Accept: "*/*" } } : {}),
	});
}

function post<T>(url: string, body?: unknown, opts?: { signal?: AbortSignal }) {
	return request<T>(url, {
		method: "POST",
		signal: opts?.signal,
		body: body != null ? JSON.stringify(body) : undefined,
	});
}

function put<T>(url: string, body?: unknown) {
	return request<T>(url, {
		method: "PUT",
		body: body != null ? JSON.stringify(body) : undefined,
	});
}

function del<T>(url: string) {
	return request<T>(url, { method: "DELETE" });
}

interface EmailListResponse {
	emails: Email[];
	totalCount: number;
}

const api = {
	// Auth
	getAuthMe: () =>
		get<{ authenticated: boolean; user: UserProfile; mailboxes: Mailbox[] }>("/api/v1/auth/me"),
	logout: () => post<{ status: string }>("/api/v1/auth/logout"),

	// User & AI Settings
	getUserSettings: () =>
		get<{ user: UserProfile; ai: AISettings }>("/api/v1/user/settings"),
	updateAISettings: (settings: { endpoint: string; apiKey?: string; model: string }) =>
		put<{ success: boolean; message: string; ai: AISettings }>("/api/v1/user/ai-settings", settings),
	testAIConnection: (settings: { endpoint: string; apiKey?: string; model: string }) =>
		post<{ success: boolean; message: string; response?: string }>("/api/v1/user/ai-test", settings),

	// Config
	getConfig: () =>
		get<{ domains: string[]; emailAddresses: string[] }>("/api/v1/config"),

	// Mailboxes & Aliases
	listMailboxes: () => get<Mailbox[]>("/api/v1/mailboxes"),
	createMailbox: (email: string, name: string, settings?: unknown) =>
		post<Mailbox>("/api/v1/mailboxes", { email, name, settings }),
	getMailbox: (mailboxId: string) =>
		get<Mailbox>(`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}`),
	updateMailbox: (mailboxId: string, settings: unknown, name?: string) =>
		put<Mailbox>(`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}`, { settings, name }),
	deleteMailbox: (mailboxId: string) =>
		del<void>(`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}`),

	// Emails
	listEmails: (mailboxId: string, params: Record<string, string>, opts?: { signal?: AbortSignal }) =>
		get<EmailListResponse | Email[]>(`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/emails`, { params, signal: opts?.signal }),
	sendEmail: (mailboxId: string, email: unknown) =>
		post<void>(`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/emails`, email),
	getEmail: (mailboxId: string, id: string, opts?: { signal?: AbortSignal }) =>
		get<Email>(`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/emails/${id}`, { signal: opts?.signal }),
	updateEmail: (mailboxId: string, id: string, data: unknown) =>
		put<Email>(`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/emails/${id}`, data),
	deleteEmail: (mailboxId: string, id: string) =>
		del<void>(`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/emails/${id}`),
	moveEmail: (mailboxId: string, id: string, folderId: string) =>
		post<void>(`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/emails/${id}/move`, { folderId }),
	getThread: (mailboxId: string, threadId: string, opts?: { signal?: AbortSignal }) =>
		get<Email[]>(`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/threads/${threadId}`, { signal: opts?.signal }),
	markThreadRead: (mailboxId: string, threadId: string) =>
		post<void>(`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/threads/${threadId}/read`),
	getAttachment: (mailboxId: string, emailId: string, attachmentId: string) =>
		get<Blob>(`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/emails/${emailId}/attachments/${attachmentId}`, { responseType: "blob" }),
	saveDraft: (
		mailboxId: string,
		draft: {
			to?: string;
			cc?: string;
			bcc?: string;
			subject?: string;
			body: string;
			in_reply_to?: string;
			thread_id?: string;
			draft_id?: string;
		},
	) => post<{ id: string; status: string }>(`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/drafts`, draft),
	replyToEmail: (mailboxId: string, emailId: string, email: unknown) =>
		post<void>(`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/emails/${emailId}/reply`, email),
	forwardEmail: (mailboxId: string, emailId: string, email: unknown) =>
		post<void>(`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/emails/${emailId}/forward`, email),

	// Folders
	listFolders: (mailboxId: string) =>
		get<Folder[]>(`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/folders`),
	createFolder: (mailboxId: string, name: string) =>
		post<Folder>(`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/folders`, { name }),
	updateFolder: (mailboxId: string, id: string, name: string) =>
		put<Folder>(`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/folders/${id}`, { name }),
	deleteFolder: (mailboxId: string, id: string) =>
		del<void>(`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/folders/${id}`),

	// Search
	searchEmails: (mailboxId: string, params: Record<string, string>) =>
		get<EmailListResponse>(`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/search`, { params }),

	// Agent Chat
	agentChat: (mailboxId: string, messages: Array<{ role: string; content: string }>) =>
		post<{ messages: Array<{ role: string; content: string }> }>(
			`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/agent/chat`,
			{ messages },
		),
};

export default api;
