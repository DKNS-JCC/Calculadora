#!/usr/bin/env node
/**
 * Build a signed Android release APK and attach it to the GitHub Release
 * matching the current package.json version.
 *
 * Pre-requirements:
 *   - android/keystore.properties exists with valid signing config
 *   - GitHub CLI installed and authenticated (`gh auth login`)
 *   - JAVA_HOME points to a JDK 17+
 */

require('dotenv').config()
const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
const version = pkg.version
const tag = `v${version}`

const keystorePropsPath = path.join('android', 'keystore.properties')
if (!fs.existsSync(keystorePropsPath)) {
  console.error(`ERROR: ${keystorePropsPath} is missing.`)
  console.error('Copy android/keystore.properties.example, fill in your values, and try again.')
  process.exit(1)
}

function run(cmd, opts = {}) {
  console.log(`> ${cmd}`)
  execSync(cmd, { stdio: 'inherit', ...opts })
}

function tryRun(cmd, opts = {}) {
  try {
    execSync(cmd, { stdio: 'pipe', ...opts })
    return true
  } catch {
    return false
  }
}

console.log(`\n=== Building signed Android APK for ${tag} ===\n`)

run('npx vite build')
run('npx cap sync android')
run('gradlew.bat assembleRelease', { cwd: 'android' })

const apkSrc = path.join('android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk')
if (!fs.existsSync(apkSrc)) {
  console.error(`ERROR: APK not produced at ${apkSrc}`)
  process.exit(1)
}

const apkOut = path.join('dist-electron', `3DCALC-${version}.apk`)
fs.mkdirSync(path.dirname(apkOut), { recursive: true })
fs.copyFileSync(apkSrc, apkOut)
console.log(`\nAPK ready: ${apkOut}`)

console.log(`\n=== Uploading to GitHub release ${tag} ===\n`)

if (!tryRun(`gh release view ${tag}`)) {
  console.log(`Release ${tag} not found — creating draft.`)
  run(`gh release create ${tag} --draft --title "${tag}" --notes ""`)
}

run(`gh release upload ${tag} "${apkOut}" --clobber`)

console.log('\nDone.')
console.log(`Visit https://github.com/DKNS-JCC/Calculadora/releases to publish ${tag}.`)
