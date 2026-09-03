// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Env } from "../types";

export interface StoredAttachment {
	id: string;
	email_id: string;
	filename: string;
	mimetype: string;
	size: number;
	content_id: string | null;
	disposition: string;
	storage_key: string;
}

/**
 * Store base64-encoded or raw attachments to R2 and return metadata for D1.
 */
export async function storeAttachments(
	bucket: Env["BUCKET"],
	emailId: string,
	attachments?: {
		content: string | Uint8Array | ArrayBuffer;
		filename: string;
		type: string;
		disposition: string;
		contentId?: string;
	}[],
): Promise<StoredAttachment[]> {
	if (!attachments?.length) return [];

	const results: StoredAttachment[] = [];
	for (const att of attachments) {
		const attachmentId = crypto.randomUUID();
		const safeFilename = (att.filename || "untitled").replace(/[\/\\:*?"<>|\x00-\x1f]/g, "_");
		const key = `attachments/${emailId}/${attachmentId}/${safeFilename}`;

		let bytes: Uint8Array;
		if (typeof att.content === "string") {
			const binaryStr = atob(att.content);
			bytes = Uint8Array.from(binaryStr, (c) => c.charCodeAt(0));
		} else if (att.content instanceof Uint8Array) {
			bytes = att.content;
		} else {
			bytes = new Uint8Array(att.content);
		}

		await bucket.put(key, bytes);
		results.push({
			id: attachmentId,
			email_id: emailId,
			filename: safeFilename,
			mimetype: att.type,
			size: bytes.byteLength,
			content_id: att.contentId || null,
			disposition: att.disposition || "attachment",
			storage_key: key,
		});
	}
	return results;
}
