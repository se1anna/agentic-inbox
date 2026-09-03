// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Hono } from "hono";
import { createRequestHandler } from "react-router";
import { apiApp, receiveEmail } from "./index";
import type { Env } from "./types";
import { requireAdminAuth, type AuthContext } from "./auth/middleware";

declare module "react-router" {
	export interface AppLoadContext {
		cloudflare: {
			env: Env;
			ctx: ExecutionContext;
		};
	}
}

const requestHandler = createRequestHandler(
	() => import("virtual:react-router/server-build"),
	import.meta.env.MODE,
);

const app = new Hono<AuthContext>();

// 1. Mount API router
app.route("/", apiApp);

// 2. Protect SPA routes with requireAdminAuth (except /login and static assets)
app.use("*", requireAdminAuth);

// 3. React Router catch-all: serves the SPA
app.all("*", (c) => {
	return requestHandler(c.req.raw, {
		cloudflare: { env: c.env, ctx: c.executionCtx as ExecutionContext },
	});
});

export default {
	fetch: app.fetch,
	async email(
		message: ForwardableEmailMessage,
		env: Env,
		ctx: ExecutionContext,
	) {
		try {
			await receiveEmail(message, env, ctx);
		} catch (e) {
			console.error("Failed to process incoming email via Email Routing:", (e as Error).message, (e as Error).stack);
			throw e;
		}
	},
};
