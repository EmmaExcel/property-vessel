#!/bin/zsh
cd "${0:A:h}" || exit 1
if [ ! -d node_modules ]; then
  npm install || exit 1
fi
if curl -fsS "http://localhost:${PORT:-3000}" >/dev/null 2>&1; then
  open "http://localhost:${PORT:-3000}"
  exit 0
fi
npm run api &
server_pid=$!
sleep 1
open "http://localhost:${PORT:-3000}"
wait $server_pid
