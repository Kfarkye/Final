import { Router, json } from "express";
import { chatController } from "../controllers/chat.controller";
import { chatRateLimiter, validateChatPayload } from "../../lib/middleware/chat-security";
import { handleCodexChat } from "../../lib/codex-chat-handler";

const router = Router();

// Gemini-powered chat (default)
router.post(
  "/chat",
  json({ limit: "20mb" }),
  chatRateLimiter,
  validateChatPayload,
  chatController.handleChat
);

// Codex autonomy chat (OpenAI-powered)
router.post(
  "/codex/chat",
  json({ limit: "20mb" }),
  chatRateLimiter,
  validateChatPayload,
  handleCodexChat
);

export default router;

