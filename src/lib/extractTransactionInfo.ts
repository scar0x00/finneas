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
        // We use chunking to prevent "Maximum call stack size exceeded" on larger receipt images.
        const uint8Array = new Uint8Array(image);
        let binaryString = "";
        const chunkSize = 8192;
        
        for (let i = 0; i < uint8Array.length; i += chunkSize) {
            const chunk = uint8Array.subarray(i, i + chunkSize);
            binaryString += String.fromCharCode.apply(null, chunk as unknown as number[]);
        }
        dataUrl = `data:image/jpeg;base64,${btoa(binaryString)}`;
    }

    const result = await env.AI.run("@cf/zai-org/glm-5.3-flash", {
        messages: [
            {
                role: "user",
                content: [
                    { type: "text", text: question },
                    { type: "image_url", image_url: { url: dataUrl } }
                ]
            }
        ]
    });
    console.log(result.choices[0].message);

    // 3. Extract and parse the response
    // Cloudflare text generation bindings return `{ response: "..." }`
    const aiText = (result as any).choices[0].message || "";

    try {
        // Even with strict prompting, models sometimes output markdown code blocks.
        // We strip out standard markdown JSON formatting before parsing.
        const cleanedText = aiText
            .replace(/^```json\s*/i, "")
            .replace(/\s*```$/i, "")
            .trim();
        
        return JSON.parse(cleanedText);
    } catch (error) {
        console.error("Failed to parse GLM-5.3-Flash response:", aiText);
        throw new Error("The AI did not return a valid JSON object.");
    }
}