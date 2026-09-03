// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, Loader, Tooltip } from "@cloudflare/kumo";
import {
	ArrowUpIcon,
	RobotIcon,
	TrashIcon,
	UserIcon,
	EnvelopeSimpleIcon,
	MagnifyingGlassIcon,
	PaperPlaneTiltIcon,
	EyeIcon,
	ArrowBendUpLeftIcon,
	WrenchIcon,
	CheckCircleIcon,
	GearSixIcon,
} from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useUIStore } from "~/hooks/useUIStore";
import api from "~/services/api";
import { useI18n } from "~/i18n";

interface ChatMessage {
	id: string;
	role: "user" | "assistant" | "tool";
	content: string;
	tool_calls?: any[];
	name?: string;
}

export default function AgentPanel() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const navigate = useNavigate();
	const { t } = useI18n();
	const scrollRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const [inputValue, setInputValue] = useState("");
	const [isLoading, setIsLoading] = useState(false);
	const [messages, setMessages] = useState<ChatMessage[]>([]);

	// Load chat history from localStorage per mailbox
	useEffect(() => {
		if (!mailboxId) return;
		try {
			const saved = localStorage.getItem(`agent_chat_${mailboxId}`);
			if (saved) {
				setMessages(JSON.parse(saved));
			} else {
				setMessages([]);
			}
		} catch {}
	}, [mailboxId]);

	// Save chat history
	useEffect(() => {
		if (!mailboxId || messages.length === 0) return;
		try {
			localStorage.setItem(`agent_chat_${mailboxId}`, JSON.stringify(messages));
		} catch {}
	}, [mailboxId, messages]);

	useEffect(() => {
		const el = scrollRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [messages, isLoading]);

	const handleSend = async (textToSend?: string) => {
		const text = (textToSend || inputValue).trim();
		if (!text || !mailboxId || isLoading) return;

		setInputValue("");
		if (inputRef.current) inputRef.current.style.height = "auto";

		const userMsg: ChatMessage = {
			id: crypto.randomUUID(),
			role: "user",
			content: text,
		};

		const nextHistory = [...messages, userMsg];
		setMessages(nextHistory);
		setIsLoading(true);

		try {
			const payload = nextHistory.map((m) => ({
				role: m.role,
				content: m.content,
			}));

			const res = await api.agentChat(mailboxId, payload);
			if (res.messages && res.messages.length > 0) {
				const formatted = res.messages.map((m: any, idx: number) => ({
					id: `msg-${Date.now()}-${idx}`,
					role: m.role,
					content: m.content || "",
				}));
				setMessages(formatted);
			}
		} catch (err: any) {
			setMessages((prev) => [
				...prev,
				{
					id: crypto.randomUUID(),
					role: "assistant",
					content: `⚠️ Failed to get response from AI provider: ${err?.message || err}`,
				},
			]);
		} finally {
			setIsLoading(false);
		}
	};

	const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			handleSend();
		}
	};

	const handleClearChat = () => {
		if (window.confirm(t("agent.clearHistory"))) {
			setMessages([]);
			if (mailboxId) {
				localStorage.removeItem(`agent_chat_${mailboxId}`);
			}
		}
	};

	const suggestedPrompts = [
		t("agent.suggestLatest"),
		t("agent.suggestUnread"),
		t("agent.suggestDraft"),
	];

	return (
		<div className="flex flex-col h-full bg-kumo-base">
			{/* Header */}
			<div className="flex items-center justify-between px-3 py-2 border-b border-kumo-line shrink-0">
				<div className="flex items-center gap-2">
					<Badge variant="primary">{t("agent.badge")}</Badge>
					<span className="text-xs font-medium text-kumo-default">{t("agent.title")}</span>
				</div>
				<div className="flex items-center gap-1">
					<Tooltip content={t("settings.aiTitle")} asChild>
						<Button
							variant="ghost"
							shape="square"
							size="sm"
							icon={<GearSixIcon size={15} />}
							onClick={() => navigate(`/mailbox/${mailboxId}/settings`)}
							aria-label={t("nav.settings")}
						/>
					</Tooltip>
					{messages.length > 0 && (
						<Tooltip content={t("agent.clearChat")} asChild>
							<Button
								variant="ghost"
								shape="square"
								size="sm"
								icon={<TrashIcon size={15} />}
								onClick={handleClearChat}
								aria-label={t("agent.clearChat")}
							/>
						</Tooltip>
					)}
				</div>
			</div>

			{/* Messages View */}
			<div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-4 space-y-3">
				{messages.length === 0 ? (
					<div className="flex flex-col items-center justify-center h-full gap-4 text-center px-4">
						<div className="flex h-12 w-12 items-center justify-center rounded-xl bg-kumo-fill text-kumo-default shadow-sm">
							<RobotIcon size={24} weight="duotone" />
						</div>
						<div>
							<h4 className="text-sm font-semibold text-kumo-default">{t("agent.title")}</h4>
							<p className="text-xs text-kumo-subtle mt-1 leading-relaxed">
								{t("agent.subtitle")}
							</p>
						</div>

						<div className="flex flex-col gap-1.5 w-full pt-2">
							{suggestedPrompts.map((prompt) => (
								<button
									key={prompt}
									type="button"
									onClick={() => handleSend(prompt)}
									className="text-left px-3 py-2 rounded-lg border border-kumo-line text-xs text-kumo-strong hover:bg-kumo-tint transition-colors cursor-pointer bg-transparent"
								>
									{prompt}
								</button>
							))}
						</div>
					</div>
				) : (
					messages.map((msg) => {
						const isUser = msg.role === "user";
						return (
							<div
								key={msg.id}
								className={`flex gap-2 ${isUser ? "flex-row-reverse" : "flex-row"}`}
							>
								<div
									className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
										isUser
											? "bg-kumo-brand text-kumo-inverse"
											: "bg-kumo-fill text-kumo-default"
									}`}
								>
									{isUser ? <UserIcon size={12} weight="bold" /> : <RobotIcon size={12} weight="bold" />}
								</div>

								<div
									className={`flex flex-col gap-1 max-w-[85%] min-w-0 ${
										isUser ? "items-end" : "items-start"
									}`}
								>
									<div
										className={`rounded-lg px-3 py-2 text-[13px] leading-relaxed break-words overflow-hidden ${
											isUser
												? "bg-kumo-brand text-kumo-inverse rounded-br-sm"
												: "bg-kumo-elevated text-kumo-default border border-kumo-line rounded-bl-sm"
										}`}
									>
										{isUser ? (
											msg.content
										) : (
											<Markdown
												remarkPlugins={[remarkGfm]}
												components={{
													a: ({ href, children }) => (
														<a
															href={href}
															target="_blank"
															rel="noopener noreferrer"
															className="text-kumo-brand underline"
														>
															{children}
														</a>
													),
													p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
													strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
													ul: ({ children }) => <ul className="list-disc pl-4 mb-2 last:mb-0 space-y-0.5">{children}</ul>,
													ol: ({ children }) => <ol className="list-decimal pl-4 mb-2 last:mb-0 space-y-0.5">{children}</ol>,
													li: ({ children }) => <li>{children}</li>,
													code: ({ children }) => <code className="bg-kumo-fill px-1 py-0.5 rounded text-[12px]">{children}</code>,
												}}
											>
												{msg.content}
											</Markdown>
										)}
									</div>
								</div>
							</div>
						);
					})
				)}

				{isLoading && (
					<div className="flex gap-2">
						<div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-kumo-fill text-kumo-default">
							<RobotIcon size={12} weight="bold" />
						</div>
						<div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-kumo-elevated border border-kumo-line rounded-bl-sm">
							<Loader size="sm" />
							<span className="text-xs text-kumo-subtle">{t("agent.thinking")}</span>
						</div>
					</div>
				)}
			</div>

			{/* Input Box */}
			<div className="shrink-0 border-t border-kumo-line px-3 py-2">
				<div className="flex items-end gap-1.5">
					<textarea
						ref={inputRef}
						value={inputValue}
						onChange={(e) => setInputValue(e.target.value)}
						onKeyDown={handleKeyDown}
						placeholder={t("agent.inputPlaceholder")}
						rows={1}
						disabled={isLoading}
						className="flex-1 resize-none rounded-lg border border-kumo-line bg-kumo-control px-3 py-2 text-xs text-kumo-default placeholder:text-kumo-subtle focus:outline-none focus:ring-1 focus:ring-kumo-ring min-h-[36px] max-h-[100px]"
					/>
					<Button
						variant="primary"
						shape="square"
						size="sm"
						disabled={!inputValue.trim() || isLoading}
						icon={<ArrowUpIcon size={14} weight="bold" />}
						onClick={() => handleSend()}
						aria-label={t("common.send")}
					/>
				</div>
			</div>
		</div>
	);
}
