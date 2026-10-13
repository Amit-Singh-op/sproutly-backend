import { describe, expect, it } from 'vitest';
import { providerOf, songKey, songLinkIn } from '../src/shared/music.js';

describe('song links', () => {
  it('knows the supported music apps', () => {
    expect(providerOf('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=x')?.provider).toBe('spotify');
    expect(providerOf('https://music.youtube.com/watch?v=dQw4w9WgXcQ')?.provider).toBe('youtube');
    expect(providerOf('https://youtu.be/dQw4w9WgXcQ')?.provider).toBe('youtube');
    expect(providerOf('https://www.youtube.com/watch?v=dQw4w9WgXcQ')?.provider).toBe('youtube');
    expect(providerOf('https://music.apple.com/us/album/x/123?i=456')?.provider).toBe('apple');
    expect(providerOf('https://soundcloud.com/artist/track')?.provider).toBe('soundcloud');
  });

  it('upgrades http and trims spaces', () => {
    expect(providerOf('  http://open.spotify.com/track/abc ')?.url.toString()).toBe('https://open.spotify.com/track/abc');
  });

  it('turns away anything else', () => {
    expect(providerOf('https://evil.example.com/open.spotify.com')).toBeNull();
    expect(providerOf('https://open.spotify.com.evil.com/track/1')).toBeNull();
    expect(providerOf('ftp://open.spotify.com/track/1')).toBeNull();
    expect(providerOf('javascript:alert(1)')).toBeNull();
    expect(providerOf('not a link')).toBeNull();
    expect(providerOf('http://localhost:4000/')).toBeNull();
  });
});

describe('song links in messages', () => {
  it('finds the first music link in a message', () => {
    expect(songLinkIn('listen to this https://open.spotify.com/track/abc?si=1 so good')).toBe('https://open.spotify.com/track/abc?si=1');
    expect(songLinkIn('(https://youtu.be/dQw4w9WgXcQ).')).toBe('https://youtu.be/dQw4w9WgXcQ');
    expect(songLinkIn('https://example.com/x then https://music.apple.com/us/album/a/1?i=2')).toBe('https://music.apple.com/us/album/a/1?i=2');
  });

  it('ignores messages without one', () => {
    expect(songLinkIn('hello')).toBeNull();
    expect(songLinkIn('https://example.com/open.spotify.com')).toBeNull();
  });

  it('stores cards under a normalised link', () => {
    expect(songKey('http://open.spotify.com/track/abc')).toBe('https://open.spotify.com/track/abc');
    expect(songKey('https://example.com')).toBeNull();
  });
});
