const LAST_MAILBOX = 'ansa-last-mailbox'
/** The mailbox this browser was last in. Shell records it whenever a mailbox is open. */
export function lastMailbox(): number | null {
  try {
    return Number(localStorage.getItem(LAST_MAILBOX)) || null
  } catch {
    return null
  }
}
export function rememberMailbox(id: number) {
  try {
    localStorage.setItem(LAST_MAILBOX, String(id))
  } catch {
    /* private mode */
  }
}
