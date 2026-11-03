import type { Env } from "../index";
import { arrayBufferToBase64 } from "./arrayBufferToBase64";
import { log, since, type LogFields } from "./log";
import { openrouterPost } from "./openrouterFetch";

type transcribeVoiceParams = {
	audio: ArrayBuffer | string;
	env: Env;
	logFields?: LogFields;
};

type transcriptionAPIResponse = {
	text?: string;
	usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cost?: number };
};

const STT_MODEL = "openai/whisper-large-v3-turbo";

/** Transcribes an OGG voice note. Returns "" when no speech was recognised. */
export async function transcribe({ audio, env, logFields = {} }: transcribeVoiceParams): Promise<string> {
	const base64Audio = typeof audio === "string" ? audio : arrayBufferToBase64(audio);
	const start = Date.now();
	let result: transcriptionAPIResponse;
	let status: number;
	try {
		({ data: result, status } = await openrouterPost<transcriptionAPIResponse>(
			"/audio/transcriptions",
			{ model: STT_MODEL, input_audio: { data: base64Audio, format: "ogg" } },
			env.OPENROUTER_API_KEY,
		));
	} catch (err) {
		log("model.call", { ...logFields, kind: "transcription", model: STT_MODEL, ok: false, duration_ms: since(start) });
		throw err;
	}
	log("model.call", {
		...logFields,
		kind: "transcription",
		model: STT_MODEL,
		status,
		duration_ms: since(start),
		audio_bytes: base64Audio.length,
		prompt_tokens: result?.usage?.prompt_tokens,
		completion_tokens: result?.usage?.completion_tokens,
		cost: result?.usage?.cost,
	});
	if (typeof result?.text !== "string") {
		throw new Error("Transcription result is malformed.");
	}
	return result.text.trim();
}
