#!/bin/zsh -f
set -euo pipefail
umask 0027
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH

readonly CONFIG='/Library/Application Support/SubmarineDashRedis/redis.conf'
readonly RESTORE_MARKER='/Library/Application Support/SubmarineDashRedis.restore-in-progress'
readonly SERVER='/usr/local/lib/submarine-redis/current/bin/redis-server'

[[ ! -e "$RESTORE_MARKER" && ! -L "$RESTORE_MARKER" ]] || {
  print -u2 'Submarine Redis startup refused: interrupted restore requires recovery.'
  exit 78
}
[[ -x "$SERVER" && -f "$CONFIG" && ! -L "$CONFIG" ]] || exit 78
exec "$SERVER" "$CONFIG"
