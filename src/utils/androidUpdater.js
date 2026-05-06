/**
 * Android sideload updater.
 *
 * Polls the GitHub Releases API for a newer version, downloads the .apk
 * asset to external storage, and hands it to the system installer via
 * @capacitor-community/file-opener. The user accepts the install in the
 * standard Android dialog.
 *
 * Designed to run only on Capacitor/Android. On other platforms every
 * exported function is a no-op.
 */

const REPO_OWNER = 'DKNS-JCC'
const REPO_NAME = 'Calculadora'
const RELEASES_URL = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`
const CHECK_COOLDOWN_MS = 24 * 60 * 60 * 1000
const LAST_CHECK_KEY = 'androidUpdater:lastCheck'
const SKIP_VERSION_KEY = 'androidUpdater:skipVersion'

function isAndroid() {
  const cap = typeof window !== 'undefined' ? window.Capacitor : null
  return !!(cap && cap.isNativePlatform && cap.isNativePlatform() && cap.getPlatform() === 'android')
}

function compareSemver(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0)
  const pb = String(b).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0)
  while (pa.length < 3) pa.push(0)
  while (pb.length < 3) pb.push(0)
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1
    if (pa[i] < pb[i]) return -1
  }
  return 0
}

async function getInstalledVersion() {
  const { App } = await import(/* @vite-ignore */ '@capacitor/app')
  const info = await App.getInfo()
  return info.version
}

async function fetchLatestRelease() {
  const res = await fetch(RELEASES_URL, { headers: { Accept: 'application/vnd.github+json' } })
  if (!res.ok) throw new Error(`GitHub API responded ${res.status}`)
  return res.json()
}

function pickApkAsset(release) {
  if (!release || !Array.isArray(release.assets)) return null
  return release.assets.find((a) => /\.apk$/i.test(a.name)) || null
}

async function downloadApk(asset, onProgress) {
  const { Filesystem, Directory } = await import(/* @vite-ignore */ '@capacitor/filesystem')

  const res = await fetch(asset.browser_download_url)
  if (!res.ok) throw new Error(`Download failed (${res.status})`)

  const total = Number(res.headers.get('content-length')) || asset.size || 0
  const reader = res.body.getReader()
  const chunks = []
  let received = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    received += value.length
    if (onProgress && total) onProgress(received / total)
  }

  // Concatenate to a single Uint8Array, then base64.
  const merged = new Uint8Array(received)
  let offset = 0
  for (const c of chunks) {
    merged.set(c, offset)
    offset += c.length
  }
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < merged.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, merged.subarray(i, i + CHUNK))
  }
  const base64 = btoa(binary)

  const fileName = asset.name
  await Filesystem.writeFile({
    path: fileName,
    data: base64,
    directory: Directory.External,
    recursive: true,
  })
  const uriRes = await Filesystem.getUri({ path: fileName, directory: Directory.External })
  return uriRes.uri
}

async function openApk(fileUri) {
  const { FileOpener } = await import(/* @vite-ignore */ '@capacitor-community/file-opener')
  await FileOpener.open({
    filePath: fileUri,
    contentType: 'application/vnd.android.package-archive',
  })
}

/**
 * Check GitHub for a newer release. Returns:
 *   { available: false } — already on latest
 *   { available: true, version, asset, release } — newer APK found
 *   null — skipped (cooldown, wrong platform, etc.)
 *
 * `force=true` ignores the cooldown.
 */
export async function checkForUpdate({ force = false } = {}) {
  if (!isAndroid()) return null

  if (!force) {
    const last = Number(localStorage.getItem(LAST_CHECK_KEY) || 0)
    if (Date.now() - last < CHECK_COOLDOWN_MS) return null
  }

  let installed
  try {
    installed = await getInstalledVersion()
  } catch (e) {
    console.warn('[androidUpdater] cannot read installed version', e)
    return null
  }

  let release
  try {
    release = await fetchLatestRelease()
  } catch (e) {
    console.warn('[androidUpdater] release lookup failed', e)
    return null
  }

  localStorage.setItem(LAST_CHECK_KEY, String(Date.now()))

  const latest = String(release.tag_name || release.name || '').replace(/^v/, '')
  if (!latest) return { available: false }

  const skipped = localStorage.getItem(SKIP_VERSION_KEY)
  if (!force && skipped === latest) return { available: false }

  if (compareSemver(latest, installed) <= 0) return { available: false }

  const asset = pickApkAsset(release)
  if (!asset) {
    console.warn('[androidUpdater] release has no .apk asset')
    return { available: false }
  }

  return { available: true, version: latest, installed, asset, release }
}

/**
 * Download the APK and trigger the system installer.
 * `onProgress` receives a number in [0, 1].
 */
export async function downloadAndInstall(asset, onProgress) {
  const fileUri = await downloadApk(asset, onProgress)
  await openApk(fileUri)
}

/** Persist the user's choice to skip a specific version. */
export function skipVersion(version) {
  localStorage.setItem(SKIP_VERSION_KEY, String(version).replace(/^v/, ''))
}

export const __testing = { compareSemver, pickApkAsset }
