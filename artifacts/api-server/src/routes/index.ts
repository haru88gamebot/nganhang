import { Router, type IRouter } from "express";
import healthRouter from "./health";
import mbRouter from "./mb-routes.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(mbRouter);

export default router;
