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
    if (!env.XAI_API_KEY) {
        throw new Error("Missing XAI_API_KEY in environment variables.");
    }

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

    // 1. Construct the Grok Responses API payload
    const requestBody = {
        model: "grok-4.20-0309-non-reasoning",
        input: [
            {
                role: "user",
                content: [
                    {
                        type: "input_image",
                        image_url: dataUrl,
                        detail: "high"
                    },
                    {
                        type: "input_text",
                        text: question
                    }
                ]
            }
        ],
        // Required per docs: Disables storing request/response history for privacy,
        // and is highly recommended when pushing images to avoid request failures.
        store: false,
        // Using temperature 0 for JSON constraint determinism
        temperature: 0 
    };

    // 2. Invoke the Grok API directly via fetch
    const response = await fetch("https://api.x.ai/v1/responses", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${env.XAI_API_KEY}`
        },
        body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
        const errorText = await response.text();
        console.error("Grok API Error:", errorText);
        throw new Error(`Grok API request failed with status ${response.status}`);
    }

    const data = await response.json() as any;

    // 3. Parse the specific Responses API structure
    // Grok returns an `output` array; the text itself is inside `content` elements with `type: "output_text"`
    const aiText = 
        data.output?.find((msg: any) => msg.role === "assistant")?.content?.find((c: any) => c.type === "output_text")?.text ||
        data.output?.[data.output?.length - 1]?.content?.[0]?.text ||
        "";

    if (!aiText) {
        console.error("Empty or unexpected Grok API Response:", JSON.stringify(data, null, 2));
        throw new Error("The AI returned an empty response.");
    }

    try {
        let cleanedText = aiText;

        // Strip standard Markdown formatting if the model still applied it
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
        console.error("Failed to parse Grok response:", aiText);
        throw new Error("The AI did not return a valid JSON object.");
    }
}