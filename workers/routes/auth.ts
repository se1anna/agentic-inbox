// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Hono } from "hono";
import type { Env } from "../types";
import {
	createAuthorizationUrl,
	exchangeCodeForToken,
	fetchUserInfo,
	parseJwtPayload,
	extractRole,
	handleOAuthUserLogin,
	invalidateSession,
	validateSession,
} from "../auth/oauth";
import { getSessionTokenFromRequest, type AuthContext } from "../auth/middleware";
import { D1MailboxService } from "../db/d1-queries";

const authRouter = new Hono<AuthContext>();

// ── GET /api/v1/auth/login ─────────────────────────────────────────
authRouter.get("/login", async (c) => {
	try {
		const { url, state, codeVerifier } = await createAuthorizationUrl(c.env, c.req.url);

		// Set OAuth state and verifier in temporary secure cookies (10 min expiry)
		const headers = new Headers();
		headers.append(
			"Set-Cookie",
			`oauth_state=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${c.req.url.startsWith("https://") ? "; Secure" : ""}`,
		);
		headers.append(
			"Set-Cookie",
			`oauth_verifier=${codeVerifier}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${c.req.url.startsWith("https://") ? "; Secure" : ""}`,
		);
		headers.set("Location", url);

		return new Response(null, {
			status: 302,
			headers,
		});
	} catch (e: any) {
		console.error("Failed to initiate OAuth login:", e);
		return c.json({ error: `OAuth initialization error: ${e?.message || e}` }, 500);
	}
});

// ── GET /api/v1/auth/callback ──────────────────────────────────────
authRouter.get("/callback", async (c) => {
	const code = c.req.query("code");
	const state = c.req.query("state");
	const error = c.req.query("error");
	const errorDescription = c.req.query("error_description");

	if (error) {
		return c.html(
			`<!DOCTYPE html>
			<html><head><title>OAuth Error</title></head>
			<body style="font-family: sans-serif; padding: 2rem; background: #0f172a; color: #f8fafc;">
				<h2>OAuth Error</h2>
				<p>${error}: ${errorDescription || "Login was cancelled or failed."}</p>
				<a href="/login" style="color: #38bdf8;">Return to Login</a>
			</body></html>`,
			400,
		);
	}

	if (!code || !state) {
		return c.json({ error: "Missing code or state in OAuth callback" }, 400);
	}

	// Read state & verifier cookies
	const cookieHeader = c.req.header("Cookie") || "";
	let savedState = "";
	let savedVerifier = "";
	for (const part of cookieHeader.split(";").map((p) => p.trim())) {
		if (part.startsWith("oauth_state=")) savedState = decodeURIComponent(part.substring(12));
		if (part.startsWith("oauth_verifier=")) savedVerifier = decodeURIComponent(part.substring(15));
	}

	if (!savedState || savedState !== state) {
		return c.json({ error: "Invalid or expired OAuth state parameter" }, 400);
	}

	try {
		// 1. Exchange code for access_token (and id_token)
		const tokenRes = await exchangeCodeForToken(c.env, code, savedVerifier, c.req.url);
		const idTokenPayload = parseJwtPayload(tokenRes.id_token);

		// 2. Fetch userinfo
		const userinfo = await fetchUserInfo(c.env, tokenRes.access_token);

		// 3. Extract identity and evaluate Admin role
		const oauthId = String(userinfo.sub || userinfo.id || idTokenPayload?.sub || idTokenPayload?.id || "");
		const email = String(userinfo.email || idTokenPayload?.email || "").toLowerCase().trim();
		const name = String(userinfo.name || userinfo.preferred_username || userinfo.login || idTokenPayload?.name || email.split("@")[0] || "User");

		if (!oauthId || !email) {
			return c.json({ error: "OAuth provider did not return user ID or email address" }, 400);
		}

		const adminRoleValue = c.env.OAUTH_ADMIN_ROLE_VALUE || "Admin";
		const { isAdmin, roleString } = extractRole(userinfo, idTokenPayload, c.env.OAUTH_ADMIN_ROLE_CLAIM, adminRoleValue);

		if (!isAdmin) {
			return c.html(
				`<!DOCTYPE html>
				<html lang="en">
				<head>
					<meta charset="utf-8">
					<title>403 Forbidden - Admin Role Required</title>
					<meta name="viewport" content="width=device-width, initial-scale=1.0">
					<style>
						body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #0f172a; color: #f8fafc; }
						.card { max-width: 480px; padding: 2.5rem; background: #1e293b; border-radius: 12px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); text-align: center; border: 1px solid #334155; }
						h1 { color: #ef4444; font-size: 1.5rem; margin-bottom: 1rem; }
						p { color: #94a3b8; font-size: 0.95rem; line-height: 1.6; margin-bottom: 1.5rem; }
						a { display: inline-block; padding: 0.75rem 1.5rem; background: #3b82f6; color: white; border-radius: 6px; text-decoration: none; font-weight: 500; }
					</style>
				</head>
				<body>
					<div class="card">
						<h1>403 Forbidden</h1>
						<p>Access to this mail server is strictly restricted to accounts with the <strong>Admin</strong> role.<br><br>Your account (<strong>${email}</strong>) logged in successfully, but only has role: <em>${roleString}</em>.</p>
						<a href="/api/v1/auth/logout">Log out and retry with an Admin account</a>
					</div>
				</body>
				</html>`,
				403,
			);
		}

		// 4. Create or update user & auto-provision default mailbox alias
		const { sessionToken } = await handleOAuthUserLogin(c.env, {
			oauth_id: oauthId,
			email,
			name,
			role: "Admin",
			raw: userinfo,
		});

		// 5. Set session cookie and redirect to root SPA
		const isSecure = c.req.url.startsWith("https://");
		const headers = new Headers();
		headers.append(
			"Set-Cookie",
			`session_token=${encodeURIComponent(sessionToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}${isSecure ? "; Secure" : ""}`,
		);
		// Clear oauth cookies
		headers.append("Set-Cookie", "oauth_state=; Path=/; HttpOnly; Max-Age=0");
		headers.append("Set-Cookie", "oauth_verifier=; Path=/; HttpOnly; Max-Age=0");
		headers.set("Location", "/");

		return new Response(null, {
			status: 302,
			headers,
		});
	} catch (e: any) {
		console.error("OAuth callback error:", e);
		return c.json({ error: `OAuth authentication failed: ${e?.message || e}` }, 500);
	}
});

// ── GET /api/v1/auth/me ────────────────────────────────────────────
authRouter.get("/me", async (c) => {
	const token = getSessionTokenFromRequest(c);
	if (!token) {
		return c.json({ authenticated: false, user: null }, 401);
	}

	const user = await validateSession(c.env, token);
	if (!user) {
		return c.json({ authenticated: false, user: null }, 401);
	}

	const mailboxService = new D1MailboxService(c.env.DB);
	const userMailboxes = await mailboxService.listMailboxesByUser(user.id);

	return c.json({
		authenticated: true,
		user: {
			id: user.id,
			email: user.email,
			name: user.name,
			role: user.role,
			hasCustomAI: !!user.custom_ai_endpoint,
			custom_ai_endpoint: user.custom_ai_endpoint,
			custom_ai_model: user.custom_ai_model || "gpt-4o-mini",
		},
		mailboxes: userMailboxes.map((m) => ({
			id: m.id,
			email: m.id,
			name: m.name,
			isDefault: m.is_default === 1,
			settings: m.settings ? JSON.parse(m.settings) : null,
		})),
	});
});

// ── POST /api/v1/auth/logout ───────────────────────────────────────
authRouter.post("/logout", async (c) => {
	const token = getSessionTokenFromRequest(c);
	if (token) {
		await invalidateSession(c.env, token);
	}

	const headers = new Headers();
	headers.append("Set-Cookie", "session_token=; Path=/; HttpOnly; Max-Age=0");
	return new Response(JSON.stringify({ status: "logged_out" }), {
		status: 200,
		headers: {
			...Object.fromEntries(headers.entries()),
			"Content-Type": "application/json",
		},
	});
});

authRouter.get("/logout", async (c) => {
	const token = getSessionTokenFromRequest(c);
	if (token) {
		await invalidateSession(c.env, token);
	}
	const headers = new Headers();
	headers.append("Set-Cookie", "session_token=; Path=/; HttpOnly; Max-Age=0");
	headers.set("Location", "/login");
	return new Response(null, { status: 302, headers });
});

export { authRouter };
