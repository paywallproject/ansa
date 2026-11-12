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
    const update = () => {
      root.style.setProperty('--app-height', `${Math.round(vv.height)}px`)
      // The keyboard covers the home bar, so the bottom safe-area padding is not needed while it is up.
      root.classList.toggle('keyboard-open', window.innerHeight - vv.height > 120)
      if (window.scrollY !== 0) window.scrollTo(0, 0)
    }
    update()
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
      root.style.removeProperty('--app-height')
      root.classList.remove('keyboard-open')
    }
  }, [])
}
