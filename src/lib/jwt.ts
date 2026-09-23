import { SignJWT, jwtVerify } from 'jose';
import { config } from '../config.js';
import { E } from './errors.js';

const secret = new TextEncoder().encode(config.JWT_SECRET);

export async function signAccess(userId: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${config.accessTtlS}s`)
    .sign(secret);
}

export async function verifyAccess(token: string | undefined | null): Promise<string> {
  if (!token) throw E.unauthorized();
  try {
    const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'] });
    if (!payload.sub) throw E.unauthorized();
    return payload.sub;
  } catch {
    throw E.unauthorized('Session expired');
  }
}
