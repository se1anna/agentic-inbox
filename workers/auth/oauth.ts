// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Env, UserRecord } from "../types";
import { D1MailboxService } from "../db/d1-queries";

export interface OAuthUserInfo {
	oauth_id: string;
	email: string;
	name: string;
	role: string;
	raw: Record<string, any>;
}

// ── PKCE & Crypto Helpers ──────────────────────────────────────────

export function generateRandomString(length = 32): string {
	const array = new Uint8Array(length);
	crypto.getRandomValues(array);
	return Array.from(array, (dec) => dec.toString(16).padStart(2, "0")).join("");
}

export async function generateCodeChallenge(verifier: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(verifier);
	const digest = await crypto.subtle.digest("SHA-256", data);
	const base64 = btoa(String.fromCharCode(...new Uint8Array(digest)))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
	return base64;
}

export function getRedirectUri(reqUrl: string, configuredUri?: string): string {
	if (configuredUri && configuredUri.trim().length > 0) {
		return configuredUri.trim();
	}
	const url = new URL(reqUrl);
	return `${url.origin}/api/v1/auth/callback`;
}

// ── Role Extraction ────────────────────────────────────────────────

export function extractRole(
	userinfo: Record<string, any>,
	idTokenPayload: Record<string, any> | null,
	claimPath?: string,
	adminRoleValue = "Admin",
): { isAdmin: boolean; roleString: string } {
	const claim = claimPath || "role";
	const combined = { ...idTokenPayload, ...userinfo };

	// Traverse nested property path e.g. "resource_access.mail.roles"
	const parts = claim.split(".");
	let current: any = combined;
	for (const part of parts) {
		if (current && typeof current === "object" && part in current) {
			current = current[part];
		} else {
			current = undefined;
			break;
		}
	}

	// Check direct role, roles array, groups array, realm_access, etc.
	let rolesFound: string[] = [];
	if (Array.isArray(current)) {
		rolesFound = current.map(String);
	} else if (typeof current === "string") {
		rolesFound = [current];
	} else {
		// Fallbacks: check common role/group fields
		if (Array.isArray(combined.roles)) rolesFound.push(...combined.roles.map(String));
		if (typeof combined.role === "string") rolesFound.push(combined.role);
		if (Array.isArray(combined.groups)) rolesFound.push(...combined.groups.map(String));
		if (Array.isArray(combined["cognito:groups"])) rolesFound.push(...combined["cognito:groups"].map(String));
		if (Array.isArray(combined["https://claims/roles"])) rolesFound.push(...combined["https://claims/roles"].map(String));
	}

	const normalizedTarget = adminRoleValue.toLowerCase().trim();
	const isAdmin = rolesFound.some(
		(r) => r.toLowerCase().trim() === normalizedTarget || r.toLowerCase().includes("admin"),
	);

	const roleString = rolesFound.length > 0 ? rolesFound.join(", ") : (isAdmin ? adminRoleValue : "User");
	return { isAdmin, roleString };
}

// ── Diagnostic Helpers ─────────────────────────────────────────────

function explainCloudflareError(status: number, targetUrl: string, bodyText: string): string {
	switch (status) {
		case 522:
			return (
				`[Cloudflare Error 522: Connection Timed Out]\n` +
				`Cause: Same-Zone Worker Subrequest Loop.\n` +
				`When Worker A ("mail.n0v.top") calls Worker B ("n0v.top") on the same Cloudflare zone via public fetch(), ` +
				`Cloudflare edge bypasses Worker B and connects directly to the DNS origin IP, causing a 522 timeout.\n` +
				`Solution: Add a Service Binding in wrangler.jsonc:\n` +
				`"services": [{ "binding": "OAUTH_SERVICE", "service": "<your-n0v-worker-name>" }]`
			);
		case 520:
			return `[Cloudflare Error 520: Web Server Returned an Unknown Error] Origin server for "${targetUrl}" returned an empty, invalid, or unexpected response.`;
		case 521:
			return `[Cloudflare Error 521: Web Server Is Down] The origin server for "${targetUrl}" actively refused the connection on port 443/80.`;
		case 523:
			return `[Cloudflare Error 523: Origin Is Unreachable] Cloudflare routing could not reach the origin server IP.`;
		case 524:
			return `[Cloudflare Error 524: A Timeout Occurred] Cloudflare connected to "${targetUrl}", but the origin took too long to return the HTTP response (>100s).`;
		case 403:
			return `[HTTP 403 Forbidden] Access denied by "${targetUrl}". Check Cloudflare WAF, Bot Fight Mode, or IP restrictions.`;
		case 401:
			return `[HTTP 401 Unauthorized] Invalid client credentials (client_id or client_secret) for "${targetUrl}".`;
		case 404:
			return `[HTTP 404 Not Found] The endpoint URL "${targetUrl}" does not exist. Check OAUTH_TOKEN_URL in wrangler.jsonc.`;
		default:
			return `[HTTP ${status}] Response from "${targetUrl}": ${bodyText.slice(0, 300)}`;
	}
}

// ── OAuth 2.0 / OIDC Operations ────────────────────────────────────

export async function createAuthorizationUrl(env: Env, reqUrl: string) {
	const state = generateRandomString(24);
	const codeVerifier = generateRandomString(48);
	const codeChallenge = await generateCodeChallenge(codeVerifier);
	const redirectUri = getRedirectUri(reqUrl, env.OAUTH_REDIRECT_URI);

	const authUrl = new URL(env.OAUTH_AUTH_URL);
	authUrl.searchParams.set("response_type", "code");
	authUrl.searchParams.set("client_id", env.OAUTH_CLIENT_ID);
	authUrl.searchParams.set("redirect_uri", redirectUri);
	authUrl.searchParams.set("scope", env.OAUTH_SCOPES || "openid profile email roles");
	authUrl.searchParams.set("state", state);
	authUrl.searchParams.set("code_challenge", codeChallenge);
	authUrl.searchParams.set("code_challenge_method", "S256");

	return {
		url: authUrl.toString(),
		state,
		codeVerifier,
	};
}

export async function exchangeCodeForToken(
	env: Env,
	code: string,
	codeVerifier: string,
	reqUrl: string,
): Promise<{ access_token: string; id_token?: string; token_type?: string }> {
	const redirectUri = getRedirectUri(reqUrl, env.OAUTH_REDIRECT_URI);
	const bodyParams = new URLSearchParams({
		grant_type: "authorization_code",
		client_id: env.OAUTH_CLIENT_ID,
		client_secret: env.OAUTH_CLIENT_SECRET,
		code,
		redirect_uri: redirectUri,
		code_verifier: codeVerifier,
	});

	// Support Basic Auth header as standard RFC 6749 fallback
	const basicAuth = btoa(`${env.OAUTH_CLIENT_ID}:${env.OAUTH_CLIENT_SECRET}`);
	const fetcher = env.OAUTH_SERVICE || { fetch: globalThis.fetch };

	let res: Response;
	try {
		res = await fetcher.fetch(env.OAUTH_TOKEN_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Accept: "application/json",
				Authorization: `Basic ${basicAuth}`,
				"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 AgenticMail/1.0",
			},
			body: bodyParams.toString(),
		});
	} catch (networkErr: any) {
		throw new Error(
			`Network fetch failure when calling OAUTH_TOKEN_URL (${env.OAUTH_TOKEN_URL}): ${networkErr?.message || networkErr}`,
		);
	}

	if (!res.ok) {
		const errorText = await res.text();
		const explanation = explainCloudflareError(res.status, env.OAUTH_TOKEN_URL, errorText);
		const cfRay = res.headers.get("cf-ray") || "none";
		const serverHeader = res.headers.get("server") || "unknown";

		const detailedError =
			`OAuth Token Exchange Failed (HTTP ${res.status})\n` +
			`• Target URL: ${env.OAUTH_TOKEN_URL}\n` +
			`• Redirect URI Sent: ${redirectUri}\n` +
			`• Used Service Binding: ${env.OAUTH_SERVICE ? "YES" : "NO (Public Fetch)"}\n` +
			`• CF-Ray: ${cfRay} | Server: ${serverHeader}\n` +
			`• Diagnostic:\n${explanation}\n` +
			`• Raw Body: ${errorText}`;

		console.error(detailedError);
		throw new Error(detailedError);
	}

	try {
		return (await res.json()) as { access_token: string; id_token?: string; token_type?: string };
	} catch (jsonErr: any) {
		throw new Error(`OAuth Token endpoint returned invalid JSON: ${jsonErr?.message}`);
	}
}

export async function fetchUserInfo(env: Env, accessToken: string): Promise<Record<string, any>> {
	const fetcher = env.OAUTH_SERVICE || { fetch: globalThis.fetch };

	let res: Response;
	try {
		res = await fetcher.fetch(env.OAUTH_USERINFO_URL, {
			headers: {
				Authorization: `Bearer ${accessToken}`,
				Accept: "application/json",
				"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 AgenticMail/1.0",
			},
		});
	} catch (networkErr: any) {
		throw new Error(
			`Network fetch failure when calling OAUTH_USERINFO_URL (${env.OAUTH_USERINFO_URL}): ${networkErr?.message || networkErr}`,
		);
	}

	if (!res.ok) {
		const errorText = await res.text();
		const explanation = explainCloudflareError(res.status, env.OAUTH_USERINFO_URL, errorText);
		const cfRay = res.headers.get("cf-ray") || "none";

		const detailedError =
			`OAuth UserInfo Fetch Failed (HTTP ${res.status})\n` +
			`• Target URL: ${env.OAUTH_USERINFO_URL}\n` +
			`• Used Service Binding: ${env.OAUTH_SERVICE ? "YES" : "NO (Public Fetch)"}\n` +
			`• CF-Ray: ${cfRay}\n` +
			`• Diagnostic:\n${explanation}\n` +
			`• Raw Body: ${errorText}`;

		console.error(detailedError);
		throw new Error(detailedError);
	}

	try {
		return (await res.json()) as Record<string, any>;
	} catch (jsonErr: any) {
		throw new Error(`OAuth UserInfo endpoint returned invalid JSON: ${jsonErr?.message}`);
	}
}

export function parseJwtPayload(token?: string): Record<string, any> | null {
	if (!token) return null;
	try {
		const parts = token.split(".");
		if (parts.length !== 3) return null;
		const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
		const decoded = atob(payload);
		return JSON.parse(decoded);
	} catch {
		return null;
	}
}

// ── User & Session Persistence in D1 ───────────────────────────────

export async function handleOAuthUserLogin(
	env: Env,
	userInfo: OAuthUserInfo,
): Promise<{ user: UserRecord; sessionToken: string }> {
	const mailboxService = new D1MailboxService(env.DB);
	const now = new Date().toISOString();

	// 1. Upsert user in D1
	let user = await env.DB
		.prepare("SELECT * FROM users WHERE oauth_id = ?1")
		.bind(userInfo.oauth_id)
		.first<UserRecord>();

	if (!user) {
		// Generate user ID
		const userId = crypto.randomUUID();
		await env.DB
			.prepare(
				`INSERT INTO users (
					id, oauth_provider, oauth_id, email, name, role,
					custom_ai_endpoint, custom_ai_key, custom_ai_model, created_at, updated_at
				) VALUES (?1, 'oauth', ?2, ?3, ?4, ?5, NULL, NULL, NULL, ?6, ?7)`,
			)
			.bind(userId, userInfo.oauth_id, userInfo.email, userInfo.name, userInfo.role, now, now)
			.run();

		user = await env.DB.prepare("SELECT * FROM users WHERE id = ?1").bind(userId).first<UserRecord>();
	} else {
		// Update name/email/role on login
		await env.DB
			.prepare("UPDATE users SET email = ?1, name = ?2, role = ?3, updated_at = ?4 WHERE id = ?5")
			.bind(userInfo.email, userInfo.name, userInfo.role, now, user.id)
			.run();
		user = await env.DB.prepare("SELECT * FROM users WHERE id = ?1").bind(user.id).first<UserRecord>();
	}

	if (!user) {
		throw new Error("Failed to create or update user record in D1");
	}

	// 2. Provision default mailbox alias if none exists for this user
	const userMailboxes = await mailboxService.listMailboxesByUser(user.id);
	if (userMailboxes.length === 0) {
		// Choose default email alias
		let defaultAlias = userInfo.email.toLowerCase().trim();
		const configuredDomains = (env.DOMAINS || "")
			.split(",")
			.map((d) => d.trim().toLowerCase())
			.filter(Boolean);

		// If user's email domain is not in configured DOMAINS, but configured DOMAINS exists,
		// use ${username}@${firstConfiguredDomain}
		const emailDomain = defaultAlias.split("@")[1];
		if (configuredDomains.length > 0 && (!emailDomain || !configuredDomains.includes(emailDomain))) {
			const localPart = defaultAlias.split("@")[0].replace(/[^a-zA-Z0-9._-]/g, "") || "user";
			defaultAlias = `${localPart}@${configuredDomains[0]}`;
		}

		// Ensure uniqueness (if taken, append random suffix)
		let candidate = defaultAlias;
		let attempt = 1;
		while (await mailboxService.getMailbox(candidate)) {
			const [userPart, domainPart] = defaultAlias.split("@");
			candidate = `${userPart}${attempt}@${domainPart}`;
			attempt++;
		}

		await mailboxService.createMailbox(
			user.id,
			candidate,
			userInfo.name || candidate.split("@")[0],
			{ fromName: userInfo.name },
			1, // isDefault = 1
		);
	}

	// 3. Create Session in D1
	const sessionToken = generateRandomString(48);
	const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 days

	await env.DB
		.prepare("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?1, ?2, ?3, ?4)")
		.bind(sessionToken, user.id, expiresAt, now)
		.run();

	return { user, sessionToken };
}

export async function validateSession(
	env: Env,
	sessionToken: string,
): Promise<UserRecord | null> {
	if (!sessionToken) return null;

	const now = Date.now();
	const session = await env.DB
		.prepare("SELECT * FROM sessions WHERE id = ?1 AND expires_at > ?2")
		.bind(sessionToken, now)
		.first<{ id: string; user_id: string; expires_at: number }>();

	if (!session) return null;

	const user = await env.DB
		.prepare("SELECT * FROM users WHERE id = ?1")
		.bind(session.user_id)
		.first<UserRecord>();

	return user ?? null;
}

export async function invalidateSession(env: Env, sessionToken: string): Promise<void> {
	await env.DB.prepare("DELETE FROM sessions WHERE id = ?1").bind(sessionToken).run();
}
