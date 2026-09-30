#!/bin/sh
set -eu
cd "$(dirname "$0")"
exec node --env-file=.env server.js
