// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Badge } from "@cloudflare/kumo";
import { EnvelopeSimpleIcon, ShieldCheckIcon, SignInIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useSearchParams } from "react-router";
import { useI18n } from "~/i18n";

export function meta() {
	return [{ title: "Login - Agentic Mailbox" }];
}

export default function LoginRoute() {
	const [searchParams] = useSearchParams();
	const error = searchParams.get("error");
	const { t, language, setLanguage } = useI18n();

	const handleLogin = () => {
		window.location.href = "/api/v1/auth/login";
	};

	return (
		<div className="min-h-screen bg-kumo-recessed flex items-center justify-center p-4">
			<div className="max-w-md w-full rounded-2xl border border-kumo-line bg-kumo-base p-8 shadow-xl">
				{/* Top right language switch */}
				<div className="flex justify-end mb-4">
					<button
						type="button"
						onClick={() => setLanguage(language === "zh-CN" ? "en" : "zh-CN")}
						className="text-xs text-kumo-subtle hover:text-kumo-default transition-colors border border-kumo-line px-2.5 py-1 rounded-md bg-kumo-fill/40 cursor-pointer"
					>
						{language === "zh-CN" ? "English" : "简体中文"}
					</button>
				</div>

				{/* Logo / Header */}
				<div className="flex flex-col items-center text-center mb-8">
					<div className="h-16 w-16 rounded-2xl bg-kumo-fill flex items-center justify-center text-kumo-default mb-4 shadow-inner">
						<EnvelopeSimpleIcon size={36} weight="duotone" />
					</div>
					<h1 className="text-2xl font-bold text-kumo-default tracking-tight">
						{t("login.title")}
					</h1>
					<p className="text-sm text-kumo-subtle mt-1.5">
						{t("login.subtitle")}
					</p>
					<div className="mt-3 flex items-center gap-2">
						<Badge variant="primary">
							<ShieldCheckIcon size={14} className="mr-1 inline" />
							{t("login.mandatoryAuth")}
						</Badge>
						<Badge variant="secondary">{t("login.adminRequired")}</Badge>
					</div>
				</div>

				{/* Error Notice */}
				{error && (
					<div className="mb-6 rounded-lg border border-red-500/20 bg-red-500/10 p-4 text-sm text-red-400 flex items-start gap-3">
						<WarningCircleIcon size={20} className="shrink-0 mt-0.5" />
						<div>
							<div className="font-semibold">{t("login.authError")}</div>
							<div className="text-xs mt-0.5 text-red-300">{error}</div>
						</div>
					</div>
				)}

				{/* Login Action */}
				<div className="space-y-4">
					<Button
						variant="primary"
						size="lg"
						icon={<SignInIcon size={20} />}
						onClick={handleLogin}
						className="w-full justify-center py-3 text-sm font-semibold"
					>
						{t("login.signInBtn")}
					</Button>

					<p className="text-center text-xs text-kumo-subtle leading-relaxed">
						{t("login.signInHint")}
					</p>
				</div>
			</div>
		</div>
	);
}
