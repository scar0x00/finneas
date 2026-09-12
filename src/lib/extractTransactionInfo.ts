import type { Env } from "../index";

type extractTransactionInfoParams = {
    image: ArrayBuffer | string;
    env: Env;
};

const question =
    `You are a financial receipt parser. Extract key bank transaction information from this image.
Return ONLY a valid JSON object without any additional explanation, markdown backticks, or text. 
Bear in mind that most of the transactions you'll be processing are from Venezuelan banks.
JSON format:
{
  "bank_name": "string or null",
  "amount": "number or null",
  "currency": "string or null (e.g. USD, EUR, etc.)",
  "transaction_id": "string or null",
  "reference_number": "string or null",
  "date": "string (YYYY-MM-DD) or null",
  "time": "string or null",
  "sender_name": "string or null",
  "recipient_name": "string or null",
  "status": "success | pending | failed | null"
}`;

export async function extractTransactionInfo({
    image,
    env,
}: extractTransactionInfoParams) {
    let dataUrl = "";

    if (typeof image === "string") {
        // If it's already a Data URL, use it. Otherwise, assume it's a raw base64 string.
        dataUrl = image.startsWith("data:image")
            ? image 
            : `data:image/jpeg;base64,${image}`;
    } else {
        // It's an ArrayBuffer. Convert to Base64 safely.
        const uint8Array = new Uint8Array(image);
        let binaryString = "";
        const chunkSize = 8192;
        
        for (let i = 0; i < uint8Array.length; i += chunkSize) {
            const chunk = uint8Array.subarray(i, i + chunkSize);
            binaryString += String.fromCharCode.apply(null, chunk as unknown as number[]);
        }
        dataUrl = `data:image/jpeg;base64,${btoa(binaryString)}`;
    }

    // 1. Invoke the DeepSeek V4 Flash model via standard @cf namespace
    const result = await env.AI.run("@cf/zai-org/glm-5.3-flash", {
        messages: [
            {
                role: "user",
                content: [
                    { type: "text", text: question },
                    { type: "image_url", image_url: { url: dataUrl } }
                ]
            }
        ],
        // Setting temperature to 0 increases JSON strictness determinism
        temperature: 0 
    });

    // 2. Extract the response safely
    // Standard @cf models natively return `{ response: string }`, 
    // but we fall back to the OpenAI compatible `choices` array just in case.
    const aiText = 
        (result as any).response ||
        (result as any).choices?.[0]?.message?.content ||
        "";

    if (!aiText) {
        console.error("Empty AI Response:", JSON.stringify(result, null, 2));
        throw new Error("The AI returned an empty response.");
    }

    try {
        let cleanedText = aiText;

        // 3. Strip DeepSeek reasoning blocks 
        // (DeepSeek often generates <think>...</think> chain-of-thought blocks before the answer)
        cleanedText = cleanedText.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

        // 4. Safely extract JSON. Even with temperature 0, conversational models
        // sometimes include conversational preambles.
        const jsonMatch = cleanedText.match(/```json\s*([\s\S]*?)\s*```/i);
        if (jsonMatch) {
            cleanedText = jsonMatch[1];
        } else {
            // If there's no code block wrapper, aggressively trim any standard markdown bounds
            cleanedText = cleanedText
                .replace(/^```json\s*/i, "")
                .replace(/\s*```$/i, "")
                .trim();
        }
        
        return JSON.parse(cleanedText);
    } catch (error) {
        console.error("Failed to parse DeepSeek response:", aiText);
        throw new Error("The AI did not return a valid JSON object.");
    }
}