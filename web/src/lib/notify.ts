/**
 * Notifications for live chat, on this device: a banner when a new chat starts, or a visitor writes in a chat
 * that is unassigned or yours. Off until turned on in Profile, since the browser asks for permission.
 * They show while the app is open somewhere, a background tab or a minimised window included.
 */
const KEY = 'ansa-chat-notify'

export const notifySupported = () => typeof window !== 'undefined' && 'Notification' in window

export function notifyEnabled(): boolean {
  try {
    return notifySupported() && Notification.permission === 'granted' && localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

/** The service worker shows notifications where `new Notification()` cannot (an iPhone home screen app). */
async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null
  try {
    return (await navigator.serviceWorker.getRegistration('/')) ?? (await navigator.serviceWorker.register('/sw.js', { scope: '/' }))
  } catch {
    return null
  }
}

export async function setNotifyEnabled(on: boolean): Promise<{ ok: boolean; message?: string }> {
  if (on) {
    if (!notifySupported()) return { ok: false, message: 'This browser cannot show notifications. On an iPhone, add the app to your home screen and turn this on from there.' }
    const answer = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission().catch(() => 'denied' as NotificationPermission)
    if (answer !== 'granted') return { ok: false, message: 'Notifications are blocked for this site. Allow them in your browser’s site settings, then try again.' }
    await registration()
  }
  try {
    localStorage.setItem(KEY, on ? '1' : '0')
  } catch {
    /* private mode */
  }
  return { ok: true }
}

/** The service worker once it is running. Right after it is registered it is still starting, and cannot show anything yet. */
async function activeRegistration(): Promise<ServiceWorkerRegistration | null> {
  const reg = await registration()
  if (!reg) return null
  if (reg.active) return reg
  const ready = navigator.serviceWorker.ready.then((r) => (r.active ? r : null))
  return Promise.race([ready, new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000))]).catch(() => null)
}

/**
 * Show a notification. Tapping it opens `url`. The tag replaces an older one for the same chat, so open tabs do
 * not stack copies. Through the service worker when it runs (the only way on an iPhone); otherwise, on a computer,
 * as a plain browser notification. Returns false when nothing could be shown.
 */
export async function showNotification(title: string, body: string, url: string, tag: string, force = false): Promise<boolean> {
  if (!force && !notifyEnabled()) return false
  const options: NotificationOptions = { body, tag, icon: '/icon-192.png', badge: '/icon-192.png', data: { url } }
  const reg = await activeRegistration()
  if (reg) {
    try {
      await reg.showNotification(title, options)
      return true
    } catch {
      /* fall back below */
    }
  }
  try {
    const n = new Notification(title, options)
    n.onclick = () => {
      window.focus()
      window.location.assign(url)
      n.close()
    }
    return true
  } catch {
    return false
  }
}
