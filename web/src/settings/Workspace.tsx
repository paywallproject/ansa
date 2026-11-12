import { useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ImageUp, Trash2 } from 'lucide-react'
import { api } from '../lib/api'
import { useSession } from '../lib/hooks'
import type { Workspace } from '../lib/workspace'
import { Banner, Button, Card, Field, Input, PageHeader, Switch, useFeedback } from '../ui'
import { Logo } from '../pages/Auth'

export function WorkspaceSettings() {
  const { workspace, refresh } = useSession()
  const client = useQueryClient()
  const { toast } = useFeedback()
  const [name, setName] = useState(workspace.brandName)
  const file = useRef<HTMLInputElement>(null)
  const done = (message: string) => {
    toast(message)
    refresh()
    void client.invalidateQueries({ queryKey: ['mailboxes'] })
    void client.invalidateQueries({ queryKey: ['conversations'] })
    void client.invalidateQueries({ queryKey: ['conversation'] })
  }
  const onError = (err: Error) => toast(err.message, { kind: 'error' })

  const save = useMutation({ mutationFn: (patch: Partial<Workspace>) => api.patch('/workspace', patch), onSuccess: () => done('Saved'), onError })
  const upload = useMutation({ mutationFn: (image: File) => api.upload('/workspace/logo', image), onSuccess: () => done('Logo updated'), onError })
  const removeLogo = useMutation({ mutationFn: () => api.del('/workspace/logo'), onSuccess: () => done('Logo removed'), onError })
  const shownName = name.trim() || 'Ansa'

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Workspace" description="Your own name and logo, and optional features. These apply to everyone on the team." />

      <Card className="p-5">
        <h2 className="text-[15px] font-semibold">Branding</h2>
        <p className="mt-0.5 text-[13px] text-fg-3">Shown in the top bar, on the sign-in page, in the browser tab and in notification emails.</p>
        <form
          className="mt-4 flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            save.mutate({ brandName: name.trim() })
          }}
        >
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Name" hint="Leave it empty to use the default name." className="min-w-56 flex-1">
              {(id) => <Input id={id} value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder="Acme Support" />}
            </Field>
            <Button type="submit" variant="primary" loading={save.isPending && save.variables?.brandName !== undefined} disabled={name.trim() === workspace.brandName} className="mb-6">
              Save name
            </Button>
          </div>

          <div>
            <p className="mb-1.5 text-[13px] font-medium">Logo</p>
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex h-12 items-center gap-2 rounded-lg bg-nav px-3">
                <Logo size={24} />
                <span className="max-w-40 truncate text-[15px] font-semibold text-white">{shownName}</span>
              </div>
              <input
                ref={file}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                hidden
                onChange={(e) => {
                  const image = e.target.files?.[0]
                  if (image) upload.mutate(image)
                  e.target.value = ''
                }}
              />
              <Button icon={<ImageUp />} loading={upload.isPending} onClick={() => file.current?.click()}>
                {workspace.logoUrl ? 'Replace logo' : 'Upload logo'}
              </Button>
              {workspace.logoUrl && (
                <Button variant="ghost" icon={<Trash2 />} loading={removeLogo.isPending} onClick={() => removeLogo.mutate()}>
                  Remove
                </Button>
              )}
            </div>
            <p className="mt-1.5 text-[13px] text-fg-3">PNG, JPG, WebP or GIF, up to 512 KB. It sits on a dark bar, so a light or transparent logo works best. A square image also becomes the browser tab icon.</p>
          </div>
        </form>
      </Card>

      <Card className="p-5">
        <h2 className="text-[15px] font-semibold">Features</h2>
        <p className="mt-0.5 text-[13px] text-fg-3">Optional ways of working for the whole team.</p>
        <div className="mt-4 flex flex-col gap-5">
          <Switch
            checked={workspace.mentions}
            disabled={save.isPending}
            onChange={(mentions) => save.mutate({ mentions })}
            label="Mentioned folder"
            description="Adds a Mentioned folder under Mine, with the open conversations where a teammate mentioned you. Mentions always work: type @ in a note, and the teammate gets an email."
          />
          <Switch
            checked={workspace.fourStatuses}
            disabled={save.isPending}
            onChange={(fourStatuses) => save.mutate({ fourStatuses })}
            label="Four statuses"
            description="Active, Waiting on me, Waiting on customer, Closed. Without this: Active, Pending, Closed."
          />
          <Switch
            checked={workspace.trackOpens}
            disabled={save.isPending}
            onChange={(trackOpens) => save.mutate({ trackOpens })}
            label="Show when customers view replies"
            description="Each reply carries a tiny invisible image. When the customer's mail app loads it, the reply shows when they viewed it. Some mail apps load images on their own (Apple Mail's privacy protection does), so a view is a good sign, not proof."
          />
          {workspace.fourStatuses ? (
            <Banner>
              A new conversation is <strong>Active</strong>. When the customer answers, it becomes <strong>Waiting on me</strong>. Pick <strong>Waiting on customer</strong> or <strong>Closed</strong> when you reply. Conversations that wait on the customer leave Unassigned, Mine and Assigned, and move to their own folder. Turning this off moves "Waiting on me" conversations back to Active, and "Waiting on customer" shows as Pending.
            </Banner>
          ) : null}
        </div>
      </Card>
    </div>
  )
}
