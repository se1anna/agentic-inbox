// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	Button,
	Dialog,
	Input,
	Loader,
	Select,
	Text,
	Badge,
	useKumoToastManager,
} from "@cloudflare/kumo";
import { EnvelopeIcon, PlusIcon, TrashIcon, SignOutIcon, UserIcon, ShieldCheckIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import { Link as RouterLink, useNavigate } from "react-router";
import api from "~/services/api";
import {
	useCreateMailbox,
	useDeleteMailbox,
	useMailboxes,
} from "~/queries/mailboxes";
import { queryKeys } from "~/queries/keys";
import { useI18n } from "~/i18n";

export function meta() {
	return [{ title: "My Mailboxes - Agentic Mailbox" }];
}

export default function HomeRoute() {
	const toastManager = useKumoToastManager();
	const navigate = useNavigate();
	const { t } = useI18n();
	const { data: mailboxes = [], refetch: refetchMailboxes, isLoading: mailboxesLoading } = useMailboxes();
	const createMailbox = useCreateMailbox();
	const deleteMailbox = useDeleteMailbox();

	// Fetch current authenticated user info
	const { data: authData } = useQuery({
		queryKey: ["authMe"],
		queryFn: () => api.getAuthMe(),
	});

	const { data: configData } = useQuery({
		queryKey: queryKeys.config,
		queryFn: () => api.getConfig(),
		staleTime: Infinity,
	});

	const domains = configData?.domains ?? [];

	const [isCreateOpen, setIsCreateOpen] = useState(false);
	const [newPrefix, setNewPrefix] = useState("");
	const [selectedDomain, setSelectedDomain] = useState("");
	const [newName, setNewName] = useState("");
	const [isCreating, setIsCreating] = useState(false);
	const [createError, setCreateError] = useState<string | null>(null);

	const [isDeleteOpen, setIsDeleteOpen] = useState(false);
	const [mailboxToDelete, setMailboxToDelete] = useState<{
		id: string;
		email: string;
	} | null>(null);
	const [isDeleting, setIsDeleting] = useState(false);

	useEffect(() => {
		if (domains.length > 0 && !selectedDomain) {
			setSelectedDomain(domains[0]);
		}
	}, [domains, selectedDomain]);

	const handleCreate = async (e: FormEvent) => {
		e.preventDefault();
		setCreateError(null);
		if (!newPrefix || !selectedDomain) {
			setCreateError(t("home.emailPrefixPlaceholder"));
			return;
		}
		const email = `${newPrefix.trim().toLowerCase()}@${selectedDomain}`;
		const name = newName.trim() || newPrefix.trim();
		setIsCreating(true);
		try {
			await createMailbox.mutateAsync({ email, name });
			toastManager.add({ title: `${t("common.success")}: ${email}` });
			setIsCreateOpen(false);
			setNewPrefix("");
			setNewName("");
			refetchMailboxes();
		} catch (err: unknown) {
			const message = (err instanceof Error ? err.message : null) || t("common.error");
			setCreateError(message);
		} finally {
			setIsCreating(false);
		}
	};

	const handleDelete = async () => {
		if (!mailboxToDelete) return;
		setIsDeleting(true);
		try {
			await deleteMailbox.mutateAsync(mailboxToDelete.id);
			toastManager.add({ title: t("common.delete") });
			setIsDeleteOpen(false);
			setMailboxToDelete(null);
			refetchMailboxes();
		} catch {
			toastManager.add({ title: t("common.error"), variant: "error" });
		} finally {
			setIsDeleting(false);
		}
	};

	const handleLogout = async () => {
		try {
			await api.logout();
			window.location.href = "/login";
		} catch {
			window.location.href = "/login";
		}
	};

	const user = authData?.user;

	return (
		<div className="min-h-screen bg-kumo-recessed">
			<div className="mx-auto max-w-3xl px-4 py-8 md:px-6 md:py-12">
				{/* Top bar with User Profile and Logout */}
				<div className="flex items-center justify-between pb-6 mb-8 border-b border-kumo-line">
					<div className="flex items-center gap-3">
						<div className="h-10 w-10 rounded-full bg-kumo-fill flex items-center justify-center text-kumo-default font-bold">
							<UserIcon size={20} weight="duotone" />
						</div>
						<div>
							<div className="text-sm font-semibold text-kumo-default flex items-center gap-2">
								{user?.name || "Admin"}
								<Badge variant="primary">
									<ShieldCheckIcon size={12} className="mr-1 inline" />
									{user?.role || "Admin"}
								</Badge>
							</div>
							<div className="text-xs text-kumo-subtle font-mono">{user?.email}</div>
						</div>
					</div>

					<Button
						variant="ghost"
						size="sm"
						icon={<SignOutIcon size={16} />}
						onClick={handleLogout}
					>
						{t("nav.signOut")}
					</Button>
				</div>

				<div className="mb-6">
					<div className="flex items-center justify-between">
						<div>
							<h1 className="text-2xl font-bold text-kumo-default">{t("home.title")}</h1>
							<p className="text-xs text-kumo-subtle mt-1">
								{t("home.subtitle")}
							</p>
						</div>
						<Button
							variant="primary"
							icon={<PlusIcon size={16} />}
							onClick={() => setIsCreateOpen(true)}
						>
							{t("home.newAlias")}
						</Button>
					</div>
				</div>

				{mailboxesLoading ? (
					<div className="flex justify-center py-20">
						<Loader size="lg" />
					</div>
				) : mailboxes.length > 0 ? (
					<div className="rounded-xl border border-kumo-line bg-kumo-base overflow-hidden divide-y divide-kumo-line">
						{mailboxes.map((account) => (
							<RouterLink
								key={account.id}
								to={`/mailbox/${encodeURIComponent(account.id)}/emails/inbox`}
								className="group flex items-center gap-4 px-5 py-4 no-underline transition-colors hover:bg-kumo-tint"
							>
								<div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-kumo-fill text-sm font-bold text-kumo-default">
									{account.name.charAt(0).toUpperCase()}
								</div>
								<div className="min-w-0 flex-1">
									<div className="flex items-center gap-2">
										<span className="text-sm font-medium text-kumo-default truncate">
											{account.name}
										</span>
										{account.isDefault && (
											<Badge variant="primary">{t("common.default")}</Badge>
										)}
									</div>
									<div className="text-xs text-kumo-subtle font-mono mt-0.5">
										{account.email}
									</div>
								</div>
								{!account.isDefault && (
									<Button
										variant="ghost"
										size="sm"
										shape="square"
										icon={<TrashIcon size={16} />}
										aria-label={`Delete mailbox ${account.email}`}
										onClick={(e) => {
											e.preventDefault();
											e.stopPropagation();
											setMailboxToDelete({
												id: account.id,
												email: account.email,
											});
											setIsDeleteOpen(true);
										}}
									/>
								)}
							</RouterLink>
						))}
					</div>
				) : (
					<div className="rounded-xl border border-kumo-line bg-kumo-base py-16 px-6">
						<div className="flex flex-col items-center text-center">
							<div className="mb-4">
								<EnvelopeIcon size={48} weight="thin" className="text-kumo-subtle" />
							</div>
							<h3 className="text-base font-semibold text-kumo-default mb-1.5">
								{t("home.noAliases")}
							</h3>
							<p className="text-sm text-kumo-subtle max-w-sm mb-5">
								{t("home.noAliasesDesc")}
							</p>
							<Button
								variant="primary"
								icon={<PlusIcon size={16} />}
								onClick={() => setIsCreateOpen(true)}
							>
								{t("home.createAliasBtn")}
							</Button>
						</div>
					</div>
				)}
			</div>

			{/* Create Dialog */}
			<Dialog.Root open={isCreateOpen} onOpenChange={setIsCreateOpen}>
				<Dialog size="sm" className="p-6">
					<Dialog.Title className="text-base font-semibold mb-4">
						{t("home.createDialogTitle")}
					</Dialog.Title>
					<form onSubmit={handleCreate} className="space-y-4">
						{createError && (
							<Text variant="error" size="sm">
								{createError}
							</Text>
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
										{selectedDomain || "no domain"}
									</span>
								)}
							</div>
						</div>
						<Input
							label={t("home.displayNameOptional")}
							placeholder={t("home.displayNamePlaceholder")}
							size="sm"
							value={newName}
							onChange={(e) => setNewName(e.target.value)}
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
								loading={isCreating}
								disabled={!selectedDomain || !newPrefix.trim()}
							>
								{t("common.create")}
							</Button>
						</div>
					</form>
				</Dialog>
			</Dialog.Root>

			{/* Delete Dialog */}
			<Dialog.Root
				open={isDeleteOpen}
				onOpenChange={(open) => {
					setIsDeleteOpen(open);
					if (!open) setMailboxToDelete(null);
				}}
			>
				<Dialog size="sm" className="p-6">
					<Dialog.Title className="text-base font-semibold mb-2">
						{t("home.deleteDialogTitle")}
					</Dialog.Title>
					<Dialog.Description className="text-kumo-subtle text-sm mb-5">
						{t("home.deleteDialogDesc", { email: mailboxToDelete?.email || "" })}
					</Dialog.Description>
					<div className="flex justify-end gap-2">
						<Dialog.Close
							render={(props) => (
								<Button {...props} variant="secondary" size="sm">
									{t("common.cancel")}
								</Button>
							)}
						/>
						<Button
							variant="destructive"
							size="sm"
							loading={isDeleting}
							onClick={handleDelete}
						>
							{t("common.delete")}
						</Button>
					</div>
				</Dialog>
			</Dialog.Root>
		</div>
	);
}
