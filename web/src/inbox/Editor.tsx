import { useEffect, useRef, useState, type ReactNode } from 'react'
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import { Bold, FileText, Italic, Link as LinkIcon, List, ListOrdered, Paperclip, TextQuote, X } from 'lucide-react'
import { api } from '../lib/api'
import { fileSize } from '../lib/format'
import type { Attachment } from '../lib/types'
import { Button, IconButton, Input, Popover, Spinner, cx, useFeedback } from '../ui'

export function useRichEditor(options: { content?: string; placeholder: string; onChange?: (html: string) => void; onSubmit?: () => void; onFocus?: () => void; editable?: boolean }) {
  const latest = useRef(options)
  latest.current = options
  return useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
        horizontalRule: false,
        link: { openOnClick: false, autolink: true, HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' } },
      }),
      Placeholder.configure({ placeholder: () => latest.current.placeholder }),
    ],
    content: options.content ?? '',
    editorProps: {
      attributes: { class: 'prose-mail', role: 'textbox', 'aria-multiline': 'true', 'aria-label': options.placeholder },
      handleKeyDown: (_view, event) => {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          latest.current.onSubmit?.()
          return true
        }
        return false
      },
    },
    onUpdate: ({ editor }) => latest.current.onChange?.(editor.isEmpty ? '' : editor.getHTML()),
    onFocus: () => latest.current.onFocus?.(),
  })
}

export const editorHtml = (editor: Editor | null) => (!editor || editor.isEmpty ? '' : editor.getHTML())

function LinkButton({ editor }: { editor: Editor }) {
  const [url, setUrl] = useState('')
  const active = useEditorState({ editor, selector: ({ editor: e }) => e.isActive('link') })
  return (
    <Popover
      role="dialog"
      width={280}
      side="top"
      onOpenChange={(open) => open && setUrl((editor.getAttributes('link').href as string) || '')}
      trigger={({ ref, ...props }) => (
        <IconButton ref={ref} {...props} label="Link" size="sm" active={active}>
          <LinkIcon className="size-4" />
        </IconButton>
      )}
    >
      {(close) => (
        <form
          className="flex gap-1.5 p-1"
          onSubmit={(e) => {
            e.preventDefault()
            const href = url.trim()
            if (!href) editor.chain().focus().extendMarkRange('link').unsetLink().run()
            else editor.chain().focus().extendMarkRange('link').setLink({ href: /^(https?:|mailto:|tel:)/i.test(href) ? href : `https://${href}` }).run()
            close()
          }}
        >
          <Input autoFocus aria-label="Link address" placeholder="https://example.com" value={url} onChange={(e) => setUrl(e.target.value)} className="h-8" />
          <Button type="submit" variant="primary">
            {url.trim() ? 'Apply' : 'Remove'}
          </Button>
        </form>
      )}
    </Popover>
  )
}

export function EditorToolbar({ editor, children }: { editor: Editor | null; children?: ReactNode }) {
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) =>
      e ? { bold: e.isActive('bold'), italic: e.isActive('italic'), bullet: e.isActive('bulletList'), ordered: e.isActive('orderedList'), quote: e.isActive('blockquote') } : null,
  })
  if (!editor || !state) return null
  const tools: { label: string; icon: ReactNode; active: boolean; run: () => void }[] = [
    { label: 'Bold', icon: <Bold className="size-4" />, active: state.bold, run: () => editor.chain().focus().toggleBold().run() },
    { label: 'Italic', icon: <Italic className="size-4" />, active: state.italic, run: () => editor.chain().focus().toggleItalic().run() },
    { label: 'Bulleted list', icon: <List className="size-4" />, active: state.bullet, run: () => editor.chain().focus().toggleBulletList().run() },
    { label: 'Numbered list', icon: <ListOrdered className="size-4" />, active: state.ordered, run: () => editor.chain().focus().toggleOrderedList().run() },
    { label: 'Quote', icon: <TextQuote className="size-4" />, active: state.quote, run: () => editor.chain().focus().toggleBlockquote().run() },
  ]
  return (
    <div className="flex items-center gap-0.5" role="toolbar" aria-label="Formatting">
      {tools.slice(0, 2).map((t) => (
        <IconButton key={t.label} label={t.label} size="sm" active={t.active} aria-pressed={t.active} onClick={t.run}>
          {t.icon}
        </IconButton>
      ))}
      <LinkButton editor={editor} />
      {tools.slice(2).map((t) => (
        <IconButton key={t.label} label={t.label} size="sm" active={t.active} aria-pressed={t.active} onClick={t.run}>
          {t.icon}
        </IconButton>
      ))}
      {children}
    </div>
  )
}

export function EditorArea({ editor, className }: { editor: Editor | null; className?: string }) {
  return <EditorContent editor={editor} className={cx('cursor-text overflow-y-auto', className)} onClick={() => editor && !editor.isFocused && editor.commands.focus()} />
}

// ---------------------------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------------------------

interface Upload {
  key: string
  name: string
  size: number
  attachment?: Attachment
}

export function useUploads() {
  const [uploads, setUploads] = useState<Upload[]>([])
  const { toast } = useFeedback()
  const add = (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      const key = `${file.name}-${file.size}-${Math.random().toString(36).slice(2)}`
      setUploads((list) => [...list, { key, name: file.name, size: file.size }])
      api
        .upload<{ attachment: Attachment }>('/attachments', file)
        .then(({ attachment }) => setUploads((list) => list.map((u) => (u.key === key ? { ...u, attachment } : u))))
        .catch((err: Error) => {
          setUploads((list) => list.filter((u) => u.key !== key))
          toast(`${file.name}: ${err.message}`, { kind: 'error' })
        })
    }
  }
  return {
    uploads,
    add,
    remove: (key: string) => setUploads((list) => list.filter((u) => u.key !== key)),
    clear: () => setUploads([]),
    busy: uploads.some((u) => !u.attachment),
    ids: uploads.flatMap((u) => (u.attachment ? [u.attachment.id] : [])),
  }
}

export function AttachButton({ onFiles }: { onFiles: (files: FileList) => void }) {
  const input = useRef<HTMLInputElement>(null)
  return (
    <>
      <IconButton label="Attach files" size="sm" onClick={() => input.current?.click()}>
        <Paperclip className="size-4" />
      </IconButton>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files?.length) onFiles(e.target.files)
          e.target.value = ''
        }}
      />
    </>
  )
}

export function UploadList({ uploads, onRemove }: { uploads: Upload[]; onRemove: (key: string) => void }) {
  if (uploads.length === 0) return null
  return (
    <ul className="flex flex-wrap gap-1.5">
      {uploads.map((u) => (
        <li key={u.key} className="flex h-7 max-w-64 items-center gap-1.5 rounded-lg border border-line bg-surface pr-1 pl-2 text-xs">
          {u.attachment ? <FileText className="size-3.5 shrink-0 text-fg-3" aria-hidden /> : <Spinner className="size-3.5" />}
          <span className="truncate font-medium">{u.name}</span>
          <span className="shrink-0 text-fg-3">{fileSize(u.size)}</span>
          <button type="button" aria-label={`Remove ${u.name}`} onClick={() => onRemove(u.key)} className="rounded p-0.5 text-fg-3 hover:bg-hover hover:text-fg">
            <X className="size-3" />
          </button>
        </li>
      ))}
    </ul>
  )
}

/** Accept files dropped or pasted onto the wrapped area. */
export function useFileDrop(onFiles: (files: File[]) => void) {
  const [over, setOver] = useState(false)
  const depth = useRef(0)
  useEffect(() => () => void (depth.current = 0), [])
  return {
    over,
    handlers: {
      onDragEnter: (e: React.DragEvent) => {
        if (!e.dataTransfer.types.includes('Files')) return
        depth.current++
        setOver(true)
      },
      onDragLeave: () => {
        depth.current = Math.max(0, depth.current - 1)
        if (depth.current === 0) setOver(false)
      },
      onDragOver: (e: React.DragEvent) => {
        if (e.dataTransfer.types.includes('Files')) e.preventDefault()
      },
      onDrop: (e: React.DragEvent) => {
        depth.current = 0
        setOver(false)
        if (e.dataTransfer.files.length) {
          e.preventDefault()
          onFiles(Array.from(e.dataTransfer.files))
        }
      },
      onPaste: (e: React.ClipboardEvent) => {
        const files = Array.from(e.clipboardData.files)
        if (files.length) {
          e.preventDefault()
          onFiles(files)
        }
      },
    },
  }
}

/** A small bordered rich-text field for settings forms (signatures, saved replies). */
export function RichField({ value, onChange, placeholder, minHeight = 96, id }: { value: string; onChange: (html: string) => void; placeholder: string; minHeight?: number; id?: string }) {
  const editor = useRichEditor({ content: value, placeholder, onChange })
  return (
    <div id={id} className="rounded-lg border border-line-strong bg-surface focus-within:border-accent focus-within:ring-3 focus-within:ring-accent/20">
      <div style={{ minHeight }} className="flex">
        <EditorArea editor={editor} className="max-h-72 flex-1 px-3 py-2.5" />
      </div>
      <div className="border-t border-line px-2 py-1.5">
        <EditorToolbar editor={editor} />
      </div>
    </div>
  )
}
