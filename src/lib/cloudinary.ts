import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { E } from './errors.js';

interface Creds { cloudName: string; apiKey: string; apiSecret: string }

function creds(): Creds | null {
  if (config.CLOUDINARY_URL) {
    // cloudinary://<api_key>:<api_secret>@<cloud_name>
    const m = /^cloudinary:\/\/([^:]+):([^@]+)@(.+)$/.exec(config.CLOUDINARY_URL.trim());
    if (m) return { apiKey: m[1]!, apiSecret: m[2]!, cloudName: m[3]!.trim() };
  }
  const { CLOUDINARY_CLOUD_NAME: cloudName, CLOUDINARY_API_KEY: apiKey, CLOUDINARY_API_SECRET: apiSecret } = config;
  return cloudName && apiKey && apiSecret ? { cloudName: cloudName.trim(), apiKey: apiKey.trim(), apiSecret: apiSecret.trim() } : null;
}

export const UPLOAD_FOLDERS = ['avatars', 'chat', 'stories', 'showcase'] as const;
export type UploadFolder = (typeof UPLOAD_FOLDERS)[number];

/**
 * Signed direct upload: the app posts the file straight to Cloudinary with these params, so the API secret never
 * leaves the server and uploads can only land in the user's own folder.
 * Signature = sha1 of the alphabetically sorted params joined as k=v&k=v, followed by the secret.
 */
export function uploadSignature(userId: string, folder: UploadFolder) {
  const c = creds();
  if (!c) throw E.unavailable('UPLOADS_DISABLED', 'Photo uploads are not set up yet.');
  const params: Record<string, string> = {
    folder: `sproutly/${folder}/${userId}`,
    timestamp: String(Math.floor(Date.now() / 1000)),
  };
  const toSign = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
  const signature = createHash('sha1').update(toSign + c.apiSecret).digest('hex');
  return {
    uploadUrl: `https://api.cloudinary.com/v1_1/${c.cloudName}/image/upload`,
    apiKey: c.apiKey,
    signature,
    ...params,
  };
}

/** Only images this user uploaded (through a signature we issued, into that folder) may be saved against them. */
export function isOwnCloudinaryUrl(url: string, userId: string, folder: UploadFolder = 'avatars'): boolean {
  const c = creds();
  if (!c) return false;
  return url.startsWith(`https://res.cloudinary.com/${c.cloudName}/image/upload/`) && url.includes(`/sproutly/${folder}/${userId}/`);
}
