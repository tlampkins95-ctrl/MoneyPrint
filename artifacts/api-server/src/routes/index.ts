import { Router, type IRouter } from "express";
import healthRouter from "./health";
import signalsRouter from "./signals";

const router: IRouter = Router();

router.use(healthRouter);
router.use(signalsRouter);

export default router;
