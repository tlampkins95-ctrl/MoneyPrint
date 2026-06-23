import { Router, type IRouter } from "express";
import healthRouter from "./health";
import levelsRouter from "./levels";
import backtestRouter from "./backtest";
import pushRouter from "./push";
import tradeHistoryRouter from "./trade-history";
import signalLogRouter from "./signal-log";
import newsRouter from "./news";
import phemexRouter from "./phemex";

const router: IRouter = Router();

router.use(healthRouter);
router.use(levelsRouter);
router.use(backtestRouter);
router.use(pushRouter);
router.use(tradeHistoryRouter);
router.use(signalLogRouter);
router.use(newsRouter);
router.use(phemexRouter);

export default router;
