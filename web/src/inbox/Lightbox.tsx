import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight, Download, ExternalLink, X } from 'lucide-react'
import { fileSize } from '../lib/format'

export interface LightboxImage {
  url: string
  filename: string
  size?: number
}

export const isImageType = (mime: string) => /^image\/(png|jpe?g|gif|webp)$/.test(mime)

const LightboxContext = createContext<(url: string, fallback?: LightboxImage) => void>(() => {})
/** Open an image over the page. Pass the image's URL; it opens in the set it belongs to, so the arrows work. */
export const useLightbox = () => useContext(LightboxContext)

/**
 * Shows the images of one conversation large, one at a time.
 * `images` is every image that can be opened, in reading order.
 */
export function LightboxProvider({ images, children }: { images: LightboxImage[]; children: ReactNode }) {
  // The set is fixed when the lightbox opens, so new mail arriving does not move the picture you are looking at.
  const [open, setOpen] = useState<{ items: LightboxImage[]; index: number } | null>(null)
  const show = useCallback(
    (url: string, fallback?: LightboxImage) => {
      const index = images.findIndex((image) => image.url === url)
      if (index >= 0) setOpen({ items: images, index })
      else setOpen({ items: [fallback ?? { url, filename: 'Image' }], index: 0 })
    },
    [images],
  )
  return (
    <LightboxContext.Provider value={show}>
      {children}
      {open && <Lightbox items={open.items} index={open.index} onIndex={(index) => setOpen({ ...open, index })} onClose={() => setOpen(null)} />}
    </LightboxContext.Provider>
  )
}

function Lightbox({ items, index, onIndex, onClose }: { items: LightboxImage[]; index: number; onIndex: (index: number) => void; onClose: () => void }) {
  const image = items[index]
  const many = items.length > 1
  const closeButton = useRef<HTMLButtonElement>(null)
  const [loaded, setLoaded] = useState(false)
  useEffect(() => setLoaded(false), [image.url])
  const step = useMemo(() => (delta: number) => onIndex((index + delta + items.length) % items.length), [index, items.length, onIndex])

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    closeButton.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowRight' && many) step(1)
      else if (e.key === 'ArrowLeft' && many) step(-1)
      else if (e.key !== 'Tab') return
      // Keep the page's own shortcuts out of it while the picture is open.
      if (e.key !== 'Tab') {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    // Capture, so this runs before the conversation's Escape handler.
    document.addEventListener('keydown', onKey, true)
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.body.style.overflow = overflow
      previous?.focus?.()
    }
  }, [many, onClose, step])

  const tool = 'flex size-9 shrink-0 items-center justify-center rounded-lg text-white/80 transition-colors hover:bg-white/15 hover:text-white focus-visible:outline-white'
  const arrow = 'absolute top-1/2 z-10 flex size-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-white transition-colors hover:bg-black/70 focus-visible:outline-white'

  return (
    <div role="dialog" aria-modal="true" aria-label={`Image: ${image.filename}`} className="animate-fade fixed inset-0 z-[70] flex flex-col bg-black/90" onClick={onClose}>
      <div className="flex h-14 shrink-0 items-center gap-1 pr-2 pl-4 text-white" onClick={(e) => e.stopPropagation()}>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{image.filename}</p>
          <p className="text-xs text-white/60 tabular-nums">
            {many && `${index + 1} of ${items.length}`}
            {many && image.size ? ' · ' : ''}
            {image.size ? fileSize(image.size) : ''}
          </p>
        </div>
        <a href={`${image.url}${image.url.includes('?') ? '&' : '?'}download`} download={image.filename} aria-label="Download" title="Download" className={tool}>
          <Download className="size-[18px]" aria-hidden />
        </a>
        <a href={image.url} target="_blank" rel="noreferrer" aria-label="Open in a new tab" title="Open in a new tab" className={tool}>
          <ExternalLink className="size-[18px]" aria-hidden />
        </a>
        <button ref={closeButton} type="button" aria-label="Close" title="Close (Esc)" onClick={onClose} className={tool}>
          <X className="size-5" aria-hidden />
        </button>
      </div>

      <div className="relative flex min-h-0 flex-1 items-center justify-center px-4 pb-6 sm:px-16">
        {many && (
          <button
            type="button"
            aria-label="Previous image"
            onClick={(e) => {
              e.stopPropagation()
              step(-1)
            }}
            className={`${arrow} left-2 sm:left-4`}
          >
            <ChevronLeft className="size-6" aria-hidden />
          </button>
        )}
        <img
          key={image.url}
          src={image.url}
          alt={image.filename}
          onLoad={() => setLoaded(true)}
          onClick={(e) => e.stopPropagation()}
          className={`max-h-full max-w-full rounded-md object-contain shadow-2xl transition-opacity duration-150 ${loaded ? 'opacity-100' : 'opacity-0'}`}
        />
        {!loaded && <span className="absolute text-sm text-white/60">Loading…</span>}
        {many && (
          <button
            type="button"
            aria-label="Next image"
            onClick={(e) => {
              e.stopPropagation()
              step(1)
            }}
            className={`${arrow} right-2 sm:right-4`}
          >
            <ChevronRight className="size-6" aria-hidden />
          </button>
        )}
      </div>
    </div>
  )
}
