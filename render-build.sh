#!/bin/bash
# Build frontend first, then start the server
cd "$(dirname "$0")/.."
cd frontend
npx vite build
cd ../server
node server.js
