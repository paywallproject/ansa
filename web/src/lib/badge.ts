/**
 * The count on the app icon: conversations waiting on you (Unassigned + Mine, across your mailboxes).
 * Uses the Badging API. On an iPhone it only works for an app added to the home screen, after notifications are
 * allowed, and it updates while the app is open or recently in the background.
 */
import { useEffect } from 'react'
import { useMailboxes } from './hooks'

const KEY = 'ansa-app-badge'

type BadgeNavigator = Navigator & { setAppBadge?: (count?: number) => Promise<void>; clearAppBadge?: () => Promise<void> }
const nav = () => navigator as BadgeNavigator

/** Running as an installed app (home screen, Dock), the only place an icon can show a count. */
export const runningAsApp = () =>
  typeof window !== 'undefined' && (window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true)

export const badgeSupported = () => typeof navigator !== 'undefined' && typeof nav().setAppBadge === 'function'

/** On for this device? Off until turned on in Profile, since iOS needs a notification permission for it. */
export function badgeEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

/** Turn the badge on or off. Turning it on asks for notification permission where the browser needs it. */
export async function setBadgeEnabled(on: boolean): Promise<{ ok: boolean; message?: string }> {
  if (on) {
    if (!badgeSupported()) return { ok: false, message: 'This browser cannot show a count on the app icon. On an iPhone, add the app to your home screen and open it from there.' }
    if (typeof Notification !== 'undefined' && Notification.permission !== 'granted') {
      const answer = await Notification.requestPermission().catch(() => 'denied' as NotificationPermission)
      if (answer !== 'granted') return { ok: false, message: 'Notifications were not allowed, so the icon cannot show a count. You can allow them in your phone’s Settings, under this app.' }
    }
  }
  try {
    localStorage.setItem(KEY, on ? '1' : '0')
  } catch {
    /* private mode */
  }
  if (!on) void nav().clearAppBadge?.().catch(() => {})
  window.dispatchEvent(new Event('ansa:badge'))
  return { ok: true }
}

/** Keep the icon's count in step with the folder counts. Mounted once, for the signed-in app. */
export function useAppBadge() {
  const mailboxes = useMailboxes()
  const count = (mailboxes.data ?? []).reduce((sum, m) => sum + m.counts.unassigned + m.counts.mine, 0)
  useEffect(() => {
    const apply = () => {
      if (!badgeSupported() || !badgeEnabled()) return
      void (count > 0 ? nav().setAppBadge!(count) : nav().clearAppBadge?.())?.catch(() => {})
    }
    apply()
    window.addEventListener('ansa:badge', apply)
    return () => window.removeEventListener('ansa:badge', apply)
  }, [count])
}
