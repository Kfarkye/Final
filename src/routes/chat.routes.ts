import { Router, json } from "express";
import { chatController } from "../controllers/chat.controller";
import { chatRateLimiter, validateChatPayload } from "../../lib/middleware/chat-security";

const router = Router();

router.post(
  "/chat",
  json({ limit: "20mb" }),
  chatRateLimiter,
  validateChatPayload,
  chatController.handleChat
);

export default router;
