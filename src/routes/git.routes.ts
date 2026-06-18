import { Router } from "express";
import { gitController } from "../controllers/git.controller";

const router = Router();

router.post("/provision", gitController.provisionWorkspace);
router.get("/tree", gitController.getFileTree);
router.get("/file", gitController.getFileContent);
router.get("/status", gitController.getGitStatus);
router.get("/commits", gitController.getGitCommits);
router.get("/diff", gitController.getFileDiff);
router.get("/branches", gitController.getBranches);

export default router;
