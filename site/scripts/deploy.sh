#!/bin/zsh
# Deploys the landing page to Cloudflare Pages (project ember-app, served at ember.appliedleverage.io)
# through Composio: the upload token, the asset upload, then a production deployment.
# Needs: a Composio Cloudflare connection, and python3 with blake3 (pip install blake3).
set -euo pipefail
cd "${0:A:h}/.."
ACC=ab8c9c652631a95d66c9c704ae4be0ce
PY=${PYTHON:-python3}
MANIFEST=$(mktemp)
$PY scripts/pages_upload.py "$ACC" ember-app . "$MANIFEST"
ARGS=$(mktemp)
$PY -c "import json,sys; json.dump({'account_id':'$ACC','project_name':'ember-app','branch':'main','manifest':json.load(open('$MANIFEST'))}, open('$ARGS','w'))"
composio execute CLOUDFLARE_CREATE_PAGES_DEPLOYMENT -d @"$ARGS" < /dev/null | $PY -c "import json,sys; d=json.load(sys.stdin); r=(d.get('data') or {}).get('result') or {}; print('deployed:', r.get('url') or d.get('error'))"
rm -f "$MANIFEST" "$ARGS"
