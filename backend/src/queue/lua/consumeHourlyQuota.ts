/**
 * Atomically consumes one unit of hourly quota for a sender (and optionally the global
 * pool). Runs as a single Lua script, so check-and-increment is race-free across any
 * number of worker processes. Nothing is incremented unless every limit has room.
 *
 * KEYS[1]  per-sender counter   rl:{senderId}:{YYYYMMDDHH}
 * KEYS[2]  global counter       rl:global:{YYYYMMDDHH}
 * ARGV[1]  per-sender limit
 * ARGV[2]  global limit (0 = disabled)
 * ARGV[3]  counter TTL in seconds
 *
 * Returns { allowed (1|0), deniedBy (0 none | 1 sender | 2 global), count }
 */
export const CONSUME_HOURLY_QUOTA_LUA = `
local senderLimit = tonumber(ARGV[1])
local globalLimit = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])

local senderCount = tonumber(redis.call('GET', KEYS[1]) or '0')
if senderCount >= senderLimit then
  return {0, 1, senderCount}
end

if globalLimit > 0 then
  local globalCount = tonumber(redis.call('GET', KEYS[2]) or '0')
  if globalCount >= globalLimit then
    return {0, 2, globalCount}
  end
  redis.call('INCR', KEYS[2])
  redis.call('EXPIRE', KEYS[2], ttl)
end

senderCount = redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], ttl)
return {1, 0, senderCount}
`;
