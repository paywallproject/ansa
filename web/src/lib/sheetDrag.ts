import { useRef, type TouchEvent } from 'react'

/**
 * Swipe a bottom sheet down to close it, as on iOS. The sheet follows the finger; let go past a quarter of its
 * height (or with a quick flick) and it closes, otherwise it springs back. A drag only starts when the list inside
 * is scrolled to the top, so scrolling the sheet's content still works.
 */
export function useSheetDrag(onClose: () => void) {
  const sheet = useRef<HTMLDivElement>(null)
  const start = useRef<{ y: number; t: number; dragging: boolean; armed: boolean } | null>(null)

  const scrolledDown = (target: EventTarget) => {
    for (let el = target as HTMLElement | null; el && el !== sheet.current; el = el.parentElement) {
      if (el.scrollTop > 0) return true
    }
    return false
  }
  const set = (y: number, animate: boolean) => {
    const el = sheet.current
    if (!el) return
    el.style.transition = animate ? 'transform 200ms ease-out' : 'none'
    el.style.transform = y ? `translateY(${y}px)` : ''
  }

  return {
    ref: sheet,
    onTouchStart: (e: TouchEvent) => {
      // Text fields keep their own touch handling.
      const armed = !scrolledDown(e.target) && !(e.target as HTMLElement).closest('input, textarea')
      start.current = { y: e.touches[0].clientY, t: Date.now(), dragging: false, armed }
    },
    onTouchMove: (e: TouchEvent) => {
      const s = start.current
      if (!s?.armed) return
      const dy = e.touches[0].clientY - s.y
      if (!s.dragging) {
        if (dy < 6) {
          if (dy < -6) s.armed = false
          return
        }
        s.dragging = true
      }
      set(Math.max(0, dy), false)
    },
    onTouchEnd: (e: TouchEvent) => {
      const s = start.current
      start.current = null
      if (!s?.dragging) return
      const dy = e.changedTouches[0].clientY - s.y
      const fast = dy / Math.max(1, Date.now() - s.t) > 0.6
      const height = sheet.current?.offsetHeight ?? 400
      if (dy > height / 4 || (fast && dy > 40)) {
        set(height, true)
        setTimeout(onClose, 180)
      } else set(0, true)
    },
  }
}
