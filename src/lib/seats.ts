import { redis } from './redis.js';

/**
 * Take a seat in a capacity-limited room stored as a Redis hash (member -> JSON), atomically: the "is there room?"
 * check and the write happen as one Redis operation, so two people arriving at the same moment can never both take
 * the last seat. Someone already seated just updates their entry. Returns false when the room is full.
 */
const TAKE_SEAT = `
local key, member, value, cap = KEYS[1], ARGV[1], ARGV[2], tonumber(ARGV[3])
if redis.call('HEXISTS', key, member) == 1 then
  redis.call('HSET', key, member, value)
  return 1
end
if redis.call('HLEN', key) >= cap then
  return 0
end
redis.call('HSET', key, member, value)
return 1`;

export async function takeSeat(key: string, member: string, value: string, capacity: number): Promise<boolean> {
  return (await redis.eval(TAKE_SEAT, 1, key, member, value, String(capacity))) === 1;
}
