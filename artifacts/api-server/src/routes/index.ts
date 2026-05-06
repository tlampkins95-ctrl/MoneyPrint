import { Router, type IRouter } from "express";
import healthRouter from "./health";
import levelsRouter from "./levels";
import backtestRouter from "./backtest";
import pushRouter from "./push";
import tradeHistoryRouter from "./trade-history";

const router: IRouter = Router();

router.use(healthRouter);
router.use(levelsRouter);
router.use(backtestRouter);
router.use(pushRouter);
router.use(tradeHistoryRouter);

export default router;
