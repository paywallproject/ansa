# Self-hosting guide

How to run Ansa on your own server or on Cloudflare, connect your email, and keep it backed up.

## Install on a VPS

You need a server with Docker, and a domain name that points to it.

```bash
git clone https://github.com/rizaardiyanto1412/ansa.git ansa && cd ansa
cp .env.example .env
nano .env                      # set DOMAIN and APP_URL
docker compose --profile https up -d --build
```

Open `https://your-domain`. The first visit asks you to create the admin account, then to connect your mailbox. Do this right after the first start: until an admin exists, anyone who finds the address can create it.

Caddy gets and renews the HTTPS certificate for you. Ports 80 and 443 must be open.

**Already have a reverse proxy** (nginx, Traefik, Cloudflare Tunnel)? Skip the profile and point your proxy at port 3000:

```bash
docker compose up -d --build   # serves http://127.0.0.1:3000
```

**Want to look around first?** Load demo data into an empty install, then sign in with `demo@ansa.local` / `demo1234`:

```bash
docker compose exec ansa node dist/seed.js
```

### Update

```bash
git pull && docker compose --profile https up -d --build
```

Database changes apply by themselves on start.

### Back up

Everything lives in the `ansa-data` volume: `ansa.db` (all data), `attachments/` and `secret.key`.

```bash
docker run --rm -v ansa_ansa-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/ansa-backup-$(date +%F).tar.gz -C /data .
```

Keep `secret.key` with the database. It encrypts the saved mail passwords, and they cannot be read without it.

## Deploy to Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/rizaardiyanto1412/ansa)

The button copies this repository to your GitHub account, builds it, and deploys it to your Cloudflare account. Accept the suggested build and deploy commands. When it finishes, open the `workers.dev` address, create the admin account, and connect your mailbox.

The button only works while this repository is public. For a private repository, deploy from your machine:

```bash
npm ci
npx wrangler login
npm run deploy
```

How it runs on Cloudflare:

- **One Worker and one Durable Object.** The Durable Object's built-in SQLite database holds all data, attachments included. You do not create a database, a bucket or a secret.
- **Email works the same way.** Ansa sends over SMTP and reads over IMAP with the settings from **Settings → Mailboxes**. It checks for new mail every 60 seconds (`IMAP_POLL_SECONDS` in `wrangler.jsonc`), because a Worker cannot hold a connection open.
- **Use port 587 or 465 for SMTP.** Cloudflare blocks port 25.
- **Your domain.** Add a custom domain to the Worker in the Cloudflare dashboard. Links in notification emails use the address you sign in on. To pin it, set `APP_URL` under `vars` in `wrangler.jsonc`.
- **Plan.** The free plan is enough to try Ansa. For a team that keeps it open all day, use Workers Paid: an open browser tab keeps the Durable Object awake, and the free plan's daily allowance covers about one tab.
- **Backups.** Cloudflare keeps 30 days of point-in-time recovery for the Durable Object. For a copy outside Cloudflare, see [Back up to DigitalOcean Spaces](#back-up-to-digitalocean-spaces).
- **Updates.** Push to the repository that the button created. Cloudflare rebuilds and deploys it.

Try it locally with `npm run dev:cf` (http://localhost:8787).

## Back up to DigitalOcean Spaces

On Cloudflare, Ansa can keep a copy of everything in a DigitalOcean Space (any S3-compatible storage works). It is off until you add the settings below.

What it keeps, in a folder named `ansa` inside the Space:

- **`db/`**: a snapshot of the database every night, after 07:00 UTC (set `BACKUP_HOUR_UTC` to change the hour). It keeps every snapshot from the last 30 days, then the first of each month for a year.
- **`attachments/`**: every attachment, original email, avatar and logo, uploaded within 15 minutes of arriving. Files are uploaded once and never deleted from the Space.

Sign-in sessions are not kept, so after a restore everyone signs in again. A snapshot does hold the key that unlocks the saved mail passwords, so keep the Space private.

### Turn it on

1. In DigitalOcean, create a Space (for example `acme-ansa-backups` in `nyc3`), with file listing restricted.
2. Under **Spaces Object Storage → Access Keys**, create a key with read and write access to that Space.
3. Add these as secrets on the Worker, in the Cloudflare dashboard (**Workers → ansa → Settings → Variables and Secrets**, type *Secret*) or from a terminal:

   ```bash
   npx wrangler secret put SPACES_KEY      # the access key
   npx wrangler secret put SPACES_SECRET   # its secret
   npx wrangler secret put SPACES_BUCKET   # the Space's name
   npx wrangler secret put SPACES_REGION   # the datacenter, e.g. nyc3
   ```

The first backup runs within 15 minutes and takes a snapshot straight away. Check the Space for `ansa/db/` and `ansa/attachments/`. The Worker's logs show a `[backup]` line every run.

### Restore

A restore replaces all the data in the install it runs on. Pick one:

- **The same install**, to go back in time. If the install has any data, it first saves that data as a `-before-restore` snapshot, so you can undo the restore.
- **A new install**, if the old one is gone. Deploy Ansa to any Cloudflare account (the Deploy button or `npm run deploy`), but do not create an account on it.

Then:

1. Make sure the install has the four `SPACES_` secrets.
2. Add one more secret, `RESTORE_FROM`, set to `latest`, or to the start of a snapshot's name to pick one, such as `20261114` (the last one from that day) or `20261114T071502Z`.
3. Open the site. It shows "Restoring from a backup" and reloads by itself when the data is back, usually within a minute. Attachments then come back over the next few minutes while you work. Everyone signs in with their usual email and password.

Each `RESTORE_FROM` value runs once, so you can leave it in place. To restore again later, set a different value. If the restore cannot run (a wrong name, for example), the page says why, and it tries again every few minutes until you fix or remove the setting.

If the old install is still running, turn it off or remove its mailboxes. Otherwise both installs fetch the same mail.

### A new address

On a new install, or to change the address:

1. In the Cloudflare dashboard, open **Workers → ansa → Settings → Domains & Routes → Add → Custom domain** and enter the address, e.g. `help.example.com`. The domain must be on Cloudflare. Cloudflare creates the DNS record and certificate.
2. Sign in on the new address. Ansa uses the address you sign in on for links in emails. To pin it, set `APP_URL` under `vars` in `wrangler.jsonc`.
3. If you use the live chat, copy the new chat code from the mailbox's settings (**Settings → Mailboxes**) into your website. Point anything that calls the API or the MCP server at the new address.

## Connect Google Workspace or Gmail

Google does not accept your normal password for SMTP and IMAP. Use an app password.

1. Turn on **2-Step Verification** for the Google account that owns the support address.
2. Create an app password at <https://myaccount.google.com/apppasswords>.
3. In Ansa, open **Settings → Mailboxes → Add mailbox** and choose **Google Workspace or Gmail**. This fills in the servers:

   | | Host | Port | Security |
   |---|---|---|---|
   | SMTP | `smtp.gmail.com` | 587 | STARTTLS |
   | IMAP | `imap.gmail.com` | 993 | SSL/TLS |

4. Username: the full email address. Password: the 16-character app password.
5. Press **Test connection** in both sections, then save.

If your Workspace admin disabled app passwords, ask them to allow them for this account. If the address is an alias or a group, sign in as the real mailbox that receives its mail, and add the alias under Gmail's **Send mail as** setting so Google lets you send from it.

Ansa only reads mail. It does not delete or move anything in your Google inbox. By default it imports mail that arrives after you connect; tick **Import the last 30 days** to bring in recent history.

## Import from Help Scout

Open **Settings → Import**. Help Scout gives out conversations only through its API, so you create a private app there first.

1. In Help Scout, open **Your Profile → My Apps** and press **Create My App**. Use any name, and `https://example.com` as the redirection URL.
2. Paste the **App ID** and **App Secret** into Ansa and press **Connect**.
3. Choose where each Help Scout inbox goes, then start the import.

It runs in the background and can be stopped and resumed. Running it again adds only what is new. Nothing in Help Scout is changed.

- **Imported:** conversations with their dates and status, customer messages, replies, notes, customers, tags, attachments.
- **Not imported:** spam, drafts, activity lines, saved replies, workflows, custom fields, ratings.
- **Speed:** about 20,000 conversations an hour. Help Scout allows 200 requests a minute.
- **On Cloudflare:** a large import needs the Workers Paid plan. The free plan limits database writes per day; the import pauses when it hits the limit and you resume it the next day.

## Settings

Set these in `.env` (Docker) or the environment.

| Variable | Default | Meaning |
|---|---|---|
| `APP_URL` | `http://localhost:3000` | Public address. Used in links and to mark cookies secure |
| `DOMAIN` | | Domain for Caddy's certificate (Docker `https` profile) |
| `PORT` | `3000` | Port the app listens on |
| `DATA_DIR` | `./data` (`/data` in Docker) | Database, attachments and the secret key |
| `APP_SECRET` | generated into `DATA_DIR/secret.key` | Key that encrypts saved mail passwords |
| `IMAP_POLL_SECONDS` | `60` | Fallback check interval. New mail usually arrives instantly through IMAP IDLE |
| `MAX_ATTACHMENT_MB` | `25` | Upload limit per file |

Mailboxes, teammates and everything else are set up in the app.

## Run without Docker

Needs Node.js 22.13 or newer.

```bash
npm ci
npm run build
APP_URL=https://your-domain NODE_ENV=production npm start
```

Put it behind any HTTPS reverse proxy. A minimal systemd unit:

```ini
[Service]
WorkingDirectory=/opt/ansa
Environment=NODE_ENV=production APP_URL=https://your-domain DATA_DIR=/var/lib/ansa
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning dist/index.js
Restart=always
User=ansa

[Install]
WantedBy=multi-user.target
```

## Keyboard shortcuts

| Key | Action |
|---|---|
| `⌘K` or `/` | Search and commands |
| `C` | New conversation |
| `J` / `K` | Next / previous conversation |
| `R` / `N` | Reply / add a note |
| `A` | Assign to me |
| `E` | Close the conversation |
| `⌘Enter` | Send |
| `?` | Show all shortcuts |
