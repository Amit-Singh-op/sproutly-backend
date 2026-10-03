/**
 * Who can see someone's stories and Show off posts (the same rule as AUDIENCE in stories.ts): accepted friends and
 * people they share a chat with, minus anyone blocked either way. Used to send live updates only to people who are
 * allowed to see the thing that changed. Capped, so a member of a huge group can't trigger an unbounded fan-out
 * (everyone else still gets it on their next refresh).
 */
import { q } from '../db/pool.js';

const MAX_LIVE_AUDIENCE = 2000;

export async function audienceIds(authorId: string): Promise<string[]> {
  const rows = await q<{ id: string }>(
    `SELECT DISTINCT x.id FROM (
       SELECT CASE WHEN fr.user_id = $1 THEN fr.friend_id ELSE fr.user_id END AS id
         FROM friendships fr WHERE fr.status = 'accepted' AND (fr.user_id = $1 OR fr.friend_id = $1)
       UNION
       SELECT b.user_id AS id FROM conversation_members a JOIN conversation_members b ON b.conversation_id = a.conversation_id
        WHERE a.user_id = $1 AND b.user_id <> $1
     ) x
     WHERE NOT EXISTS (SELECT 1 FROM friendships bl WHERE bl.status = 'blocked'
                         AND ((bl.user_id = $1 AND bl.friend_id = x.id) OR (bl.user_id = x.id AND bl.friend_id = $1)))
     LIMIT ${MAX_LIVE_AUDIENCE}`, [authorId],
  );
  // The author's other devices too.
  return [authorId, ...rows.map((r) => r.id)];
}
