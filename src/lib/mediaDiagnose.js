// Why a dashcam clip (or snapshot) would not load, asked of the file route
// itself for two bytes — after the <video> or <img> has given up, which says
// only "error".
//
// The backend's file route (api/vssAlarms, /file) answers 404 for a file that
// is not there (or empty), 401 for a lapsed login, 403 for no access and 502
// when the video host refused or failed.
//
// → 'ok'       the file came, so the browser could not DECODE it (H.265)
//   'missing'  not uploaded yet, empty, or deleted
//   'session'  sign-in lapsed
//   'denied'   this account may not see it
//   'refused'  the video host said no or broke
//   'error'    anything else (offline, …)

export async function diagnoseMedia(url) {
  if (!url) return 'missing'
  try {
    const res = await fetch(url, { credentials: 'include', headers: { Range: 'bytes=0-1' } })
    if (res.ok) return 'ok'
    if (res.status === 404) return 'missing'
    if (res.status === 401) return 'session'
    if (res.status === 403) return 'denied'
    if (res.status === 502) return 'refused'
    return 'error'
  } catch {
    return 'error'
  }
}
