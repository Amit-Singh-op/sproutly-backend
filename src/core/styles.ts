import { z } from 'zod';
import { q } from '../db/pool.js';
import { toUsers } from '../lib/emitter.js';
import { E } from '../lib/errors.js';
import { STYLE_OPTIONS, contrast } from '../shared/rules.js';
import type { ChatStyle } from '../shared/types.js';
import { requirePlus } from './entitlements.js';
import { getChatStyle, peersOf, userStyleOf } from './users.js';

const oneOf = <T extends readonly [string, ...string[]]>(opts: T) => z.enum(opts);

/** PUT /chat-style body: only the exact 6 x 5 artboard options are accepted. */
export const ChatStyleBody = z.object({
  bubble: oneOf(STYLE_OPTIONS.bubble as unknown as [string, ...string[]]),
  text: oneOf(STYLE_OPTIONS.text as unknown as [string, ...string[]]),
  border: oneOf(STYLE_OPTIONS.border as unknown as [string, ...string[]]),
  design: z.enum(STYLE_OPTIONS.design),
  avatar: oneOf(STYLE_OPTIONS.avatar as unknown as [string, ...string[]]),
  animation: z.enum(STYLE_OPTIONS.animation),
  wallpaper: z.enum(STYLE_OPTIONS.wallpaper).default('lavender'),
  avatarAnimation: z.enum(['float', 'bounce', 'spin', 'glide', 'zen']).optional(),
  avatarEffect: z.enum(['fire', 'water', 'sparkle', 'nature', 'lightning', 'hearts']).optional(),
  avatarCharm: z.enum(['crown', 'star', 'diamond', 'flame', 'lightning', 'sparkle']).optional(),
});

export async function getStyle(userId: string): Promise<ChatStyle> {
  return (await getChatStyle(userId)).style;
}

export async function saveStyle(userId: string, s: ChatStyle) {
  await requirePlus(userId, 'chat_style');
  if (contrast(s.bubble, s.text) < 4.5) {
    throw E.badRequest('Text is hard to read on that bubble. Pick a higher-contrast combination.', { field: 'text', minContrast: 4.5 });
  }
  await q(
    `INSERT INTO chat_styles (user_id, bubble, text_color, border, design, avatar_color, animation, wallpaper, version, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1, now())
     ON CONFLICT (user_id) DO UPDATE SET bubble = EXCLUDED.bubble, text_color = EXCLUDED.text_color, border = EXCLUDED.border,
       design = EXCLUDED.design, avatar_color = EXCLUDED.avatar_color, animation = EXCLUDED.animation, wallpaper = EXCLUDED.wallpaper,
       version = chat_styles.version + 1, updated_at = now()`,
    [userId, s.bubble, s.text, s.border, s.design, s.avatar, s.animation, s.wallpaper],
  );
  const style = await userStyleOf(userId);
  if (style) toUsers([...(await peersOf(userId)), userId], 'style:update', style);
}
