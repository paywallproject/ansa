import { useRef, useState, type ReactNode } from 'react'
import { cx } from '../ui'

export interface SwipeAction {
  label: string
  icon: ReactNode
  /** Background of the panel the swipe reveals, e.g. "bg-ok". */
  tone: string
  onCommit: () => void
}

/** How far a row must travel before letting go does the action. */
const COMMIT = 96

/**
 * A list row you can swipe on a touch screen. Swiping left reveals `end` (on the right), swiping right reveals
 * `start` (on the left). Past the line, letting go does the action; short of it, the row slides back.
 * Vertical scrolling stays with the browser (touch-action: pan-y), and a swipe never also opens the row.
 */
export function SwipeRow({ className, contentClassName, children, start, end }: { className?: string; contentClassName?: string; children: ReactNode; start?: SwipeAction; end?: SwipeAction }) {
  const [dx, setDx] = useState(0)
  const [settling, setSettling] = useState(false)
  const gesture = useRef<{ x: number; y: number; horizontal: boolean | null; width: number } | null>(null)
  const moved = useRef(false)

  const reset = () => {
    setSettling(true)
    setDx(0)
  }

  return (
    <li
      className={cx('relative overflow-hidden', className)}
      style={{ touchAction: 'pan-y' }}
      onTouchStart={(e) => {
        moved.current = false
        if (e.touches.length !== 1 || !window.matchMedia('(pointer: coarse)').matches) return (gesture.current = null)
        gesture.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, horizontal: null, width: e.currentTarget.clientWidth }
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
        // Only toward a side that has an action, with resistance past the line.
        const allowed = x > 0 ? !!start : !!end
        const pull = allowed ? x : 0
        const limit = COMMIT * 1.6
        setDx(Math.abs(pull) > limit ? Math.sign(pull) * (limit + (Math.abs(pull) - limit) * 0.25) : pull)
      }}
      onTouchEnd={() => {
        const g = gesture.current
        gesture.current = null
        if (!g?.horizontal) return
        const action = dx > 0 ? start : end
        if (action && Math.abs(dx) >= COMMIT) {
          // Slide off, do it, then come back: the list refreshes and the row moves or leaves on its own.
          setSettling(true)
          setDx(Math.sign(dx) * g.width)
          window.setTimeout(() => {
            action.onCommit()
            setSettling(false)
            setDx(0)
          }, 180)
        } else reset()
      }}
      onTouchCancel={reset}
      onClickCapture={(e) => {
        if (moved.current) {
          e.preventDefault()
          e.stopPropagation()
          moved.current = false
        }
      }}
    >
      {dx !== 0 && (
        <div className={cx('absolute inset-0 flex items-center px-6 text-sm font-semibold text-white', dx > 0 ? cx(start?.tone, 'justify-start') : cx(end?.tone, 'justify-end'))} aria-hidden>
          <span className={cx('flex items-center gap-2 transition-transform', Math.abs(dx) >= COMMIT ? 'scale-110' : 'opacity-80')}>
            {dx > 0 ? start?.icon : end?.icon}
            {dx > 0 ? start?.label : end?.label}
          </span>
        </div>
      )}
      <div className={cx('relative flex', contentClassName ?? 'bg-surface', settling && 'transition-transform duration-200 ease-out')} style={{ transform: dx ? `translateX(${dx}px)` : undefined }}>
        {children}
      </div>
    </li>
  )
}
