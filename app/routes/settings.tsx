// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, Input, Loader, useKumoToastManager, Dialog, Select } from "@cloudflare/kumo";
import {
	RobotIcon,
	ArrowCounterClockwiseIcon,
	CpuIcon,
	CheckCircleIcon,
	WarningCircleIcon,
	UserIcon,
	PlusIcon,
	EnvelopeIcon,
	TranslateIcon,
} from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import api from "~/services/api";
import { useMailbox, useUpdateMailbox, useMailboxes, useCreateMailbox } from "~/queries/mailboxes";
import { queryKeys } from "~/queries/keys";
import { useI18n, type Language } from "~/i18n";

const PROMPT_PLACEHOLDER = `You are an email assistant that helps manage this inbox. You read emails, draft replies, and help organize conversations.\n\nWrite like a real person. Short, direct, flowing prose. Plain text only.\n\n(Leave empty to use the full built-in default prompt)`;

export default function SettingsRoute() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const toastManager = useKumoToastManager();
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const { t, language, setLanguage, languages } = useI18n();

	const { data: mailbox } = useMailbox(mailboxId);
	const { data: mailboxes = [] } = useMailboxes();
	const updateMailboxMutation = useUpdateMailbox();
	const createMailboxMutation = useCreateMailbox();

	// Fetch user & AI settings
	const { data: userSettings, refetch: refetchUserSettings } = useQuery({
		queryKey: ["userSettings"],
		queryFn: () => api.getUserSettings(),
	});

	// Fetch domain configuration
	const { data: configData } = useQuery({
		queryKey: queryKeys.config,
		queryFn: () => api.getConfig(),
		staleTime: Infinity,
	});

	const domains = configData?.domains ?? [];

	// Local state for Mailbox settings
	const [displayName, setDisplayName] = useState("");
	const [agentPrompt, setAgentPrompt] = useState("");
	const [isSavingMailbox, setIsSavingMailbox] = useState(false);

	// Local state for Custom AI settings
	const [aiEndpoint, setAiEndpoint] = useState("");
	const [aiApiKey, setAiApiKey] = useState("");
	const [aiModel, setAiModel] = useState("gpt-4o-mini");
	const [isSavingAI, setIsSavingAI] = useState(false);
	const [isTestingAI, setIsTestingAI] = useState(false);
	const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);

	// Local state for adding a new alias
	const [isAddAliasOpen, setIsAddAliasOpen] = useState(false);
	const [newPrefix, setNewPrefix] = useState("");
	const [selectedDomain, setSelectedDomain] = useState("");
	const [newAliasName, setNewAliasName] = useState("");
	const [isCreatingAlias, setIsCreatingAlias] = useState(false);
	const [aliasError, setAliasError] = useState<string | null>(null);

	useEffect(() => {
		if (mailbox) {
			setDisplayName(mailbox.settings?.fromName || mailbox.name || "");
			setAgentPrompt(mailbox.settings?.agentSystemPrompt || "");
		}
	}, [mailbox]);

	useEffect(() => {
		if (userSettings?.ai) {
			setAiEndpoint(userSettings.ai.endpoint || "");
			setAiModel(userSettings.ai.model || "gpt-4o-mini");
		}
	}, [userSettings]);

	useEffect(() => {
		if (domains.length > 0 && !selectedDomain) {
			setSelectedDomain(domains[0]);
		}
	}, [domains, selectedDomain]);

	// Save Mailbox Settings
	const handleSaveMailbox = async () => {
		if (!mailbox || !mailboxId) return;
		setIsSavingMailbox(true);
		const settings = {
			...mailbox.settings,
			fromName: displayName,
			agentSystemPrompt: agentPrompt.trim() || undefined,
		};
		try {
			await updateMailboxMutation.mutateAsync({ mailboxId, settings });
			toastManager.add({ title: t("settings.saveMailboxSuccess") });
		} catch {
			toastManager.add({
				title: t("common.error"),
				variant: "error",
			});
		} finally {
			setIsSavingMailbox(false);
		}
	};

	// Save Custom AI Provider Settings
	const handleSaveAI = async () => {
		if (!aiEndpoint.trim()) {
			toastManager.add({ title: t("settings.aiEndpointPlaceholder"), variant: "error" });
			return;
		}

		setIsSavingAI(true);
		try {
			await api.updateAISettings({
				endpoint: aiEndpoint.trim(),
				apiKey: aiApiKey.trim() || undefined,
				model: aiModel.trim() || "gpt-4o-mini",
			});
			await refetchUserSettings();
			toastManager.add({ title: t("settings.saveAiSuccess") });
			setAiApiKey(""); // Clear unmasked field from view
		} catch (e: any) {
			toastManager.add({
				title: e?.message || t("common.error"),
				variant: "error",
			});
		} finally {
			setIsSavingAI(false);
		}
	};

	// Test AI Connection
	const handleTestAI = async () => {
		if (!aiEndpoint.trim()) {
			toastManager.add({ title: t("settings.aiEndpointPlaceholder"), variant: "error" });
			return;
		}

		setIsTestingAI(true);
		setTestResult(null);
		try {
			const res = await api.testAIConnection({
				endpoint: aiEndpoint.trim(),
				apiKey: aiApiKey.trim() || undefined,
				model: aiModel.trim() || "gpt-4o-mini",
			});
			setTestResult(res);
			if (res.success) {
				toastManager.add({ title: t("settings.testSuccess") });
			} else {
				toastManager.add({ title: res.message, variant: "error" });
			}
		} catch (e: any) {
			const msg = e?.message || "Test failed";
			setTestResult({ success: false, message: msg });
			toastManager.add({ title: msg, variant: "error" });
		} finally {
			setIsTestingAI(false);
		}
	};

	// Create New Alias / Mailbox
	const handleCreateAlias = async (e: React.FormEvent) => {
		e.preventDefault();
		setAliasError(null);
		if (!newPrefix.trim() || !selectedDomain) {
			setAliasError("Please specify address prefix and domain.");
			return;
		}

		const fullEmail = `${newPrefix.trim().toLowerCase()}@${selectedDomain}`;
		const name = newAliasName.trim() || newPrefix.trim();

		setIsCreatingAlias(true);
		try {
			await createMailboxMutation.mutateAsync({ email: fullEmail, name });
			toastManager.add({ title: `${t("common.success")}: ${fullEmail}` });
			setIsAddAliasOpen(false);
			setNewPrefix("");
			setNewAliasName("");
			queryClient.invalidateQueries({ queryKey: queryKeys.mailboxes.all });
		} catch (err: any) {
			setAliasError(err?.message || "Failed to create alias.");
		} finally {
			setIsCreatingAlias(false);
		}
	};

	if (!mailbox) {
		return (
			<div className="flex justify-center py-20">
				<Loader size="lg" />
			</div>
		);
	}

	const isCustomPrompt = agentPrompt.trim().length > 0;
	const user = userSettings?.user;
	const aiInfo = userSettings?.ai;

	return (
		<div className="max-w-3xl px-4 py-4 md:px-8 md:py-6 h-full overflow-y-auto space-y-6">
			<div className="flex items-center justify-between">
				<div>
					<h1 className="text-xl font-bold text-kumo-default">{t("settings.title")}</h1>
					<p className="text-xs text-kumo-subtle mt-0.5">
						{t("settings.subtitle")}
					</p>
				</div>
			</div>

			{/* 0. Language Settings */}
			<div className="rounded-xl border border-kumo-line bg-kumo-base p-5">
				<div className="flex items-center justify-between mb-2">
					<div className="flex items-center gap-2">
						<TranslateIcon size={18} weight="duotone" className="text-kumo-subtle" />
						<span className="text-sm font-semibold text-kumo-default">
							{t("settings.languageTitle")}
						</span>
					</div>
				</div>
				<p className="text-xs text-kumo-subtle mb-4">
					{t("settings.languageDesc")}
				</p>
				<div className="flex items-center gap-3">
					{languages.map((lang) => (
						<Button
							key={lang.code}
							variant={language === lang.code ? "primary" : "secondary"}
							size="sm"
							onClick={() => setLanguage(lang.code)}
						>
							{lang.label}
						</Button>
					))}
				</div>
			</div>

			{/* 1. Account & OAuth Identity */}
			<div className="rounded-xl border border-kumo-line bg-kumo-base p-5">
				<div className="flex items-center gap-2 mb-4">
					<UserIcon size={18} weight="duotone" className="text-kumo-subtle" />
					<span className="text-sm font-semibold text-kumo-default">
						{t("settings.accountTitle")}
					</span>
				</div>
				<div className="grid grid-cols-1 md:grid-cols-3 gap-4">
					<div>
						<label className="text-xs font-medium text-kumo-subtle block mb-1">{t("settings.userName")}</label>
						<div className="text-sm font-medium text-kumo-default">{user?.name || "Admin"}</div>
					</div>
					<div>
						<label className="text-xs font-medium text-kumo-subtle block mb-1">{t("settings.profileEmail")}</label>
						<div className="text-sm font-mono text-kumo-default">{user?.email || "loading..."}</div>
					</div>
					<div>
						<label className="text-xs font-medium text-kumo-subtle block mb-1">{t("settings.authRole")}</label>
						<div>
							<Badge variant="primary">{user?.role || "Admin"}</Badge>
						</div>
					</div>
				</div>
			</div>

			{/* 2. Custom AI Provider Configuration */}
			<div className="rounded-xl border border-kumo-line bg-kumo-base p-5">
				<div className="flex items-center justify-between mb-4">
					<div className="flex items-center gap-2">
						<CpuIcon size={18} weight="duotone" className="text-kumo-subtle" />
						<span className="text-sm font-semibold text-kumo-default">
							{t("settings.aiTitle")}
						</span>
						{aiInfo?.endpoint ? (
							<Badge variant="primary">{t("settings.aiConfigured")}</Badge>
						) : (
							<Badge variant="secondary">{t("settings.aiNotConfigured")}</Badge>
						)}
					</div>
				</div>
				<p className="text-xs text-kumo-subtle mb-4">
					{t("settings.aiDesc")}
				</p>

				<div className="space-y-4">
					<div>
						<Input
							label={t("settings.aiEndpoint")}
							placeholder={t("settings.aiEndpointPlaceholder")}
							value={aiEndpoint}
							onChange={(e) => setAiEndpoint(e.target.value)}
						/>
						<p className="text-[11px] text-kumo-subtle mt-1">
							{t("settings.aiEndpointHint")}
						</p>
					</div>

					<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
						<div>
							<Input
								label={t("settings.apiKey")}
								type="password"
								placeholder={aiInfo?.hasKey ? t("settings.apiKeySaved", { masked: aiInfo.maskedKey || "" }) : t("settings.apiKeyPlaceholder")}
								value={aiApiKey}
								onChange={(e) => setAiApiKey(e.target.value)}
							/>
							<p className="text-[11px] text-kumo-subtle mt-1">
								{t("settings.apiKeyHint")}
							</p>
						</div>

						<div>
							<Input
								label={t("settings.modelName")}
								placeholder={t("settings.modelPlaceholder")}
								value={aiModel}
								onChange={(e) => setAiModel(e.target.value)}
							/>
						</div>
					</div>

					{testResult && (
						<div
							className={`rounded-lg p-3 text-xs flex items-start gap-2.5 ${
								testResult.success
									? "bg-emerald-500/10 border border-emerald-500/20 text-emerald-400"
									: "bg-red-500/10 border border-red-500/20 text-red-400"
							}`}
						>
							{testResult.success ? (
								<CheckCircleIcon size={16} className="shrink-0 mt-0.5" />
							) : (
								<WarningCircleIcon size={16} className="shrink-0 mt-0.5" />
							)}
							<div className="break-all">{testResult.message}</div>
						</div>
					)}

					<div className="flex items-center justify-end gap-2 pt-2">
						<Button
							variant="secondary"
							size="sm"
							onClick={handleTestAI}
							loading={isTestingAI}
						>
							{t("settings.testConnection")}
						</Button>
						<Button
							variant="primary"
							size="sm"
							onClick={handleSaveAI}
							loading={isSavingAI}
						>
							{t("settings.saveAi")}
						</Button>
					</div>
				</div>
			</div>

			{/* 3. Mailbox Aliases Management */}
			<div className="rounded-xl border border-kumo-line bg-kumo-base p-5">
				<div className="flex items-center justify-between mb-4">
					<div className="flex items-center gap-2">
						<EnvelopeIcon size={18} weight="duotone" className="text-kumo-subtle" />
						<span className="text-sm font-semibold text-kumo-default">
							{t("settings.aliasesTitle")}
						</span>
						<Badge variant="secondary">{mailboxes.length}</Badge>
					</div>
					<Button
						variant="secondary"
						size="xs"
						icon={<PlusIcon size={14} />}
						onClick={() => setIsAddAliasOpen(true)}
					>
						{t("settings.addAlias")}
					</Button>
				</div>
				<p className="text-xs text-kumo-subtle mb-4">
					{t("settings.aliasesDesc")}
				</p>

				<div className="divide-y divide-kumo-line rounded-lg border border-kumo-line overflow-hidden">
					{mailboxes.map((m) => {
						const isCurrent = m.id.toLowerCase() === mailboxId?.toLowerCase();
						return (
							<div
								key={m.id}
								className={`flex items-center justify-between p-3 transition-colors ${
									isCurrent ? "bg-kumo-tint" : "hover:bg-kumo-tint/50"
								}`}
							>
								<div className="min-w-0 flex-1">
									<div className="flex items-center gap-2">
										<span className="text-sm font-medium text-kumo-default truncate">
											{m.name}
										</span>
										{m.isDefault && <Badge variant="primary">{t("common.default")}</Badge>}
										{isCurrent && <Badge variant="secondary">{t("common.active")}</Badge>}
									</div>
									<div className="text-xs text-kumo-subtle font-mono mt-0.5">
										{m.email}
									</div>
								</div>

								<div className="flex items-center gap-2">
									{!isCurrent && (
										<Button
											variant="ghost"
											size="xs"
											onClick={() => navigate(`/mailbox/${encodeURIComponent(m.id)}/emails/inbox`)}
										>
											{t("common.switch")}
										</Button>
									)}
								</div>
							</div>
						);
					})}
				</div>
			</div>

			{/* 4. Active Mailbox Settings & Agent Prompt */}
			<div className="rounded-xl border border-kumo-line bg-kumo-base p-5">
				<div className="flex items-center gap-2 mb-4">
					<RobotIcon size={18} weight="duotone" className="text-kumo-subtle" />
					<span className="text-sm font-semibold text-kumo-default">
						{t("settings.activeMailboxTitle", { email: mailbox.email })}
					</span>
				</div>

				<div className="space-y-4">
					<div>
						<Input
							label={t("settings.fromName")}
							value={displayName}
							onChange={(e) => setDisplayName(e.target.value)}
							placeholder={t("settings.fromNamePlaceholder")}
						/>
					</div>

					<div>
						<div className="flex items-center justify-between mb-2">
							<span className="text-xs font-medium text-kumo-default">
								{t("settings.agentSystemPrompt")}
							</span>
							{isCustomPrompt && (
								<Button
									variant="ghost"
									size="xs"
									icon={<ArrowCounterClockwiseIcon size={14} />}
									onClick={() => setAgentPrompt("")}
								>
									{t("settings.resetDefault")}
								</Button>
							)}
						</div>
						<textarea
							value={agentPrompt}
							onChange={(e) => setAgentPrompt(e.target.value)}
							placeholder={PROMPT_PLACEHOLDER}
							rows={8}
							className="w-full resize-y rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2 text-xs text-kumo-default placeholder:text-kumo-subtle focus:outline-none focus:ring-1 focus:ring-kumo-ring font-mono leading-relaxed"
						/>
					</div>

					<div className="flex justify-end pt-2">
						<Button
							variant="primary"
							size="sm"
							onClick={handleSaveMailbox}
							loading={isSavingMailbox}
						>
							{t("settings.saveMailbox")}
						</Button>
					</div>
				</div>
			</div>

			{/* Add Alias Dialog */}
			<Dialog.Root open={isAddAliasOpen} onOpenChange={setIsAddAliasOpen}>
				<Dialog size="sm" className="p-6">
					<Dialog.Title className="text-base font-semibold mb-4">
						{t("settings.addAlias")}
					</Dialog.Title>
					<form onSubmit={handleCreateAlias} className="space-y-4">
						{aliasError && (
							<div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded p-2.5">
								{aliasError}
							</div>
						)}

						<div>
							<span className="text-xs font-medium text-kumo-default mb-1.5 block">
								{t("home.emailAddress")}
							</span>
							<div className="flex items-center gap-2">
								<div className="flex-1">
									<Input
										placeholder={t("home.emailPrefixPlaceholder")}
										size="sm"
										value={newPrefix}
										onChange={(e) => setNewPrefix(e.target.value)}
										required
									/>
								</div>
								<span className="text-sm text-kumo-subtle">@</span>
								{domains.length > 1 ? (
									<div className="flex-1">
										<Select
											value={selectedDomain}
											onValueChange={(val) => val && setSelectedDomain(val)}
										>
											{domains.map((d) => (
												<Select.Option key={d} value={d}>
													{d}
												</Select.Option>
											))}
										</Select>
									</div>
								) : (
									<span className="text-xs font-mono text-kumo-subtle">
										{selectedDomain || "domain"}
									</span>
								)}
							</div>
						</div>

						<Input
							label={t("home.displayNameOptional")}
							placeholder={t("home.displayNamePlaceholder")}
							size="sm"
							value={newAliasName}
							onChange={(e) => setNewAliasName(e.target.value)}
						/>

						<div className="flex justify-end gap-2 pt-2">
							<Dialog.Close
								render={(props) => (
									<Button {...props} variant="secondary" size="sm">
										{t("common.cancel")}
									</Button>
								)}
							/>
							<Button
								type="submit"
								variant="primary"
								size="sm"
								loading={isCreatingAlias}
								disabled={!selectedDomain || !newPrefix.trim()}
							>
								{t("common.create")}
							</Button>
						</div>
					</form>
				</Dialog>
			</Dialog.Root>
		</div>
	);
}
