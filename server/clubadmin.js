// Club owner tools: edit details, public/private, new invite code, remove members.

export function registerClubAdminRoutes({ app, db, io, q, HttpError, cleanText, makeInviteCode, notify }) {
  const updateClub = db.prepare('UPDATE clubs SET name = ?, description = ?, is_public = ? WHERE id = ?');
  const setInviteCode = db.prepare('UPDATE clubs SET invite_code = ? WHERE id = ?');
  const openChallengesBy = db.prepare(`SELECT id FROM games WHERE club_id = ? AND status = 'waiting'
    AND (created_by = ? OR invited_id = ?)`);
  const abortChallenge = db.prepare("UPDATE games SET status = 'aborted', termination = 'player left the club', updated_at = ? WHERE id = ?");

  function ownedClub(req) {
    const club = q.club.get(Number(req.params.id));
    if (!club) throw new HttpError(404, 'Club not found');
    if (q.membership.get(club.id, req.user.id)?.role !== 'owner') throw new HttpError(403, 'Only the club owner can do that');
    return club;
  }

  const changed = (clubId) => io.to(`club:${clubId}`).emit('club:changed', { clubId });

  app.patch('/api/clubs/:id', (req, res) => {
    const club = ownedClub(req);
    const body = req.body || {};
    const name = body.name === undefined ? club.name : cleanText(body.name, 60);
    if (name.length < 2) throw new HttpError(400, 'Club name must be at least 2 characters');
    const description = body.description === undefined ? club.description : cleanText(body.description, 500);
    const isPublic = body.isPublic === undefined ? club.is_public : body.isPublic ? 1 : 0;
    updateClub.run(name, description, isPublic, club.id);
    changed(club.id);
    res.json({ club: { id: club.id, name, description, isPublic: !!isPublic } });
  });

  // A new invite code makes the old one stop working (e.g. after it was shared too widely).
  app.post('/api/clubs/:id/invite-code', (req, res) => {
    const club = ownedClub(req);
    const code = makeInviteCode();
    setInviteCode.run(code, club.id);
    res.json({ inviteCode: code });
  });

  app.delete('/api/clubs/:id/members/:userId', (req, res) => {
    const club = ownedClub(req);
    const userId = Number(req.params.userId);
    if (userId === req.user.id) throw new HttpError(400, "The owner can't remove themselves");
    if (!q.membership.get(club.id, userId)) throw new HttpError(404, 'That player is not in this club');
    q.removeMember.run(club.id, userId);
    const now = Date.now();
    for (const { id } of openChallengesBy.all(club.id, userId, userId)) {
      abortChallenge.run(now, id);
      notify(id);
    }
    // Their live sockets lose access to the club's rooms on the next permission check.
    changed(club.id);
    res.json({ ok: true });
  });
}
