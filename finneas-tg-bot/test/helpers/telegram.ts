import type { Update } from "grammy/types";
import { jsonResponse, type FetchMock, type RecordedCall } from "./fetchMock";
import { TEST_BOT_ID } from "./bindings";

export const ALLOWED_USER_ID = 1001;
export const STRANGER_USER_ID = 666;

let nextUpdateId = 10_000;
let nextMessageId = 1;

/** Returns a fresh, unique update id. */
export function newUpdateId(): number {
	return nextUpdateId++;
}

function baseMessage(chatId: number, userId: number) {
	return {
		message_id: nextMessageId++,
		date: Math.floor(Date.now() / 1000),
		chat: { id: chatId, type: "private" as const, first_name: "Tester" },
		from: { id: userId, is_bot: false, first_name: "Tester" },
	};
}

export function textUpdate(text: string, opts: { chatId?: number; userId?: number; updateId?: number } = {}): Update {
	const userId = opts.userId ?? ALLOWED_USER_ID;
	const chatId = opts.chatId ?? userId;
	const message: any = { ...baseMessage(chatId, userId), text };
	if (text.startsWith("/")) {
		const cmd = text.split(/\s/)[0];
		message.entities = [{ type: "bot_command", offset: 0, length: cmd.length }];
	}
	return { update_id: opts.updateId ?? newUpdateId(), message } as Update;
}

export function voiceUpdate(opts: { chatId?: number; userId?: number; updateId?: number; duration?: number; fileSize?: number } = {}): Update {
	const userId = opts.userId ?? ALLOWED_USER_ID;
	const chatId = opts.chatId ?? userId;
	return {
		update_id: opts.updateId ?? newUpdateId(),
		message: {
			...baseMessage(chatId, userId),
			voice: {
				file_id: "voice-file-id",
				file_unique_id: "voice-unique",
				duration: opts.duration ?? 5,
				mime_type: "audio/ogg",
				file_size: opts.fileSize ?? 2048,
			},
		},
	} as Update;
}

export function photoUpdate(opts: { chatId?: number; userId?: number; updateId?: number; fileSize?: number } = {}): Update {
	const userId = opts.userId ?? ALLOWED_USER_ID;
	const chatId = opts.chatId ?? userId;
	return {
		update_id: opts.updateId ?? newUpdateId(),
		message: {
			...baseMessage(chatId, userId),
			photo: [
				{ file_id: "small", file_unique_id: "s", width: 90, height: 160, file_size: 1000 },
				{ file_id: "photo-file-id", file_unique_id: "l", width: 720, height: 1280, file_size: opts.fileSize ?? 50_000 },
			],
		},
	} as Update;
}

export function editedMessageUpdate(text: string, opts: { userId?: number } = {}): Update {
	const userId = opts.userId ?? ALLOWED_USER_ID;
	return {
		update_id: newUpdateId(),
		edited_message: { ...baseMessage(userId, userId), text, edit_date: Math.floor(Date.now() / 1000) },
	} as Update;
}

export function callbackQueryUpdate(data: string, opts: { userId?: number; chatId?: number; messageId?: number } = {}): Update {
	const userId = opts.userId ?? ALLOWED_USER_ID;
	const chatId = opts.chatId ?? userId;
	return {
		update_id: newUpdateId(),
		callback_query: {
			id: `cbq-${nextMessageId++}`,
			from: { id: userId, is_bot: false, first_name: "Tester" },
			chat_instance: "ci",
			data,
			message: {
				message_id: opts.messageId ?? 42,
				date: Math.floor(Date.now() / 1000),
				chat: { id: chatId, type: "private", first_name: "Tester" },
				from: { id: TEST_BOT_ID, is_bot: true, first_name: "Finneas Test" },
				text: "receipt",
			},
		},
	} as Update;
}

/** The Bot API method name of a recorded call to api.telegram.org (e.g. "sendMessage"). */
export function telegramMethod(call: RecordedCall): string {
	return call.url.pathname.split("/").pop() ?? "";
}

/** Recorded Bot API calls, optionally filtered by method. */
export function telegramCalls(mock: FetchMock, method?: string): RecordedCall[] {
	return mock
		.callsTo("api.telegram.org")
		.filter((c) => c.url.pathname.startsWith("/bot"))
		.filter((c) => !method || telegramMethod(c) === method);
}

/** Text of every `sendMessage`, in order. */
export function sentTexts(mock: FetchMock): string[] {
	return telegramCalls(mock, "sendMessage").map((c) => c.json().text);
}

/**
 * Answers every Bot API method with a plausible success response, and serves
 * files from `/file/bot<token>/...` with `fileBody`.
 */
export function mockTelegram(mock: FetchMock, opts: { fileBody?: Uint8Array } = {}): FetchMock {
	let sentId = 5000;
	mock.on("api.telegram.org", /^\/bot[^/]+\/[A-Za-z]+$/, (call) => {
		const method = telegramMethod(call);
		const body = call.bodyText ? call.json() : {};
		switch (method) {
			case "getFile":
				return jsonResponse({ ok: true, result: { file_id: body.file_id, file_unique_id: "u", file_size: 1234, file_path: `files/${body.file_id}.bin` } });
			case "sendMessage":
				return jsonResponse({
					ok: true,
					result: { message_id: sentId++, date: 0, chat: { id: body.chat_id, type: "private" }, text: body.text },
				});
			case "editMessageText":
				return jsonResponse({ ok: true, result: { message_id: body.message_id, date: 0, chat: { id: body.chat_id, type: "private" }, text: body.text } });
			default:
				return jsonResponse({ ok: true, result: true });
		}
	});
	mock.on("api.telegram.org", /^\/file\/bot/, () => new Response(opts.fileBody ?? new Uint8Array([1, 2, 3, 4])));
	return mock;
}
