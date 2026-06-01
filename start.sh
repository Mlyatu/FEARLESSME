#!/usr/bin/env bash
cd "$(dirname "$0")"
if [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  npm install
fi
echo ""
echo "Starting eFootball Arena..."
echo "Open in browser: http://localhost:3000"
echo ""
npm start
