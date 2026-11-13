import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { cx } from './ui'

/** How far to pull, in pixels after damping, before letting go refreshes. */
const THRESHOLD = 64
const MAX = 120
/** The gap held open under the header while it refreshes. */
const HOLD = 56
const SPINNER = 28
const EASE = 'transform 0.3s cubic-bezier(0.2, 0.8, 0.2, 1)'

/** The nearest element that scrolls vertically and is scrolled away from its top, if any. */
function scrolledAncestor(start: Element | null): Element | null {
  for (let el = start; el && el !== document.documentElement; el = el.parentElement) {
    const style = getComputedStyle(el)
    if (/(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight && el.scrollTop > 0) return el
  }
  return null
}

/** What slides down with the finger: the list or page under it, so the header above it stays put. */
function pane(start: Element): HTMLElement | null {
  for (let el: Element | null = start; el && el !== document.body; el = el.parentElement) {
    if (el.tagName === 'MAIN') return el as HTMLElement
    if (/(auto|scroll)/.test(getComputedStyle(el).overflowY)) return el as HTMLElement
  }
  return document.querySelector('main')
}

/** The iOS activity indicator: eight gray spokes, shown one by one as you pull, then turning while it refreshes. */
function Spokes({ shown, spinning }: { shown: number; spinning: boolean }) {
  return (
    <svg viewBox="0 0 28 28" width={SPINNER} height={SPINNER} className={cx('text-fg-3', spinning && 'animate-spokes')} aria-hidden>
      {Array.from({ length: 8 }, (_, i) => (
        <line
          key={i}
          x1="14"
          y1="3.5"
          x2="14"
          y2="8.5"
          stroke="currentColor"
          strokeWidth="2.6"
          strokeLinecap="round"
          transform={`rotate(${i * 45} 14 14)`}
          // Spinning, the spokes fade around the circle; pulling, each one appears in turn.
          opacity={spinning ? 1 - ((8 - i) % 8) * 0.1 : i < shown ? 0.75 : 0}
        />
      ))}
    </svg>
  )
}

/**
 * Pull down to refresh, on touch screens, as in the Help Scout app. A home screen app on a phone has no browser
 * pull-to-refresh of its own. The list slides down under the header and a spinner fills the gap.
 * A pull starts only when what is under the finger is scrolled to its top, never in a field, an editor or a dialog,
 * and a sideways swipe cancels it. Letting go past the line refreshes everything on screen.
 */
export function PullToRefresh() {
  const client = useQueryClient()
  const [pull, setPull] = useState(0)
  const [top, setTop] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const gesture = useRef<{ x: number; y: number; active: boolean; pane: HTMLElement | null } | null>(null)
  const moved = useRef<HTMLElement | null>(null)
  const pullRef = useRef(0)
  const busy = useRef(false)

  useEffect(() => {
    if (!window.matchMedia('(pointer: coarse)').matches) return
    const set = (value: number, animate: boolean) => {
      pullRef.current = value
      setPull(value)
      const el = moved.current
      if (!el) return
      el.style.transition = animate ? EASE : 'none'
      if (value > 0) {
        el.style.transform = `translateY(${value}px)`
        return
      }
      el.style.transform = 'translateY(0)'
      // Leave no transform behind once it is back: a transformed element would trap anything fixed inside it.
      const reset = () => {
        if (pullRef.current === 0 && moved.current === el) {
          el.style.transform = ''
          el.style.transition = ''
          moved.current = null
        }
      }
      if (animate) setTimeout(reset, 320)
      else reset()
    }
    const onStart = (e: TouchEvent) => {
      gesture.current = null
      if (busy.current || e.touches.length !== 1) return
      const target = e.target as Element | null
      if (!target || target.closest('input, textarea, select, [contenteditable=true], [role=dialog], [data-no-pull]')) return
      if (scrolledAncestor(target)) return
      gesture.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, active: false, pane: pane(target) }
    }
    const onMove = (e: TouchEvent) => {
      const g = gesture.current
      if (!g) return
      const dx = e.touches[0].clientX - g.x
      const dy = e.touches[0].clientY - g.y
      if (!g.active) {
        // Decide on the first clear movement: down starts a pull, anything else lets the page have it.
        if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return
        if (dy <= 0 || Math.abs(dx) > Math.abs(dy)) {
          gesture.current = null
          return
        }
        g.active = true
        moved.current = g.pane
        setTop(g.pane ? g.pane.getBoundingClientRect().top : 0)
        setDragging(true)
      }
      // Resistance: the further you pull, the slower it follows.
      set(Math.min(MAX, Math.max(0, dy) * 0.5), false)
      if (e.cancelable) e.preventDefault()
    }
    const onEnd = async () => {
      const g = gesture.current
      gesture.current = null
      if (!g?.active) return
      setDragging(false)
      if (pullRef.current < THRESHOLD) return set(0, true)
      busy.current = true
      setRefreshing(true)
      set(HOLD, true)
      const started = Date.now()
      try {
        await client.invalidateQueries({ refetchType: 'active' })
      } finally {
        // Long enough to see that something happened.
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, 600 - (Date.now() - started))))
        busy.current = false
        setRefreshing(false)
        set(0, true)
      }
    }
    document.addEventListener('touchstart', onStart, { passive: true })
    document.addEventListener('touchmove', onMove, { passive: false })
    document.addEventListener('touchend', onEnd)
    document.addEventListener('touchcancel', onEnd)
    return () => {
      document.removeEventListener('touchstart', onStart)
      document.removeEventListener('touchmove', onMove)
      document.removeEventListener('touchend', onEnd)
      document.removeEventListener('touchcancel', onEnd)
      if (moved.current) {
        moved.current.style.transform = ''
        moved.current.style.transition = ''
      }
    }
  }, [client])

  if (pull === 0 && !refreshing) return null
  const ready = pull >= THRESHOLD
  // The spinner sits in the middle of the gap, and stays near the top of it once the gap is wider than it needs.
  const offset = Math.max(0, Math.min(pull, HOLD) - SPINNER) / 2
  return (
    <div
      className="pointer-events-none fixed inset-x-0 z-20 flex justify-center"
      style={{ top: top + offset, transition: dragging ? 'none' : 'top 0.3s ease, opacity 0.2s ease', opacity: refreshing || pull > 8 ? 1 : 0 }}
      role="status"
      aria-label={refreshing ? 'Refreshing' : ready ? 'Release to refresh' : 'Pull to refresh'}
    >
      <Spokes shown={Math.ceil((pull / THRESHOLD) * 8)} spinning={refreshing} />
    </div>
  )
}
