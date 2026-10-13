import type { MusicProvider } from './types.js';

const PROVIDERS: { host: RegExp; provider: MusicProvider }[] = [
  { host: /^open\.spotify\.com$/i, provider: 'spotify' },
  { host: /^((www|m|music)\.)?youtube\.com$|^youtu\.be$/i, provider: 'youtube' },
  { host: /^music\.apple\.com$/i, provider: 'apple' },
  { host: /^((www|m)\.)?soundcloud\.com$/i, provider: 'soundcloud' },
];

/** Which app a link is from, or null when it isn't one we support. */
export function providerOf(link: string): { url: URL; provider: MusicProvider } | null {
  let url: URL;
  try { url = new URL(link.trim()); } catch { return null; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  url.protocol = 'https:';
  const p = PROVIDERS.find((x) => x.host.test(url.hostname));
  return p ? { url, provider: p.provider } : null;
}

/** The first music-app link in a message, if there is one. */
export function songLinkIn(text: string): string | null {
  for (const m of text.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    const link = m[0].replace(/[).,!?]+$/, '');
    if (providerOf(link)) return link;
  }
  return null;
}

/** The normalised link a song card is stored under (https, as URL parses it), or null for non-music links. */
export function songKey(link: string): string | null {
  return providerOf(link)?.url.toString().slice(0, 500) ?? null;
}
