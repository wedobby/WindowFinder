#!/bin/zsh
# Double-click launcher: starts the server (if not running) and opens the browser.
cd "$(dirname "$0")"
PORT=8890
if ! curl -s -o /dev/null "http://127.0.0.1:$PORT/api/home"; then
  nohup node server.js $PORT > /tmp/fileexplorer.log 2>&1 &
  for i in {1..20}; do
    curl -s -o /dev/null "http://127.0.0.1:$PORT/api/home" && break
    sleep 0.2
  done
fi
open "http://127.0.0.1:$PORT/"
