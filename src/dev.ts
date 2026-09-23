/** `npm run dev`: api + realtime + worker in one process for local development. Production runs them separately. */
await import('./api/index.js');
await import('./realtime/index.js');
await import('./worker/index.js');
export {};
