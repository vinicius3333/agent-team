#!/bin/sh
# Dokploy runs compose inside its own container, where host files are not visible, so env_file cannot point at
# the host. The secrets file is read from the mounted home instead: it holds CLAUDE_CODE_OAUTH_TOKEN and the
# dashboard login, and stays on the host, out of the repository and Dokploy. sh expands "$", so values that
# contain one (the password hash) go in single quotes there.
set -a
. "$HOME/.config/agent-team/doctor.env"
set +a
exec "$@"
