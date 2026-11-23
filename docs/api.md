# MCP server and REST API

Ansa speaks the Model Context Protocol for AI assistants, and a JSON API for your own scripts. Both use the same token.

## Connect an AI assistant (MCP)

Ansa serves the Model Context Protocol at `https://your-domain/mcp` (Streamable HTTP).

1. Open **Settings → API & MCP** and create a token. The page shows ready-to-paste setup for Claude Code, Claude Desktop and Cursor.
2. For Claude Code:

   ```bash
   claude mcp add --transport http ansa https://your-domain/mcp \
     --header "Authorization: Bearer ansa_your_token"
   ```

The assistant acts as the teammate who created the token. Revoke the token to cut it off.

| Tool | What it does |
|---|---|
| `list_mailboxes` | Mailboxes and how many conversations need attention |
| `list_conversations` | List, filter or full-text search conversations |
| `get_conversation` | Read a thread: messages, replies, notes, customer |
| `reply_to_conversation` | Email a reply to the customer  now, or at a set time (`send_at`), optionally only if the customer hasn't written by then (`only_if_no_reply`) |
| `list_scheduled_replies`, `cancel_scheduled_reply`, `send_scheduled_reply_now` | See, take back or send early the replies waiting to go out |
| `get_attachment` | Download a file from a message: images and text come back inline, other files as base64, files over 10 MB as a download link for the same token |
| `upload_attachment` | Upload a file to send (base64, or text for a text file). Returns an id to attach, and for an image a tag to put it in the body |
| `add_note` | Add an internal note |
| `draft_reply` | Write a reply (or note) into your draft for you to review and send from Ansa. Sends nothing |
| `update_conversation` | Change status, assignee, tags, subject, snooze |
| `create_conversation` | Email a customer, or log a message or call |
| `list_customers`, `get_customer`, `update_customer` | Find and edit customer profiles |
| `list_saved_replies`, `list_tags`, `list_team` | Reference data |
| `get_report` | Support metrics for the last N days |

`reply_to_conversation` (without `send_at`), `send_scheduled_reply_now` and `create_conversation` (kind `email`) send real email. The server tells assistants to confirm with you first.

### Files and images

`reply_to_conversation`, `draft_reply`, `add_note` and `create_conversation` take `attachment_ids`: files from `upload_attachment`, or files already on a message in a conversation the assistant can see (those are copied, so a customer's screenshot can go into a note). To show an image inside the message, write `<img src="attachment:ID" alt="…">` in the body, on a line of its own in plain text or anywhere in HTML. In the email it goes out as part of the message, so it shows without loading anything from Ansa.

An assistant with a shell can upload large or local files over HTTP instead, with the same token:

```bash
curl https://your-domain/api/attachments -H "Authorization: Bearer ansa_your_token" -F file=@screenshot.png
# {"attachment":{"id":42,...}}  → attachment_ids: [42], or <img src="attachment:42">
```

A draft keeps its files: `draft_reply` without `attachment_ids` leaves the files already on the draft, and `[]` removes them.

## REST API

The web app's JSON API accepts the same token:

```bash
curl https://your-domain/api/conversations?folder=open \
  -H "Authorization: Bearer ansa_your_token"
```

| Method and path | Purpose |
|---|---|
| `GET /api/conversations` | List. Query: `mailbox`, `folder`, `status`, `assignee`, `tag`, `customer`, `q`, `sort`, `limit`, `offset` |
| `POST /api/conversations` | Create. Body: `mailboxId`, `customerEmail`, `subject`, `bodyHtml`, `kind` (`reply`, `customer`, `note`) |
| `GET /api/conversations/:id` | One conversation with its thread |
| `PATCH /api/conversations/:id` | `status`, `assigneeId`, `subject`, `addTags`, `removeTags`, `snoozedUntil`, `mailboxId` |
| `POST /api/conversations/:id/reply` | `bodyHtml`, `status`, `cc`, `bcc`, `attachmentIds`, `assigneeId` (a user id, or `null` for unassigned; left out, the mailbox's "after sending" setting decides) |
| `POST /api/conversations/:id/note` | `bodyHtml`, `attachmentIds` |
| `PATCH /api/threads/:id` | Edit a note you wrote: `bodyHtml`. It keeps its place and files, and shows as edited. Other people's notes and customer messages are refused |
| `POST /api/threads/:id/reactions` | React to a note: `emoji`. Sending the same emoji again takes it back. Answers `{ "on": true }` or `false` |
| `PUT /api/conversations/:id/draft` | Your draft: `kind` (`reply` or `note`), `bodyHtml`, `attachmentIds` (left out, the draft's files stay) |
| `POST /api/conversations/:id/merge` | `intoId` |
| `GET /api/customers`, `GET/PATCH /api/customers/:id` | Customers |
| `GET /api/tags`, `/api/saved-replies`, `/api/users`, `/api/mailboxes` | Reference data |
| `GET /api/reports` | Query: `from`, `to` (ms), `mailbox`, `tz` |
| `POST /api/attachments` | Multipart `file`. Returns an id for `attachmentIds`, and a `url`: an image in `bodyHtml` as `<img src="{url}">` goes out inside the email |
