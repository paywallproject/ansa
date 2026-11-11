# Development

```bash
npm install
npm run seed     # optional demo data: demo@ansa.local / demo1234
npm run dev      # API on :3000, web app with hot reload on :5173
npm test         # unit and integration tests
npm run typecheck
```

`npm run test:mail` runs a full send-and-receive check against a local GreenMail server. The command to start GreenMail is at the top of `server/test/e2e-mail.ts`, with the variables that point the same check at `npm run dev:cf`.

```
server/            Hono API, SQLite, mail, MCP. Runs on Node.js and on Workers
  app.ts           The HTTP app both platforms share
  platform-node.ts Node.js: SQLite file, attachments on disk
  mail/            SMTP sending, IMAP sync, parsing and cleaning email
  services/        Conversations, customers, workflows, reports
  mcp.ts           MCP tools
worker/            Cloudflare: the Worker and its Durable Object
web/               React + Vite + Tailwind single-page app
```
