#!/usr/bin/env node
/**
 * Publish the Windows installer (NSIS) to the GitHub Release matching
 * the current package.json version. electron-updater on the client side
 * polls latest.yml from this release.
 *
 * Reads .env automatically (must contain GH_TOKEN with `repo` scope).
 */

require('dotenv').config()
const { execSync } = require('child_process')

if (!process.env.GH_TOKEN) {
  console.error('ERROR: GH_TOKEN is not set in .env')
  process.exit(1)
}

function run(cmd) {
  console.log(`> ${cmd}`)
  execSync(cmd, { stdio: 'inherit' })
}

run('npx vite build')
run('npx electron-builder --win --publish always')

console.log('\nDone. The release is created as a DRAFT.')
console.log('Run `npm run publish:android` next, then publish the draft on GitHub.')
