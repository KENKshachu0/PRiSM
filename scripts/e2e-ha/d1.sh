#!/bin/sh
# Run one SQL statement against the end-to-end platform's local D1 and print each row as JSON.
#   scripts/e2e-ha/d1.sh "SELECT * FROM ha_event_connections"
cd "$(dirname "$0")/../.." && bunx wrangler d1 execute DB --local --config wrangler.jsonc --persist-to .e2e/state --json --command "$1" 2>&1 | python3 -c "
import json,sys
raw=sys.stdin.read()
try:
    data=json.loads(raw)
except Exception:
    print(raw[-600:]); sys.exit(1)
if isinstance(data,dict):
    print(json.dumps(data,ensure_ascii=False)[:600]); sys.exit(1)
for block in data:
    rows=block.get('results',[])
    for r in rows: print(json.dumps(r,ensure_ascii=False))
    if not rows: print('(no rows)')
"
