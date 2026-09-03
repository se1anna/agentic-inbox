// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import type { Env, UserRecord, MailboxRecord } from "../types";
import { validateSession } from "./oauth";
import { D1MailboxService } from "../db/d1-queries";

export type AuthContext = {
	Bindings: Env;
	Variables: {
		user: UserRecord;
		mailboxService: D1MailboxService;
		mailbox?: MailboxRecord;
	};
};

export function getSessionTokenFromRequest(c: Context): string | null {
	// 1. Check Authorization header
	const authHeader = c.req.header("Authorization");
	if (authHeader && authHeader.startsWith("Bearer ")) {
		return authHeader.substring(7).trim();
	}

	// 2. Check Cookie header
	const cookieHeader = c.req.header("Cookie");
	if (cookieHeader) {
		const cookies = cookieHeader.split(";").map((c) => c.trim());
		for (const cookie of cookies) {
			if (cookie.startsWith("session_token=")) {
				return decodeURIComponent(cookie.substring("session_token=".length));
			}
		}
	}

	return null;
}

/**
 * Mandatory Authentication Middleware:
 * Requires a valid session token in D1 and enforces role === 'Admin'.
 */
export const requireAdminAuth = createMiddleware<AuthContext>(async (c, next) => {
	const path = new URL(c.req.url).pathname;

	// Bypass auth for public routes (OAuth login/callback, static assets, etc.)
	if (
		path === "/api/v1/auth/login" ||
		path === "/api/v1/auth/callback" ||
		path === "/login" ||
		path.startsWith("/assets/") ||
		path === "/favicon.ico"
	) {
		return next();
	}

	const token = getSessionTokenFromRequest(c);
	if (!token) {
		if (path.startsWith("/api/")) {
			return c.json({ error: "Unauthorized: Login required" }, 401);
		}
		// For browser page requests, redirect to login
		return c.redirect("/login");
	}

	const user = await validateSession(c.env, token);
	if (!user) {
		if (path.startsWith("/api/")) {
			return c.json({ error: "Unauthorized: Invalid or expired session" }, 401);
		}
		return c.redirect("/login");
	}

	// Enforce Admin Role
	const adminTarget = (c.env.OAUTH_ADMIN_ROLE_VALUE || "Admin").toLowerCase().trim();
	const userRole = (user.role || "").toLowerCase().trim();

	const isAdmin = userRole === adminTarget || userRole.includes("admin");
	if (!isAdmin) {
		if (path.startsWith("/api/")) {
			return c.json({ error: "Forbidden: Access requires Admin role" }, 403);
		}
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
					a:hover { background: #2563eb; }
				</style>
			</head>
			<body>
				<div class="card">
					<h1>403 Forbidden</h1>
					<p>Access to this mail server is strictly restricted to accounts with the <strong>Admin</strong> role. Your account (${user.email}) currently has role: <em>${user.role}</em>.</p>
					<a href="/api/v1/auth/logout">Log out and retry</a>
				</div>
			</body>
			</html>`,
			403,
		);
	}

	// Attach user and service to Hono Context
	c.set("user", user);
	c.set("mailboxService", new D1MailboxService(c.env.DB));

	await next();
});

/**
 * Mailbox Authorization Middleware:
 * Verifies that the mailbox exists in D1 and is owned by the current authenticated user.
 */
export const requireUserMailbox = createMiddleware<AuthContext>(async (c, next) => {
	const rawId = c.req.param("mailboxId");
	if (!rawId) return c.json({ error: "Mailbox ID required" }, 400);
	const mailboxId = decodeURIComponent(rawId).toLowerCase();

	const user = c.var.user;
	if (!user) return c.json({ error: "Unauthorized" }, 401);

	const mailboxService = c.var.mailboxService || new D1MailboxService(c.env.DB);
	const mailbox = await mailboxService.getMailbox(mailboxId);

	if (!mailbox) {
		return c.json({ error: "Mailbox not found" }, 404);
	}

	// Check ownership
	if (mailbox.user_id !== user.id) {
		return c.json({ error: "Access denied to this mailbox" }, 403);
	}

	c.set("mailbox", mailbox);
	await next();
});
