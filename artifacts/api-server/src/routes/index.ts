import { Router, type IRouter } from "express";
import healthRouter from "./health";
import levelsRouter from "./levels";

const router: IRouter = Router();

router.use(healthRouter);
router.use(levelsRouter);

export default router;
