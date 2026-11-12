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
      const keyboard = full - vv.height > 120
      let height = vv.height
      // A home screen app on newer iOS reports a screen shorter than it is, by the strip behind the clock, so
      // the app stopped short and left a blank band above the home bar. Without the keyboard, use the real
      // screen height when the shortfall is that strip (under 100px), not anything bigger.
      if (standalone && !keyboard) {
        const screenHeight = window.innerWidth < window.innerHeight ? screen.height : screen.width
        if (screenHeight > height && screenHeight - height < 100) height = screenHeight
      }
      root.style.setProperty('--app-height', `${Math.round(height)}px`)
      // The keyboard covers the home bar, so the bottom safe-area padding is not needed while it is up.
      root.classList.toggle('keyboard-open', keyboard)
      if (window.scrollY !== 0) window.scrollTo(0, 0)
    }
    update()
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    window.addEventListener('orientationchange', onRotate)
    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
      window.removeEventListener('orientationchange', onRotate)
      root.style.removeProperty('--app-height')
      root.classList.remove('keyboard-open')
    }
  }, [])
}
