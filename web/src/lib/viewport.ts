import { useEffect } from 'react'

/**
 * Fit the app to the part of the screen the keyboard leaves visible. iOS does not shrink the page when the keyboard
 * opens; it slides the whole page up, pushing the top bar off screen and leaving a gap above the keyboard. Here the
 * app takes the visible height (--app-height) and the page is held at the top, so the conversation stays in view and
 * the composer sits right on the keyboard.
 */
export function useVisualViewport() {
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv || !window.matchMedia('(pointer: coarse)').matches) return
    const root = document.documentElement
    // The tallest the visible area has been: the screen without a keyboard. Some iOS versions shrink the page along
    // with the keyboard, so comparing with window.innerHeight would never see the keyboard open.
    let full = vv.height
    const onRotate = () => {
      full = 0
    }
    const standalone = window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true
    const update = () => {
      full = Math.max(full, vv.height)
      // Only a focused text field brings the keyboard up. iOS can keep reporting the shorter height after the
      // keyboard has gone (put away while the app was in the background, or with no resize to follow), which left
      // the app drawn on the top half of the screen with a blank band below. With no field focused, the screen is
      // all ours.
      const short = full - vv.height > 120
      const keyboard = short && typing()
      let height = short && !keyboard ? full : vv.height
      // A home screen app on newer iOS reports a page shorter than the screen, by the strip behind the clock.
      // The screen below is still ours to draw on. Without the keyboard, take the real screen height when the
      // shortfall is that strip (under 100px). html and body take it too (see index.css): sized to the reported
      // height, they cut off whatever reached below it.
      if (standalone && !keyboard) {
        const screenHeight = window.innerWidth < window.innerHeight ? screen.height : screen.width
        if (screenHeight > height && screenHeight - height < 100) height = screenHeight
      }
      root.style.setProperty('--app-height', `${Math.round(height)}px`)
      // The keyboard covers the home bar, so the bottom safe-area padding is not needed while it is up.
      root.classList.toggle('keyboard-open', keyboard)
      if (window.scrollY !== 0) window.scrollTo(0, 0)
    }
    // Leaving a field or coming back to the app may bring no resize: look again once the keyboard has had time to go.
    let timer = 0
    const later = () => {
      update()
      window.clearTimeout(timer)
      timer = window.setTimeout(update, 400)
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') later()
    }
    update()
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    window.addEventListener('orientationchange', onRotate)
    window.addEventListener('pageshow', later)
    document.addEventListener('focusout', later)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearTimeout(timer)
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
      window.removeEventListener('orientationchange', onRotate)
      window.removeEventListener('pageshow', later)
      document.removeEventListener('focusout', later)
      document.removeEventListener('visibilitychange', onVisible)
      root.style.removeProperty('--app-height')
      root.classList.remove('keyboard-open')
    }
  }, [])
}

const NO_KEYBOARD = new Set(['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'])

/** Whether the focused element is one the keyboard comes up for. */
function typing() {
  const el = document.activeElement
  if (!(el instanceof HTMLElement)) return false
  if (el.isContentEditable || el instanceof HTMLTextAreaElement) return true
  return el instanceof HTMLInputElement && !NO_KEYBOARD.has(el.type)
}
