#!/usr/bin/env node
// WhisperWeb — Unified startup for Render
// This file handles both the build-time copy of frontend dist
// and starting the Express server.
const path = require('path');
const { execSync } = require('child_process');
const fs = require('fs');

const BUILD_DIR = path.join(__dirname, '../../frontend/dist');

// If dist doesn't exist, build it (Render build step)
if (!fs.existsSync(path.join(BUILD_DIR, 'index.html'))) {
  console.log('Building frontend...');
  const frontendDir = path.join(__dirname, '../../frontend');
  if (fs.existsSync(path.join(frontendDir, 'package.json'))) {
    process.chdir(frontendDir);
    try {
      execSync('npm ci --production 2>/dev/null || npm install --production', {
        stdio: 'inherit',
      });
      execSync('npm run build', { stdio: 'inherit' });
    } catch (err) {
      console.error('Frontend build failed, continuing without static files...');
    }
  }
}

// Start the Express server
require('./src/index.js');
