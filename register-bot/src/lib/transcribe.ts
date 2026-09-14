import type { Env } from "../index";
import { arrayBufferToBase64 } from "./arrayBufferToBase64";

type transcribeVoiceParams = {
    audio: ArrayBuffer | string;
    env: Env;
};

type transcriptionAPIResponse = {
    text: string;
};

export async function transcribe({
    audio,
    env,
}: transcribeVoiceParams) {
    let base64Audio;
    if (typeof audio === "string") {
        console.log("Got a base64 audio");
        base64Audio = audio
    } else {
        base64Audio = arrayBufferToBase64(audio);
    }

    console.log(new Date(), "Transcription starts");
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
                model: "openai/whisper-large-v3-turbo",
                input_audio: {
                    data: base64Audio,
                    format: "ogg",
                },
            }),
        },
    );
    console.log(new Date(), "Transcription ends");
    const result = await response.json() as transcriptionAPIResponse;
    if (!result?.text) {
        throw new Error("Transcription result is malformed.");
    }
    return result.text;
}
