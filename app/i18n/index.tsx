// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import React, { createContext, useContext, useEffect, useState, useMemo } from "react";
import { en } from "./locales/en";
import { zhCN } from "./locales/zh-CN";

export type Language = "en" | "zh-CN";

export interface LanguageOption {
	code: Language;
	label: string;
}

export const LANGUAGES: LanguageOption[] = [
	{ code: "zh-CN", label: "简体中文" },
	{ code: "en", label: "English" },
];

const dictionaries: Record<Language, typeof en> = {
	en,
	"zh-CN": zhCN,
};

interface I18nContextType {
	language: Language;
	setLanguage: (lang: Language) => void;
	t: (path: string, params?: Record<string, string | number>) => string;
	languages: LanguageOption[];
}

const I18nContext = createContext<I18nContextType | null>(null);

const STORAGE_KEY = "agentic_inbox_language";

function getInitialLanguage(): Language {
	if (typeof window !== "undefined") {
		const saved = localStorage.getItem(STORAGE_KEY) as Language | null;
		if (saved && (saved === "en" || saved === "zh-CN")) {
			return saved;
		}
		const browserLang = navigator.language.toLowerCase();
		if (browserLang.startsWith("zh")) {
			return "zh-CN";
		}
	}
	return "zh-CN"; // Default to Chinese as requested
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
	const [language, setLanguageState] = useState<Language>(getInitialLanguage);

	useEffect(() => {
		if (typeof window !== "undefined") {
			const saved = localStorage.getItem(STORAGE_KEY) as Language | null;
			if (saved && (saved === "en" || saved === "zh-CN")) {
				setLanguageState(saved);
			}
		}
	}, []);

	const setLanguage = (lang: Language) => {
		setLanguageState(lang);
		if (typeof window !== "undefined") {
			localStorage.setItem(STORAGE_KEY, lang);
		}
	};

	const t = useMemo(() => {
		const dict = dictionaries[language] || dictionaries["zh-CN"];

		return (path: string, params?: Record<string, string | number>): string => {
			const keys = path.split(".");
			let current: any = dict;

			for (const key of keys) {
				if (current && typeof current === "object" && key in current) {
					current = current[key];
				} else {
					// Fallback to English if missing in current dictionary
					let fallback: any = dictionaries.en;
					for (const fbKey of keys) {
						if (fallback && typeof fallback === "object" && fbKey in fallback) {
							fallback = fallback[fbKey];
						} else {
							fallback = path;
							break;
						}
					}
					current = fallback;
					break;
				}
			}

			let result = typeof current === "string" ? current : path;
			if (params) {
				for (const [paramKey, paramVal] of Object.entries(params)) {
					result = result.replace(new RegExp(`\\{${paramKey}\\}`, "g"), String(paramVal));
				}
			}
			return result;
		};
	}, [language]);

	return (
		<I18nContext.Provider value={{ language, setLanguage, t, languages: LANGUAGES }}>
			{children}
		</I18nContext.Provider>
	);
}

export function useI18n() {
	const ctx = useContext(I18nContext);
	if (!ctx) {
		// Safe fallback if used outside provider
		return {
			language: "zh-CN" as Language,
			setLanguage: () => {},
			t: (path: string) => path,
			languages: LANGUAGES,
		};
	}
	return ctx;
}
