import { Router, type IRouter } from "express";
import healthRouter from "./health";
import adminRouter from "./admin";
import bankRouter from "./bank";
import gameRouter from "./game";
import historyRouter from "./history";
import supportRouter from "./support";
import cardRouter from "./card";
import crashRouter from "./crash";
import bauCuaRouter from "./bauCuaGame";
import bot2HistoryRouter from "./bot2History";
import xocDiaRouter from "./xocDiaGame";
import quayThuRouter from "./quayThuGame";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/admin", adminRouter);
router.use(bankRouter);
router.use(gameRouter);
router.use(historyRouter);
router.use(supportRouter);
router.use(cardRouter);
router.use(crashRouter);
router.use(bauCuaRouter);
router.use(bot2HistoryRouter);
router.use(xocDiaRouter);
router.use(quayThuRouter);

export default router;
