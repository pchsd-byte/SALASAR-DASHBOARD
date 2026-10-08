import { Router } from 'express';
import { getHsdSummary, listManpowerRecords } from '../controllers/dashboard.controller.js';
import { getHsdInsights } from '../controllers/insights.controller.js';
import { getSynopsisSummary } from '../controllers/synopsis.controller.js';
import { requireAuth, requireSection } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = Router();

// The figures themselves are a section an admin grants, like any other: somebody given only the
// Email section can compose reports without the plant's production and dispatch numbers being
// readable from their session. Hiding the nav link alone would not have stopped that.
const canRead = [requireAuth, requireSection('dashboard')];

router.get('/hsd/summary', ...canRead, asyncHandler(getHsdSummary));
router.get('/hsd/insights', ...canRead, asyncHandler(getHsdInsights));
router.get('/manpower', ...canRead, asyncHandler(listManpowerRecords));
router.get('/synopsis', ...canRead, asyncHandler(getSynopsisSummary));

export default router;
