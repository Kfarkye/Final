import { Router } from "express";
import { auditController, AuditPayloadSchema } from "../controllers/audit.controller";
import { validateRequest } from "../middleware/validate";

const router = Router();

router.post("/", validateRequest(AuditPayloadSchema), auditController.createAuditLog);
router.get("/", auditController.getAuditLogs);

export default router;
