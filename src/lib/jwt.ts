import { SignJWT, jwtVerify } from 'jose';
import { config } from '../config.js';
import { E } from './errors.js';

const secret = new TextEncoder().encode(config.JWT_SECRET);

/** `sid` is the sign-in session (refresh-token family) the token belongs to; push tokens are tied to it. */
export async function signAccess(userId: string, sid?: string): Promise<string> {
  return new SignJWT(sid ? { sid } : {})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${config.accessTtlS}s`)
    .sign(secret);
}

export async function verifyAccess(token: string | undefined | null): Promise<string> {
  return (await verifyAccessClaims(token)).userId;
}

/** The user and, for tokens issued since sessions were added, the session id (null for older tokens). */
export async function verifyAccessClaims(token: string | undefined | null): Promise<{ userId: string; sessionId: string | null }> {
  if (!token) throw E.unauthorized();
  try {
    const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'] });
    if (!payload.sub) throw E.unauthorized();
    return { userId: payload.sub, sessionId: typeof payload.sid === 'string' ? payload.sid : null };
  } catch {
    throw E.unauthorized('Session expired');
  }
}
