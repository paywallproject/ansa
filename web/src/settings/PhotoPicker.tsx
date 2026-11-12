import { useRef } from 'react'
import { useMutation } from '@tanstack/react-query'
import { ImageUp, Trash2 } from 'lucide-react'
import { api } from '../lib/api'
import type { User } from '../lib/types'
import { Avatar, Button, useFeedback } from '../ui'

const SIZE = 256

/** Crop the middle square of an image and shrink it to 256 pixels, so a photo from a phone uploads small. */
async function squarePhoto(file: File): Promise<File> {
  const url = URL.createObjectURL(file)
  try {
    const image = new Image()
    image.src = url
    await image.decode().catch(() => {
      throw new Error('That file is not an image this browser can open.')
    })
    const side = Math.min(image.naturalWidth, image.naturalHeight)
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = SIZE
    const context = canvas.getContext('2d')!
    // Transparent areas become white rather than black in a JPEG.
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, SIZE, SIZE)
    context.imageSmoothingQuality = 'high'
    context.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, SIZE, SIZE)
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.88))
    if (!blob) throw new Error('Could not prepare the photo. Try another image.')
    return new File([blob], 'photo.jpg', { type: 'image/jpeg' })
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** Upload or remove a teammate's photo. `path` is /me/avatar, or /users/:id/avatar for an admin. */
export function PhotoPicker({ user, path, onChange }: { user: Pick<User, 'name' | 'color' | 'avatarUrl'>; path: string; onChange: () => void }) {
  const input = useRef<HTMLInputElement>(null)
  const { toast } = useFeedback()
  const onError = (err: Error) => toast(err.message, { kind: 'error' })
  const upload = useMutation({
    mutationFn: async (file: File) => api.upload(path, await squarePhoto(file)),
    onSuccess: () => {
      onChange()
      toast('Photo updated')
    },
    onError,
  })
  const remove = useMutation({
    mutationFn: () => api.del(path),
    onSuccess: () => {
      onChange()
      toast('Photo removed')
    },
    onError,
  })

  return (
    <div className="flex flex-wrap items-center gap-4">
      <Avatar name={user.name || '?'} color={user.color} src={user.avatarUrl} size={64} />
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap gap-2">
          <input
            ref={input}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) upload.mutate(file)
              e.target.value = ''
            }}
          />
          <Button icon={<ImageUp />} loading={upload.isPending} onClick={() => input.current?.click()}>
            {user.avatarUrl ? 'Change photo' : 'Upload photo'}
          </Button>
          {user.avatarUrl && (
            <Button variant="ghost" icon={<Trash2 />} loading={remove.isPending} onClick={() => remove.mutate()}>
              Remove
            </Button>
          )}
        </div>
        <p className="text-[13px] text-fg-3">Shown to your team, and to customers in live chat. The middle of the image is cropped to a square.</p>
      </div>
    </div>
  )
}
