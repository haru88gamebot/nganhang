import { Router, type Request, type Response } from "express";
import { supportBotService } from "../telegram/supportBot";
import { requireAdmin } from "./admin";

const router = Router();

// Get all support requests (pending + active)
router.get("/admin/support/requests", requireAdmin, async (_req: Request, res: Response): Promise<void> => {
  try {
    const requests = supportBotService.getAllRequests().map(r => ({
      userId: r.userId,
      username: r.username,
      firstName: r.firstName,
      content: r.content,
      status: r.status,
      requestedAt: r.requestedAt,
      isConnected: supportBotService.isConnected(r.userId)
    }));
    res.json(requests);
  } catch {
    res.status(500).json({ error: "Lỗi server" });
  }
});

// Connect admin to player
router.post("/admin/support/connect/:userId", requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const userId = String(req.params.userId);
  const result = await supportBotService.adminConnect(userId);
  res.json(result);
});

// Disconnect admin from player
router.post("/admin/support/disconnect/:userId", requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const userId = String(req.params.userId);
  const result = await supportBotService.adminDisconnect(userId);
  res.json(result);
});

// Reject support request
router.post("/admin/support/reject/:userId", requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const userId = String(req.params.userId);
  const result = await supportBotService.adminReject(userId);
  res.json(result);
});

export default router;
