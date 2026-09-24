/**
 * Actualización de la APK sideload (fuera de Play Store).
 *
 * Consulta la API de releases de GitHub, y si hay una versión más nueva
 * descarga el .apk y se lo pasa al instalador del sistema. El último paso
 * siempre es un diálogo de Android que el usuario confirma: una app normal
 * no puede instalar nada en silencio.
 *
 * ⚠️ CORS — el motivo por el que la descarga NO usa `fetch`:
 * la WebView tiene origen `https://localhost`, así que todo `fetch` pasa por
 * CORS. `api.github.com` responde con `Access-Control-Allow-Origin: *` y se
 * puede consultar sin problema, pero la URL de descarga de un asset redirige
 * a `release-assets.githubusercontent.com`, que NO manda esa cabecera: la
 * WebView cancela la petición y la actualización falla siempre.
 * Por eso el binario lo baja `Filesystem.downloadFile`, que en Android es una
 * HttpURLConnection nativa — ni CORS, ni pasar 4 MB en base64 por el puente.
 *
 * Fuera de Capacitor/Android todo esto es un no-op.
 */

const REPO_OWNER = 'DKNS-JCC'
const REPO_NAME = 'Calculadora'
const RELEASES_URL = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`
const CHECK_COOLDOWN_MS = 24 * 60 * 60 * 1000
const LAST_CHECK_KEY = 'androidUpdater:lastCheck'
const SKIP_VERSION_KEY = 'androidUpdater:skipVersion'

export function isAndroid() {
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
  if (!res.ok) {
    // 404 en un repo privado, 403 cuando GitHub limita las peticiones anónimas.
    throw new Error(`GitHub respondió ${res.status}`)
  }
  return res.json()
}

function pickApkAsset(release) {
  if (!release || !Array.isArray(release.assets)) return null
  return release.assets.find((a) => /\.apk$/i.test(a.name)) || null
}

/** Nombre de fichero seguro para el directorio de caché. */
function cacheNameFor(asset) {
  return String(asset?.name || 'update.apk').replace(/[^A-Za-z0-9._-]/g, '_')
}

/**
 * Estado de la comprobación. `status` distingue "no hay nada" de "está roto",
 * que es justo lo que la comprobación automática no puede contar (calla los
 * errores a propósito) y la manual sí.
 *
 *   unsupported · cooldown · uptodate · skipped · no-asset · error · available
 */
export async function checkForUpdate({ force = false } = {}) {
  if (!isAndroid()) return { status: 'unsupported', available: false }

  if (!force) {
    const last = Number(localStorage.getItem(LAST_CHECK_KEY) || 0)
    if (Date.now() - last < CHECK_COOLDOWN_MS) return { status: 'cooldown', available: false }
  }

  let installed
  try {
    installed = await getInstalledVersion()
  } catch (e) {
    return { status: 'error', available: false, message: `No se pudo leer la versión instalada: ${e.message}` }
  }

  let release
  try {
    release = await fetchLatestRelease()
  } catch (e) {
    return { status: 'error', available: false, installed, message: e.message }
  }

  localStorage.setItem(LAST_CHECK_KEY, String(Date.now()))

  const version = String(release.tag_name || release.name || '').replace(/^v/, '')
  if (!version) {
    return { status: 'error', available: false, installed, message: 'La release no tiene etiqueta de versión.' }
  }

  if (compareSemver(version, installed) <= 0) {
    return { status: 'uptodate', available: false, installed, version }
  }

  // El descarte es sólo para el aviso automático: una comprobación manual
  // siempre enseña lo que hay.
  if (!force && localStorage.getItem(SKIP_VERSION_KEY) === version) {
    return { status: 'skipped', available: false, installed, version }
  }

  const asset = pickApkAsset(release)
  if (!asset) {
    return { status: 'no-asset', available: false, installed, version, message: 'La release no incluye ningún .apk.' }
  }

  return { status: 'available', available: true, version, installed, asset, release }
}

/**
 * Descarga la APK al directorio de caché y lanza el instalador del sistema.
 * `onProgress` recibe un número en [0, 1]; puede no llamarse nunca si el
 * servidor no manda `content-length`.
 */
export async function downloadAndInstall(asset, onProgress) {
  const { Filesystem, Directory } = await import(/* @vite-ignore */ '@capacitor/filesystem')
  const { FileOpener } = await import(/* @vite-ignore */ '@capacitor-community/file-opener')

  const fileName = cacheNameFor(asset)
  await cleanupOldApks(Filesystem, Directory, fileName)

  let listener = null
  if (onProgress) {
    listener = await Filesystem.addListener('progress', ({ bytes, contentLength }) => {
      const total = Number(contentLength) || Number(asset.size) || 0
      if (total > 0) onProgress(Math.min(1, Number(bytes) / total))
    })
  }

  try {
    await Filesystem.downloadFile({
      url: asset.browser_download_url,
      path: fileName,
      directory: Directory.Cache,
      progress: !!onProgress,
    })
  } finally {
    await listener?.remove()
  }

  // El .apk vive en cacheDir, que el file_paths del FileOpener ya expone como
  // content:// — sin eso el instalador recibe un file:// y Android lo rechaza.
  const { uri } = await Filesystem.getUri({ path: fileName, directory: Directory.Cache })
  await FileOpener.open({
    filePath: uri,
    contentType: 'application/vnd.android.package-archive',
    openWithDefault: true,
  })
}

/** Borra descargas anteriores para no dejar APKs viejas ocupando la caché. */
async function cleanupOldApks(Filesystem, Directory, keep) {
  try {
    const { files } = await Filesystem.readdir({ path: '', directory: Directory.Cache })
    for (const f of files) {
      const name = typeof f === 'string' ? f : f.name
      if (name !== keep && /\.apk$/i.test(name)) {
        await Filesystem.deleteFile({ path: name, directory: Directory.Cache }).catch(() => {})
      }
    }
  } catch {
    // La limpieza es opcional: si falla, la actualización sigue adelante.
  }
}

/** Recuerda que el usuario no quiere el aviso de esta versión. */
export function skipVersion(version) {
  localStorage.setItem(SKIP_VERSION_KEY, String(version).replace(/^v/, ''))
}

/** Texto listo para enseñar tras una comprobación manual. */
export function describeCheck(result) {
  if (!result) return 'No se pudo comprobar.'
  switch (result.status) {
    case 'unsupported': return 'Las actualizaciones automáticas sólo funcionan en la app de Android.'
    case 'uptodate': return `Estás en la última versión (${result.installed}).`
    case 'skipped': return `Hay una versión ${result.version}, pero la descartaste.`
    case 'no-asset': return result.message
    case 'error': return `No se pudo comprobar: ${result.message}`
    case 'available': return `Versión ${result.version} disponible (tienes la ${result.installed}).`
    default: return 'Sin novedades.'
  }
}

export const __testing = { compareSemver, pickApkAsset, cacheNameFor }
