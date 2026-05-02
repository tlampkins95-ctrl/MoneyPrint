import { Router, type IRouter } from "express";
import healthRouter from "./health";
import levelsRouter from "./levels";
import backtestRouter from "./backtest";

const router: IRouter = Router();

router.use(healthRouter);
router.use(levelsRouter);
router.use(backtestRouter);

export default router;
