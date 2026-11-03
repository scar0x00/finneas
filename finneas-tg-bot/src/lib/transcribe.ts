import type { Env } from "../index";
import { arrayBufferToBase64 } from "./arrayBufferToBase64";
import { log, since, type LogFields } from "./log";

type transcribeVoiceParams = {
    audio: ArrayBuffer | string;
    env: Env;
    logFields?: LogFields;
};

type transcriptionAPIResponse = {
    text: string;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cost?: number };
};

const STT_MODEL = "openai/whisper-large-v3-turbo";

export async function transcribe({
    audio,
    env,
    logFields = {},
}: transcribeVoiceParams) {
    let base64Audio;
    if (typeof audio === "string") {
        base64Audio = audio;
    } else {
        base64Audio = arrayBufferToBase64(audio);
    }

    const start = Date.now();
    const response = await fetch(
        "https://openrouter.ai/api/v1/audio/transcriptions",
        {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${env.OPENROUTER_API_KEY}`,
                "Content-Type": "application/json",
                "HTTP-Referer": "https://finneas.dev",
                "X-OpenRouter-Title": "Finneas", // Optional. Site title for rankings on openrouter.ai.
            },
            body: JSON.stringify({
                model: STT_MODEL,
                input_audio: {
                    data: base64Audio,
                    format: "ogg",
                },
            }),
        },
    );
    const result = await response.json() as transcriptionAPIResponse;
    log("model.call", {
        ...logFields,
        kind: "transcription",
        model: STT_MODEL,
        status: response.status,
        duration_ms: since(start),
        audio_bytes: base64Audio.length,
        prompt_tokens: result?.usage?.prompt_tokens,
        completion_tokens: result?.usage?.completion_tokens,
        cost: result?.usage?.cost,
    });
    if (!result?.text) {
        throw new Error("Transcription result is malformed.");
    }
    return result.text;
}
