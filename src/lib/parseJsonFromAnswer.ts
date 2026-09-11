export function parseJsonFromAnswer(text: string): Record<string, any> | null {
    try {
        const cleaned = text
            .replace(/```json/gi, "")
            .replace(/```/g, "")
            .trim();
        return JSON.parse(cleaned);
    } catch {
        return null;
    }
}