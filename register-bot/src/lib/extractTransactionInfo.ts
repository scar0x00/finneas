import type { Env } from "../index";

type extractTransactionInfoParams = {
    image: ArrayBuffer | string;
    env: Env;
};

const question =
    `You are a financial receipt parser. Extract key bank transaction information from this image.
Return ONLY a valid JSON object without any additional explanation, markdown backticks, or text. 
Bear in mind that most of the transactions you'll be processing are from Venezuelan banks.
Keep in mind that most of the times if the image contains only one name that probably is the name of the recipient, not the sender's name.

JSON format:
{
  "receiving_bank": "string or null",
  "amount": "number or null",
  "currency": "string or null (e.g. USD, EUR, etc.)",
  "transaction_id": "string or null",
  "date": "string (YYYY-MM-DD) or null",
  "time": "string or null",
  "sender_name": "string or null",
  "recipient_name": "string or null",
  "recipient_id": "string or null",
  "recipient_phone": "number or null"
  "status": "success | pending | failed | null"
}`;

export async function extractTransactionInfo({
    image,
    env,
}: extractTransactionInfoParams) {
    if (!env.OPENROUTER_API_KEY) {
        throw new Error("Missing OPENROUTER_API_KEY in environment variables.");
    }

    let dataUrl = "";

    if (typeof image === "string") {
        // If it's already a Data URL, use it. Otherwise, assume it's a raw base64 string.
        dataUrl = image.startsWith("data:image") 
            ? image 
            : `data:image/jpeg;base64,${image}`;
    } else {
        // It's an ArrayBuffer. Convert to Base64 safely.
        // Chunking prevents "Maximum call stack size exceeded" on larger images.
        const uint8Array = new Uint8Array(image);
        let binaryString = "";
        const chunkSize = 8192;
        
        for (let i = 0; i < uint8Array.length; i += chunkSize) {
            const chunk = uint8Array.subarray(i, i + chunkSize);
            binaryString += String.fromCharCode.apply(null, chunk as unknown as number[]);
        }
        dataUrl = `data:image/jpeg;base64,${btoa(binaryString)}`;
    }

    // 1. Construct the OpenRouter API payload
    const requestBody = {
        model: "deepseek/deepseek-v4.1-flash",
        messages: [
            {
                role: "user",
                content: [
                    { type: "text", text: question },
                    { type: "image_url", image_url: { url: dataUrl } }
                ]
            }
        ],
        // Explicitly disable reasoning as requested and supported by OpenRouter
        reasoning: { 
            enabled: false 
        },
        // Set temperature to 0 for highly deterministic JSON output
        temperature: 0 
    };

    // 2. Invoke the OpenRouter API
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${env.OPENROUTER_API_KEY}`,
            "Content-Type": "application/json",
            // Optional but recommended by OpenRouter for ranking/metrics:
            "HTTP-Referer": "https://finneas.dev",
            "X-Title": "Finneas"
        },
        body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
        const errorText = await response.text();
        console.error("OpenRouter API Error:", errorText);
        throw new Error(`OpenRouter API request failed with status ${response.status}`);
    }

    const data = await response.json() as any;
    console.log("Text extraction: ", JSON.stringify(data, null, 2));

    // 3. Extract the text response
    const aiText = data.choices?.[0]?.message?.content || "";

    if (!aiText) {
        console.error("Empty AI Response:", JSON.stringify(data, null, 2));
        throw new Error("The AI returned an empty response.");
    }

    try {
        let cleanedText = aiText;

        // Although reasoning is disabled, if any rogue <think> tags slip through, strip them.
        cleanedText = cleanedText.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

        // 4. Safely extract JSON by targeting code block limits, or trimming edges
        const jsonMatch = cleanedText.match(/```json\s*([\s\S]*?)\s*```/i);
        if (jsonMatch) {
            cleanedText = jsonMatch[1];
        } else {
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