import { Router } from 'express';
import { listTeam, addTeamMember, updateTeamMember, removeTeamMember } from '../controllers/user.controller.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = Router();

// Managing who may use the dashboard is an admin's job, start to finish. The email address in
// the path is the key — these records exist before the person has ever signed in, so there is no
// id to use instead.
router.use(requireAuth, requireAdmin);

router.get('/', asyncHandler(listTeam));
router.post('/', asyncHandler(addTeamMember));
router.patch('/:email', asyncHandler(updateTeamMember));
router.delete('/:email', asyncHandler(removeTeamMember));

export default router;
