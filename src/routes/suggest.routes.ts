import { Router, json } from "express";
import { ai } from "../services/ai.service";

const router = Router();

interface Suggestion {
  prompt: string;
  model: string;
  label: string; // short label for the chip, e.g., "Deep dive" or "Compare"
}

router.post("/suggest", json(), async (req, res) => {
  try {
    const { lastPrompt, lastResponse, topic } = req.body;

    if (!lastPrompt || !lastResponse) {
      return res.json({ suggestions: [] });
    }

    // Truncate to keep it fast and cheap
    const truncatedResponse = lastResponse.substring(0, 1500);

    const result = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `You are a helpful assistant that suggests follow-up prompts for a conversation.

Given this exchange:
USER: ${lastPrompt}
AI: ${truncatedResponse}

Topic context: ${topic || "General"}

Generate exactly 3 follow-up suggestions the user might want to ask next. For each, recommend the best model:
- "gemini" for fast factual questions, coding, and general queries
- "claude" for complex reasoning, analysis, writing, and code review
- "chatgpt" for creative writing, brainstorming, and conversational tasks
- "deepseek" for deep technical/math problems

Respond in this exact JSON format, nothing else:
[
  {"prompt": "the follow-up question", "model": "gemini", "label": "short 2-3 word label"},
  {"prompt": "another question", "model": "claude", "label": "short label"},
  {"prompt": "third question", "model": "gemini", "label": "short label"}
]`,
            },
          ],
        },
      ],
      config: {
        temperature: 0.8,
        maxOutputTokens: 500,
      },
    });

    const text = result.text?.trim() || "";

    // Extract JSON from the response (handle markdown code blocks)
    let jsonStr = text;
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      jsonStr = jsonMatch[0];
    }

    let suggestions: Suggestion[] = [];
    try {
      suggestions = JSON.parse(jsonStr);
    } catch {
      const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
      if (fenceMatch?.[1]) {
        suggestions = JSON.parse(fenceMatch[1]);
      } else {
        throw new Error("Model did not return parseable JSON suggestions");
      }
    }

    // Validate and sanitize
    const validSuggestions = suggestions
      .slice(0, 3)
      .filter(
        (s) =>
          s.prompt &&
          s.model &&
          s.label &&
          ["gemini", "claude", "chatgpt", "deepseek", "grok"].includes(s.model)
      )
      .map((s) => ({
        prompt: s.prompt.substring(0, 200),
        model: s.model,
        label: s.label.substring(0, 30),
      }));

    return res.json({ suggestions: validSuggestions });
  } catch (err: any) {
    console.error("[Suggest] Error generating suggestions:", err.message);
    return res.json({ suggestions: [] });
  }
});

export default router;
