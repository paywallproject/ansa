import { useEffect, useRef, useState, type ReactNode } from 'react'
import { cx } from '../ui'

export interface SwipeAction {
  label: string
  icon: ReactNode
  /** Background of the tile the swipe reveals, e.g. "bg-ok". */
  tone: string
  onCommit: () => void
}

/** Where a row rests when it's left open on its action tile. */
const OPEN = 132
/** The gap between the card and its action tile, plus the tile's margin from the screen edge. */
const TILE_INSET = 20
/** A full swipe: past this share of the row's width, letting go does the action at once. */
const FULL = 0.55

/**
 * A list row you can swipe on a touch screen, as in Help Scout and iOS Mail. Swiping left reveals `end` (on the
 * right), swiping right reveals `start` (on the left). Let go part way and the row stays open on the action's
 * tile: tap the tile to do it, tap anywhere else to close it, or keep sliding. Swipe all the way and letting go
 * does the action. Vertical scrolling stays with the browser (touch-action: pan-y), and a swipe never also opens the row.
 */
export function SwipeRow({ className, contentClassName, children, start, end }: { className?: string; contentClassName?: string; children: ReactNode; start?: SwipeAction; end?: SwipeAction }) {
  const [dx, setDx] = useState(0)
  const [settling, setSettling] = useState(false)
  // The resting offset: 0, or ±OPEN while the row is left open on a tile.
  const [rest, setRest] = useState(0)
  const gesture = useRef<{ x: number; y: number; base: number; horizontal: boolean | null; width: number } | null>(null)
  const moved = useRef(false)
  const row = useRef<HTMLLIElement>(null)
  const tile = useRef<HTMLButtonElement>(null)

  const settle = (to: number) => {
    setSettling(true)
    setDx(to)
    setRest(to)
  }
  const close = () => settle(0)

  const commit = (action: SwipeAction, side: number) => {
    // Slide off, do it, then come back. A row the action takes out of the list is hidden by its owner in the same render.
    setSettling(true)
    setRest(0)
    setDx(side * (row.current?.clientWidth ?? window.innerWidth))
    window.setTimeout(() => {
      action.onCommit()
      setSettling(false)
      setDx(0)
    }, 180)
  }

  // While open, touching anywhere outside this row closes it (as scrolling the list or swiping another row would).
  useEffect(() => {
    if (!rest) return
    const onTouch = (e: TouchEvent) => {
      if (!row.current?.contains(e.target as Node)) close()
    }
    document.addEventListener('touchstart', onTouch, { capture: true, passive: true })
    return () => document.removeEventListener('touchstart', onTouch, { capture: true })
  }, [rest])

  const action = dx > 0 ? start : dx < 0 ? end : undefined
  const full = gesture.current && Math.abs(dx) >= gesture.current.width * FULL

  return (
    <li
      ref={row}
      className={cx('relative overflow-hidden', className)}
      style={{ touchAction: 'pan-y' }}
      onTouchStart={(e) => {
        moved.current = false
        if (e.touches.length !== 1 || !window.matchMedia('(pointer: coarse)').matches) return (gesture.current = null)
        if (tile.current?.contains(e.target as Node)) return (gesture.current = null)
        gesture.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, base: rest, horizontal: null, width: e.currentTarget.clientWidth }
        setSettling(false)
      }}
      onTouchMove={(e) => {
        const g = gesture.current
        if (!g) return
        const x = e.touches[0].clientX - g.x
        const y = e.touches[0].clientY - g.y
        if (g.horizontal === null) {
          if (Math.abs(x) < 8 && Math.abs(y) < 8) return
          g.horizontal = Math.abs(x) > Math.abs(y)
        }
        if (!g.horizontal) return
        moved.current = true
        // Only toward a side that has an action, with resistance near the far edge.
        const raw = g.base + x
        const pull = (raw > 0 ? !!start : !!end) ? raw : 0
        const limit = g.width - TILE_INSET
        setDx(Math.abs(pull) > limit ? Math.sign(pull) * (limit + (Math.abs(pull) - limit) * 0.25) : pull)
      }}
      onTouchEnd={() => {
        const g = gesture.current
        gesture.current = null
        if (!g?.horizontal) return
        const side = Math.sign(dx)
        const a = dx > 0 ? start : end
        if (!a || !side) return close()
        if (Math.abs(dx) >= g.width * FULL) commit(a, side)
        else if (Math.abs(dx) >= OPEN / 2) settle(side * OPEN)
        else close()
      }}
      onTouchCancel={() => {
        gesture.current = null
        settle(rest)
      }}
      onClickCapture={(e) => {
        if (moved.current) {
          e.preventDefault()
          e.stopPropagation()
          moved.current = false
        } else if (rest && !tile.current?.contains(e.target as Node)) {
          // A tap on an open row closes it rather than opening the conversation.
          e.preventDefault()
          e.stopPropagation()
          close()
        }
      }}
    >
      {dx !== 0 && action && (
        // As in Help Scout: the row lifts into a card, and the action waits beside it as a tile, icon over label.
        <button
          ref={tile}
          type="button"
          tabIndex={rest ? 0 : -1}
          aria-hidden={!rest}
          onClick={() => commit(action, Math.sign(dx))}
          className={cx('absolute inset-y-0 flex flex-col items-center justify-center gap-1 overflow-hidden rounded-2xl text-sm font-medium text-white', action.tone, dx > 0 ? 'left-2' : 'right-2')}
          style={{ width: Math.max(0, Math.abs(dx) - TILE_INSET) }}
        >
          <span className={cx('flex flex-col items-center gap-1 whitespace-nowrap transition', full ? 'scale-110' : Math.abs(dx) > 48 ? 'opacity-100' : 'opacity-0')}>
            {action.icon}
            {action.label}
          </span>
        </button>
      )}
      <div
        className={cx('relative flex', contentClassName ?? 'bg-surface', dx !== 0 && 'rounded-2xl shadow-[0_1px_4px_rgb(0_0_0/0.08)] ring-1 ring-inset ring-line', settling && 'transition-transform duration-200 ease-out')}
        style={{ transform: dx ? `translateX(${dx}px)` : undefined }}
      >
        {children}
      </div>
    </li>
  )
}
