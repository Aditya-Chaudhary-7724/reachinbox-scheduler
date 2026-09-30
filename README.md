# ReachInbox Scheduler

A full-stack email scheduler: sign in with Google, upload a CSV of leads, and schedule a campaign. Emails are sent one by one through Ethereal SMTP at the times you choose. They respect per-sender hourly limits, survive restarts without being lost or sent twice, can be searched with Elasticsearch, and a Slack alert fires when a sender hits its limit.

No cron is used anywhere. Every email is a **BullMQ delayed job** in Redis, and PostgreSQL is the source of truth.

---

## Contents

1. [Features](#features)
2. [Tech stack](#tech-stack)
3. [Architecture](#architecture)
4. [Local setup](#local-setup)
5. [Environment variables](#environment-variables)
6. [Google OAuth setup](#google-oauth-setup)
7. [Slack OAuth + ngrok setup](#slack-oauth--ngrok-setup)
8. [Ethereal (test SMTP)](#ethereal-test-smtp)
9. [Bull Board (queue monitor)](#bull-board-queue-monitor)
10. [API overview](#api-overview)
11. [How scheduling, rate limiting and recovery work](#how-scheduling-rate-limiting-and-recovery-work)
12. [Scaling / 1000+ email execution](#scaling--1000-email-execution)
13. [Running tests and checks](#running-tests-and-checks)
14. [Load test](#load-test)
15. [Demo script](#demo-script)
16. [Assumptions, trade-offs and known limitations](#assumptions-trade-offs-and-known-limitations)

---

## Features

**Backend**

- **Scheduling:** `POST /api/campaigns` validates the input, cleans up and de-duplicates the leads, and creates the Campaign and Email rows in one transaction. It then enqueues one BullMQ delayed job per email with `jobId = emailId`. Lead *i* is scheduled at `startTime + i × delayBetweenMs`. Senders are assigned round-robin, unless the request names one sender (`senderId`), in which case that sender sends every email in the campaign.
- **Persistence:**
  - Redis runs with AOF (`appendfsync everysec`) on a named volume, so delayed jobs survive a Redis restart.
  - A **reconciliation pass** runs once at boot. It recreates the job for any pending email whose job is missing, for example after Redis was wiped.
- **Idempotency:** an atomic claim in Postgres (`UPDATE … WHERE status IN (…) RETURNING`) is the only gate to sending. Duplicate jobs, re-enqueued jobs and parallel workers can never send the same email twice. The one known exception is a crash mid-send, covered in [trade-offs](#assumptions-trade-offs-and-known-limitations).
- **Rate limiting:**
  - An atomic Redis **Lua** counter per sender per UTC hour, plus an optional global counter.
  - Emails over the limit are **rescheduled into ordered slots in the next window**, never dropped.
  - A minimum gap between sends is enforced by the BullMQ worker limiter, which is shared through Redis.
- **Concurrency:** worker concurrency is configurable, and multiple worker processes can share the same Redis and Postgres.
- **Search:** Elasticsearch indexes every email and every status change. `GET /api/emails/search` searches recipient, subject and body, always within the signed-in user's emails.
- **Slack:** per-user OAuth v2 with the `incoming-webhook` scope. The webhook URL is stored AES-256-GCM encrypted. One alert is sent per sender per hour window when its limit is reached.
- **Bull Board** at `/admin/queues`, behind HTTP basic auth.

**Frontend (Next.js)**

- Google login page. Every other route redirects to `/login` when you're signed out.
- The header shows your Google avatar, name and email, plus Logout.
- Dashboard with **Scheduled** and **Sent** tabs showing counts, a search bar backed by Elasticsearch, and pagination. It auto-refreshes every 5 s.
- **Compose** modal:
  - subject and body;
  - CSV/TXT upload (emails are found in any column and de-duplicated; you see "N emails detected" and a preview);
  - start time, delay between emails, and hourly limit;
  - a **Sender** dropdown: "All senders (round-robin)" by default, or one specific sender for the whole campaign;
  - validation in the browser before anything is sent.
- **Scheduled table** columns: email, subject, scheduled time in your local timezone, and status (Scheduled, Sending or Rate limited).
- **Sent table** columns: email, subject, sent time, status (Sent or Failed), and an Ethereal preview link.
- Loading skeletons, empty states, toast messages, a Slack connection card, and a link to Bull Board.

## Tech stack

| Layer    | Technology |
| -------- | ---------- |
| Frontend | Next.js 15 (App Router), React 19, TypeScript, Tailwind CSS 3, SWR, papaparse |
| API      | Node.js ≥ 20, Express 4, TypeScript (strict), zod, pino |
| Data     | PostgreSQL 16 + Prisma 6 |
| Queue    | BullMQ 5 + Redis 7 (ioredis), Lua scripts |
| Search   | Elasticsearch 8 (`@elastic/elasticsearch` v8) |
| Email    | nodemailer + Ethereal SMTP |
| Auth     | Google OAuth 2.0 (`google-auth-library`), JWT in an httpOnly cookie |
| Alerts   | Slack OAuth v2 + incoming webhooks |
| Tests    | Vitest (backend integration tests use real Postgres, Redis and Elasticsearch) |
| Infra    | Docker Compose (Postgres, Redis with AOF, Elasticsearch single-node) |

## Architecture

```mermaid
flowchart TB
    user(["User's browser"])

    subgraph FE["Frontend · Next.js · :5173"]
        ui["Login · Dashboard · Compose"]
    end

    subgraph BE["Backend · Node.js"]
        api["Express API · :4000<br/>auth · campaigns · emails · search · slack"]
        board["Bull Board<br/>/admin/queues (basic auth)"]
        worker["Worker process<br/>BullMQ Worker · concurrency N<br/>limiter: 1 job / MIN_SEND_INTERVAL_MS"]
    end

    subgraph DC["Docker Compose"]
        pg[("PostgreSQL :5433<br/>source of truth")]
        redis[("Redis :6379 · AOF<br/>delayed jobs · rate-limit counters")]
        es[("Elasticsearch :9200<br/>emails index")]
    end

    google["Google OAuth"]
    slack["Slack OAuth + incoming webhook"]
    smtp["Ethereal SMTP"]
    ngrok["ngrok HTTPS tunnel"]

    user --> ui
    ui -- "fetch, credentials: include" --> api
    user -- "login redirect" --> google
    google -- "/auth/google/callback" --> api
    api -- "1 · transaction: Campaign + Emails" --> pg
    api -- "2 · addBulk delayed jobs (jobId = emailId)" --> redis
    api -- "index / search" --> es
    api --- board
    board --> redis
    redis -- "job due" --> worker
    worker -- "atomic claim · status updates" --> pg
    worker -- "Lua quota · deferral slots" --> redis
    worker -- "status changes" --> es
    worker -- "send" --> smtp
    worker -- "hourly-limit alert" --> slack
    slack -- "OAuth callback" --> ngrok --> api
```

**Request flow for a campaign**

1. The dashboard sends `POST /api/campaigns` with the session cookie. The API validates the body and cleans up the leads.
2. **In one Postgres transaction:** it creates the Campaign and all Email rows (`status = SCHEDULED`, `scheduledAt = startTime + i × delay`, sender chosen round-robin or the one selected sender).
3. **After the commit:** it calls `queue.addBulk` in chunks of 500. Each job is `{ jobId: emailId, delay: max(0, scheduledAt − now), data: { emailId } }`, and Elasticsearch is bulk-indexed.
4. **When a job is due, the worker:**
   1. claims the row atomically;
   2. checks the hourly quota with a Lua script;
   3. sends through the sender's SMTP account;
   4. writes `SENT`, `sentAt`, `messageId` and `previewUrl`;
   5. re-indexes the email.
5. The dashboard picks up the change on its next 5-second refresh.

## Local setup

**Prerequisites:**
- Node.js **20+** is expected (development and testing were done on Node 24; Node 20 was not tested explicitly);
- npm;
- Docker with Compose v2;
- internet access (Google, Ethereal and Slack).

Free ports: **5173** (frontend), **4000** (API), **5433** (Postgres, mapped to 5433 so it can't clash with a local 5432), **6379** (Redis), **9200** (Elasticsearch).

```bash
# 1. Clone
git clone <your-private-repo-url> reachinbox-scheduler
cd reachinbox-scheduler

# 2. Infrastructure (Postgres, Redis with AOF, Elasticsearch), waits until healthy
docker compose up -d --wait

# 3. Backend
cd backend
npm install
cp .env.example .env            # then edit .env; see "Environment variables" below
npm run prisma:generate         # generate the Prisma client
npm run prisma:deploy           # apply migrations
npm run seed                    # create 3 Ethereal sender accounts (needs internet)

# 4. Run the API and the worker (two processes; pick one option)
npm run dev:all                 # API + worker together (tsx watch)
#   or, in two terminals:
# npm run dev                   # API on http://localhost:4000
# npm run dev:worker            # BullMQ worker

# 5. Frontend (new terminal)
cd ../frontend
npm install
cp .env.example .env.local      # NEXT_PUBLIC_API_URL=http://localhost:4000
npm run dev                     # http://localhost:5173
```

Open **http://localhost:5173** and sign in with Google.

> Use `localhost` (not `127.0.0.1`) for both the dashboard and the API. The CORS origin and the session cookie are both tied to `http://localhost:5173` / `localhost`.

**Minimum `.env` edits before the first run**

- `JWT_SECRET`: a long random string.
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`: see [Google OAuth setup](#google-oauth-setup).
- `BULL_BOARD_PASS`: any password.
- `SLACK_TOKEN_ENC_KEY`: optional until you connect Slack.

Generate random values with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**Production-style run** (compiled JavaScript):

macOS / Linux:

```bash
cd backend
npm run build
NODE_ENV=production npm start             # API    (dist/src/server.js)
NODE_ENV=production npm run start:worker  # worker (dist/src/worker.js), in a second terminal

cd ../frontend
npm run build
npm start                                 # next start -p 5173
```

Windows PowerShell (each `$env:` variable stays set for the rest of that terminal session):

```powershell
cd backend
npm run build
$env:NODE_ENV="production"; npm start              # API
$env:NODE_ENV="production"; npm run start:worker   # worker, in a second terminal

cd ..\frontend
npm run build
npm start
```

**Useful extra commands (backend)**

| Command | What it does |
| ------- | ------------ |
| `npm run reindex` | Rebuilds the Elasticsearch index from Postgres |
| `npm run dev:token -- you@example.com "Your Name"` | Development only: creates or updates a user and prints a session JWT for curl or `requests.http` (refuses to run in production) |
| `npm run load-test -- --count 1200 --hourly-limit 50 --watch` | See [Load test](#load-test) |
| `npm run load-test -- --cleanup` | Removes the load-test data and its Redis rate-limit state |

## Environment variables

### Backend (`backend/.env`, validated with zod at startup)

If a variable is invalid, the process exits with a list of the problems.

**Required**

| Variable | Example / placeholder | Notes |
| -------- | --------------------- | ----- |
| `DATABASE_URL` | `postgresql://reachinbox:reachinbox@localhost:5433/reachinbox?schema=public` | Matches `docker-compose.yml` |
| `JWT_SECRET` | `<random 32+ byte hex>` | Signs session and OAuth-state JWTs; at least 16 characters |
| `BULL_BOARD_PASS` | `<choose a password>` | Basic-auth password for `/admin/queues` |
| `GOOGLE_CLIENT_ID` | `<google-client-id>.apps.googleusercontent.com` | Needed for login. The API starts without it, but `/auth/google` returns 503 |
| `GOOGLE_CLIENT_SECRET` | `<google-client-secret>` | Needed for login |

**Optional (defaults shown)**

| Variable | Default | Notes |
| -------- | ------- | ----- |
| `PORT` | `4000` | API port |
| `FRONTEND_URL` | `http://localhost:5173` | CORS origin and redirect target after login and Slack connect |
| `LOG_LEVEL` | `info` | `fatal` · `error` · `warn` · `info` · `debug` · `trace` |
| `REDIS_URL` | `redis://localhost:6379` | |
| `ELASTICSEARCH_URL` | `http://localhost:9200` | For Elastic Cloud, the deployment's Elasticsearch endpoint, e.g. `https://<deployment>.es.<region>.<provider>.elastic-cloud.com:443` |
| `ELASTICSEARCH_API_KEY` | empty | Encoded API key for a secured cluster (e.g. Elastic Cloud); sent as `Authorization: ApiKey <key>`. Leave empty for the local Docker Elasticsearch, which has security disabled |
| `ELASTICSEARCH_INDEX` | `emails` | |
| `GOOGLE_CALLBACK_URL` | `http://localhost:4000/auth/google/callback` | Must match the redirect URI registered in Google Cloud |
| `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` | empty | Slack is disabled (503) until all four Slack variables are set |
| `SLACK_REDIRECT_URI` | empty | `https://<your-ngrok-host>/api/slack/callback` |
| `SLACK_TOKEN_ENC_KEY` | empty | 64 hex characters (32 bytes); encrypts stored webhook URLs |
| `WORKER_CONCURRENCY` | `5` | Jobs processed in parallel per worker process |
| `MIN_SEND_INTERVAL_MS` | `2000` | Minimum gap between job starts, **across all workers**. Every worker must use the same value |
| `MAX_EMAILS_PER_HOUR_PER_SENDER` | `200` | Per-sender cap; the effective limit is `min(this, campaign.hourlyLimit)` |
| `MAX_EMAILS_PER_HOUR` | empty (off) | Optional global cap across all senders |
| `STALE_SENDING_MS` | `300000` | A `SENDING` row older than this (worker crashed mid-send) may be reclaimed |
| `JOB_ATTEMPTS` | `3` | BullMQ attempts for SMTP failures |
| `JOB_BACKOFF_MS` | `30000` | Starting delay for exponential backoff |
| `ETHEREAL_USER` / `ETHEREAL_PASS` | empty | Use a fixed Ethereal account as one of the senders (the seed tops up to 3) |
| `BULL_BOARD_USER` | `admin` | Basic-auth user for `/admin/queues` |
| `NODE_ENV` | `development` | `production` turns on `Secure` cookies and disables `dev:token` |

**Development / test only**

| Variable | Default | Notes |
| -------- | ------- | ----- |
| `MOCK_SMTP` | `false` | `true` uses nodemailer's `jsonTransport` (no network). Meant for the load test |
| `SLACK_API_URL` | `https://slack.com/api` | Override only to point the OAuth exchange at a local stub (tests do this) |
| `TEST_DATABASE_URL` / `TEST_REDIS_URL` | `…/reachinbox_test`, `redis://localhost:6379/15` | Read by `vitest.config.mts`; tests never touch dev data |

**Elasticsearch in production (e.g. Elastic Cloud).** Set `ELASTICSEARCH_URL` to the deployment endpoint and `ELASTICSEARCH_API_KEY` to an **encoded** API key. The client then authenticates with that key; with no key it connects without auth, as it does locally. The key needs these privileges:
- **Cluster `monitor`:** `GET /health` pings the cluster, and without this privilege the health check reports Elasticsearch as down.
- **On the `ELASTICSEARCH_INDEX` index:** `create_index`, `view_index_metadata`, `read` and `write`, for creating the index at startup, indexing, searching and cleanup.
- **`delete_index`** as well, if you run `npm run reindex`, which drops and rebuilds the index.

Keep the key only in the hosting platform's environment variables, never in a committed file.

### Frontend (`frontend/.env.local`)

| Variable | Default | Notes |
| -------- | ------- | ----- |
| `NEXT_PUBLIC_API_URL` | `http://localhost:4000` | Backend base URL as the browser sees it |

Never commit `.env` or `.env.local`; both are git-ignored. Only the `.env.example` files are tracked.

## Google OAuth setup

The login is a server-side authorization-code flow:

```
dashboard "Continue with Google" → GET http://localhost:4000/auth/google
  → Google consent → GET http://localhost:4000/auth/google/callback?code&state
  → user created or updated, session JWT set as an httpOnly cookie (SameSite=Lax locally; SameSite=None; Secure in production)
  → redirect to http://localhost:5173/dashboard
```

1. In **Google Cloud Console**, create or select a project.
2. Go to **APIs & Services → OAuth consent screen**:
   - choose **External**;
   - fill in the app name and support email;
   - add scopes `openid`, `email` and `profile`;
   - while the app is in *Testing*, add your Google account under **Test users**.
3. Go to **APIs & Services → Credentials → Create credentials → OAuth client ID**, choose **Web application**, and set:
   - **Authorized JavaScript origins:** `http://localhost:5173` (the dashboard origin; the flow is server-side, so this is informational);
   - **Authorized redirect URIs:** `http://localhost:4000/auth/google/callback`.
4. Copy the client ID and secret into `backend/.env`:
   ```dotenv
   GOOGLE_CLIENT_ID=<your-client-id>.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=<your-client-secret>
   GOOGLE_CALLBACK_URL=http://localhost:4000/auth/google/callback
   FRONTEND_URL=http://localhost:5173
   ```
5. Restart the API. The environment is read only at startup.

**Security details**
- CSRF protection uses a random `state` stored in a 10-minute httpOnly cookie.
- The ID token is verified against your client ID, and an unverified Google email is rejected.
- Sessions last 7 days. `POST /auth/logout` clears the cookie.

## Slack OAuth + ngrok setup

Slack only accepts **HTTPS** redirect URLs, so the OAuth callback reaches your local API through an ngrok tunnel. The dashboard itself stays on `http://localhost:5173`.

1. **Install ngrok** and add your auth token (free account):
   ```bash
   brew install ngrok            # or download from https://ngrok.com/download
   ngrok config add-authtoken <your-ngrok-authtoken>
   ```
2. **Start the backend** (`npm run dev:all` in `backend/`), then in another terminal:
   ```bash
   ngrok http 4000
   ```
   Copy the `Forwarding` HTTPS URL, e.g. `https://<random-subdomain>.ngrok-free.app`.
3. **Create the Slack app** at <https://api.slack.com/apps> → *Create New App* → *From scratch*, and pick your workspace.
4. Under **OAuth & Permissions**:
   - **Redirect URLs:** add `https://<random-subdomain>.ngrok-free.app/api/slack/callback`;
   - **Scopes → Bot Token Scopes:** add **`incoming-webhook`**. That's the only scope needed.
5. Under **Basic Information → App Credentials**, copy the Client ID and Client Secret into `backend/.env`:
   ```dotenv
   SLACK_CLIENT_ID=<slack-client-id>
   SLACK_CLIENT_SECRET=<slack-client-secret>
   SLACK_REDIRECT_URI=https://<random-subdomain>.ngrok-free.app/api/slack/callback
   SLACK_TOKEN_ENC_KEY=<64 hex chars; generate with the node one-liner above>
   ```
6. **Restart the API** so it picks up the new variables.
7. **Connect Slack from the dashboard:**
   1. On the **Slack alerts** card, click **Connect Slack**, choose a channel in Slack and click **Allow**.
   2. Slack redirects to the ngrok URL. On the free plan, ngrok may first show a "You are about to visit…" page; click *Visit Site*.
   3. The API stores the encrypted webhook and sends you back to `http://localhost:5173/dashboard?slack=connected`.
   4. The callback identifies you with a **signed, 10-minute `state` token**, not the cookie, because the cookie doesn't exist on the ngrok domain.
8. **Test it:** click **Send test** on the card (`POST /api/slack/test`). A test message should appear in the chosen channel.
9. **Trigger a real alert** with a campaign that exceeds the hourly limit; see [Demo script](#demo-script).

**Restarting a free ngrok tunnel gives a new URL.** Each time that happens:
1. update the Redirect URL in the Slack app;
2. update `SLACK_REDIRECT_URI` in `backend/.env`;
3. restart the API.

Existing connections keep working, because notifications go to the stored Slack webhook, not through ngrok. Only *new* connections need the updated URL.

If Slack isn't configured or connected, alerts are skipped silently and the worker keeps going. Slack HTTP errors are logged and never stop sending.

## Ethereal (test SMTP)

[Ethereal](https://ethereal.email) is a fake SMTP service: it accepts mail but **never delivers it**, so it's safe to send to any address.

- **Sender accounts:** `npm run seed` creates **3 sender accounts** via `nodemailer.createTestAccount()` and stores them in the `Sender` table. With `ETHEREAL_USER`/`ETHEREAL_PASS` set, that account is added first and the seed tops up to 3. Re-running the seed keeps existing senders.
- **Viewing a sent email:**
  - **Dashboard:** in the Sent tab, click **Preview** next to an email. It opens the message on ethereal.email, from `nodemailer.getTestMessageUrl()` stored in `Email.previewUrl`.
  - **Worker log:** every `Email sent` line includes the `previewUrl`.
  - **Full mailbox:** log in at ethereal.email with a sender's credentials. Find them with `npx prisma studio` (Sender table) inside `backend/`.
- Every email carries a fixed `Message-ID: <emailId@reachinbox.local>`, so a duplicate would be easy to spot.

## Bull Board (queue monitor)

- **URL:** **http://localhost:4000/admin/queues**, served by the API process.
- **Auth:** HTTP basic auth using `BULL_BOARD_USER` (default `admin`) and `BULL_BOARD_PASS` from `backend/.env`. The browser prompts for them.
- **What it shows:** the `email-send` queue, with delayed jobs (future and rate-limited sends), active, completed and failed jobs. Each job's id is the email id.
- **Link:** the dashboard sidebar has a **Queue monitor (Bull Board)** link.

## API overview

All `/api/*` routes need the session, sent as the `session` cookie or `Authorization: Bearer <jwt>`. The one exception is the Slack OAuth callback. Errors come back as `{ "error": { "code", "message", "details?" } }`. Ready-made requests are in [`requests.http`](requests.http).

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET | `/health` | Postgres, Redis and Elasticsearch status (200 or 503) |
| GET | `/auth/google` | Starts Google OAuth (302 to Google) |
| GET | `/auth/google/callback` | Google redirect target; sets the session cookie, then 302 to the dashboard |
| GET | `/auth/me` | `{ id, name, email, avatarUrl }` |
| POST | `/auth/logout` | Clears the session cookie (204) |
| POST | `/api/campaigns` | Body `{ subject, body, leads: string[], startTime: ISO, delayBetweenMs, hourlyLimit, senderId? }`. `senderId` is optional (an id from `GET /api/senders`): when set, every email uses that sender and its hourly limit; an unknown id returns 400. Returns 201 with `scheduled`, `invalid[]`, `duplicatesRemoved`, and the first and last scheduled times |
| GET | `/api/emails?status=scheduled\|sent&page&limit` | Paginated list: `scheduled` = SCHEDULED/SENDING/RATE_LIMITED, `sent` = SENT/FAILED |
| GET | `/api/emails/search?q=&status=&page&limit` | Elasticsearch search over recipient, subject and body, for your emails only |
| GET | `/api/stats` | Counts per status, plus `scheduled` and `sent` totals |
| GET | `/api/senders` | Sender pool (`id`, `name`, `email`) |
| GET | `/api/slack/status` | `{ connected, teamName, channel }` |
| GET | `/api/slack/connect` | 302 to Slack's authorize page (`?redirect=false` returns `{ url }`) |
| GET | `/api/slack/callback` | Slack redirect target (identified by signed state) → `FRONTEND_URL/dashboard?slack=connected\|denied\|error` |
| POST | `/api/slack/test` | Sends a test message to the connected channel |
| DELETE | `/api/slack` | Disconnects Slack |
| GET | `/admin/queues` | Bull Board UI (basic auth) |

Limits:
- **Campaign:** 1–10,000 leads; `delayBetweenMs` 0–86,400,000; `hourlyLimit` 1–100,000.
- **Lists:** `limit` at most 100 per page.

## How scheduling, rate limiting and recovery work

### Email lifecycle

```mermaid
stateDiagram-v2
    [*] --> SCHEDULED: campaign created
    SCHEDULED --> SENDING: atomic claim (job due)
    RATE_LIMITED --> SENDING: atomic claim (new slot due)
    SENDING --> SENT: SMTP accepted
    SENDING --> RATE_LIMITED: hourly quota full → next-window slot
    SENDING --> SCHEDULED: SMTP error, retries left (backoff)
    SENDING --> FAILED: SMTP error, last attempt
    SENDING --> SENDING: stale claim reclaimed (worker crashed)
```

### Idempotency (why an email isn't sent twice)

1. **`jobId = emailId`**: BullMQ ignores an `add` whose jobId already exists, so re-enqueueing (reconciliation, retries by hand) can't create a second live job.
2. **Atomic claim in Postgres.** The worker runs, in one statement:
   ```sql
   UPDATE "Email" SET status='SENDING', attempts=attempts+1
   WHERE id=$1 AND ((status IN ('SCHEDULED','RATE_LIMITED') AND "scheduledAt" <= now+1s)
                 OR (status='SENDING' AND "updatedAt" < now - STALE_SENDING_MS))
   RETURNING …
   ```
   Only one caller gets a row back; everyone else sends nothing (tested: 10 concurrent claims give exactly 1 winner).
3. **A job that can't claim never sends.** It checks the row:
   - SENT or FAILED: the job completes as a no-op;
   - not due yet: it's re-delayed until `scheduledAt`;
   - SENDING elsewhere: it's re-delayed until that claim would count as stale.

### Persistence across restarts

- **Delayed jobs live in Redis with AOF.** Stopping and starting the API, the worker or Redis itself doesn't lose them.
- **Boot reconciliation** runs once in the API and once in the worker, guarded by a Redis lock:
  - it scans SCHEDULED, RATE_LIMITED and SENDING rows in batches of 500;
  - any row without a live job gets one added with the same jobId and the remaining delay;
  - a job that is completed or failed while its row is still pending is replaced.
  
  Because of the atomic claim, reconciliation can't cause a double send. This was verified by `FLUSHDB` on Redis with pending emails: both were re-queued and each sent once.
- **Graceful shutdown:** on SIGINT/SIGTERM, `worker.close()` waits for active jobs before Redis and Prisma disconnect.

### Rate limiting

The limits, all shared through Redis so they hold across any number of workers:

| Mechanism | Redis state | What it enforces |
| --------- | ----------- | ---------------- |
| BullMQ worker `limiter: { max: 1, duration: MIN_SEND_INTERVAL_MS }` | `bull:email-send:limiter` | At most **one job start** per interval, across all workers |
| Lua quota script | `rl:{senderId}:{YYYYMMDDHH}` and optional `rl:global:{YYYYMMDDHH}` | Checks and increments in one step; nothing is counted unless every limit has room. TTL 2 h |
| Deferral slots | `rl:defer:{senderId\|global}:{YYYYMMDDHH}` | Ordered slots in the next window with room |
| Alert guard | `rl:notified:{userId}:{senderId\|global}:{YYYYMMDDHH}` (`SET NX EX 3600`) | One Slack alert per user per sender per hour window |

**Effective per-sender limit:** `min(campaign.hourlyLimit, MAX_EMAILS_PER_HOUR_PER_SENDER)`. The global cap `MAX_EMAILS_PER_HOUR` also applies when set. Windows are **fixed UTC clock hours**.

**When the quota is full, the email is not failed or dropped:**
1. `slot = INCR rl:defer:{scope}:{nextHour}`.
2. `runAt = nextHourStart + (slot − 1) × MIN_SEND_INTERVAL_MS`, so earlier-deferred emails run first.
3. If `slot` is greater than that window's limit, the search rolls forward hour by hour.
4. The row becomes `RATE_LIMITED` with the new `scheduledAt` (`originalScheduledAt` keeps the requested time).
5. The job is re-delayed with `job.moveToDelayed(runAt)` plus `DelayedError`, which doesn't use up a retry attempt.
6. The first time a sender is over its limit in a window, a Slack alert is sent. It gives the sender, the limit, the window, how many emails were deferred, and when the next window starts.

## Scaling / 1000+ email execution

### The model

Let:

| Symbol | Meaning | Default |
| ------ | ------- | ------- |
| N | emails in the campaign | |
| I | `MIN_SEND_INTERVAL_MS` | 2 s |
| d | campaign `delayBetweenMs` | set by you |
| S | number of senders (round-robin) | 3 (seed) |
| L | `min(campaign.hourlyLimit, MAX_EMAILS_PER_HOUR_PER_SENDER)` | ≤ 200 |
| G | `MAX_EMAILS_PER_HOUR` | unset (∞) |
| c | `WORKER_CONCURRENCY` × number of worker processes | 5 × 1 |
| t | SMTP time per message | ~3–4 s observed on Ethereal |

The formulas that follow directly from the code:

- **Job-start ceiling (shared by all workers):** `3,600,000 / I` per hour, i.e. **1,800/hour at I = 2 s**. The BullMQ limiter is one Redis key for the whole queue, so adding workers or concurrency doesn't raise this.
- **Hourly send capacity:** `C = min(S × L, G)`.
- **Earliest start of email *i*:** `startTime + i × d` (from its scheduled time), and never sooner than `I` after the previous job start.
- **Concurrency** only matters for letting SMTP sessions overlap. You need about `c ≥ ⌈t / I⌉` (4 s / 2 s = 2) to keep up with the limiter; the default 5 is enough. More concurrency doesn't speed anything up.
- **Every job start counts against the limiter, including jobs that are only being deferred.** So in a window where emails are deferred, the limiter spends slots on `sends + deferrals`.

"Theoretical" below means what the code allows at best. The actual finish time also depends on SMTP latency and on when in the hour the campaign starts.

### Example A: 1000 emails, 10 concurrent, 2 s interval, no hourly limit

To make the hourly limit irrelevant, set `hourlyLimit ≥ 334` and `MAX_EMAILS_PER_HOUR_PER_SENDER ≥ 334` (1000 / 3 senders), and leave `MAX_EMAILS_PER_HOUR` unset. Use `d ≤ 2 s`.

- **Lower bound:** `(N − 1) × max(d, I) = 999 × 2 s = 1,998 s ≈ 33 min 18 s` until the last job *starts*, plus about 4 s for its SMTP send, so **≈ 33½ minutes**.
- **The bottleneck is the 2 s limiter, not the workers.** With 10 concurrent slots a new send still starts only every 2 s, and each takes ~4 s, so about 2 sends are ever in flight. Concurrency 10 gives no speed-up over concurrency 2.
- **Without the limiter**, 10 parallel 4-second sends would allow ~2.5/s (~400 s for 1000), but the configured 2 s gap is exactly what prevents that.
- **With a larger `d`** (e.g. 5 s), `d` dominates: 999 × 5 s ≈ 83 min.
- **With the defaults** (`MAX_EMAILS_PER_HOUR_PER_SENDER = 200`, 3 senders), capacity is 600/hour, so this becomes Example B.

### Example B: 1000 emails, hourly limit 200

The campaign's `hourlyLimit` is **per sender**, so the outcome depends on how many senders share the load.

**B1: 3 senders (default seed), `hourlyLimit = 200`, all due at once (`d = 0`), started at 10:00 UTC**
- **Split:** round-robin gives 334 / 333 / 333 emails per sender, and capacity is `C = 3 × 200 = 600/hour`.
- **10:00–11:00:** 600 are sent, 200 per sender. The other **400 are deferred, not dropped**: about 134 per sender get slots 1…134 in the 11:00 window, at `11:00:00 + (slot − 1) × 2 s`.
- **Limiter load in the first hour:** 600 sends + 400 deferral decisions = **1,000 job starts × 2 s ≈ 33 min**, which fits in the hour.
- **11:00 onwards:** about 400 sends, finishing around **11:13–11:14**. Two things space them out: each sender's slots are 2 s apart, and the shared limiter allows one start per 2 s overall.
- **Total ≈ 1 h 14 min for 1000 emails.**
- **Started at 10:45 instead:** only about 450 job starts fit before 11:00. Emails still waiting at 11:00 are then processed in the 11:00 window and charged to *its* quota, together with the ones already deferred there. The limits still hold; the order across windows just loosens a little.

**B2: "about 200 in the first hour": one sender, or a global cap `MAX_EMAILS_PER_HOUR=200`**
- **Window 1:** 200 sent.
- **The other 800 are deferred, 200 per window:** 11:00, 12:00, 13:00 and 14:00, taking about 200 × 2 s ≈ 6 min 40 s at the start of each hour. Which Redis counters hold those deferrals depends on which limit was hit:
  - **one sender with `hourlyLimit = 200`:** the sender's own counters (`rl:{senderId}:…` and `rl:defer:{senderId}:…`);
  - **`MAX_EMAILS_PER_HOUR = 200`:** the shared global counters (`rl:global:…` and `rl:defer:global:…`).

  The numbers come out the same either way.
- **Total:** 5 windows, so the last emails go out around **14:07** for a 10:00 start.
- **Slack:** exactly one alert for the first window, with the limit, the window, the number deferred and the next window start.

**Measured (actual run):** 1200 emails, `hourlyLimit = 50`, 3 senders, **2 worker processes**, `MOCK_SMTP=true`, `MIN_SEND_INTERVAL_MS=50`.

| Metric | Result |
| ------ | ------ |
| Processing time | all 1200 jobs processed in ~60 s |
| Sent | exactly **150** (3 × 50) in the current hour |
| Deferred | **1050**, spread **150 per hour over the next 7 windows** (`⌈1200 / 150⌉ = 8` windows in total) |
| Order violations among deferred emails | 0 |
| Distinct deferral slots | 1050 |
| Max per sender per hour | 50 |
| Slack alerts | exactly 3 (one per sender) |

### Example C: several workers sharing Redis

Running 3 worker processes × concurrency 5 against the same Redis and Postgres:

| Concern | Why it holds across workers | Tested |
| ------- | --------------------------- | ------ |
| Minimum gap between sends | The BullMQ limiter is a single Redis key per queue, so throughput stays at one start per `I` in total, not per worker | Measured load test with **2 worker processes** and `MIN_SEND_INTERVAL_MS=50`: 1200 jobs took **~60 s** (≈ 1200 × 50 ms, one start per 50 ms *overall*) |
| Hourly quota | Check-and-increment runs **inside one Lua script**, which Redis runs atomically, so no worker sees a stale count | Same 2-worker run: limit 50/h × 3 senders gave exactly **150 sent** in the current hour and **1050 deferred**, with no sender over 50. The two workers shared the limit rather than each getting 50/h. Unit test: 100 concurrent checks with limit 10 → exactly 10 allowed |
| Deferral order | `INCR` hands out each slot number exactly once | 30 concurrent deferrals → 30 distinct slots |
| Duplicate sends | Postgres row-level atomic claim | 10 concurrent claims → 1 winner |
| Boot reconciliation | Redis `SET NX` lock; duplicates are also harmless because of jobId and the claim | |

More workers therefore add **availability and SMTP parallelism, not more throughput** beyond `3,600,000 / I` per hour and `C` per hour. All workers must use the **same `MIN_SEND_INTERVAL_MS`**: the limiter key is shared, so a worker with a larger interval slows every worker down to its pace.

## Running tests and checks

The backend tests are integration tests. They need the Docker services running and use an isolated database (`reachinbox_test`), Redis DB 15, and the `emails_test` index. Slack is replaced by a local HTTP server, so no network is needed.

```bash
docker compose up -d --wait

cd backend
npm run test:db        # creates/migrates reachinbox_test (safe to re-run); see the Windows note below
npm test               # Vitest
npm run lint           # eslint (no `any`, no console)
npm run typecheck      # tsc --noEmit
npm run format:check   # prettier --check
npm run build          # compile to dist/

cd ../frontend
npm test               # vitest: CSV/TXT lead extraction
npm run lint
npm run typecheck      # tsc --noEmit
npm run format:check
npm run build          # production build
```

**On Windows:** the `test:db` script uses Unix-shell syntax (`DATABASE_URL=… prisma migrate deploy`), so run its equivalent in PowerShell instead. Use a **separate terminal**, because `$env:DATABASE_URL` stays set for that session and would point `npm run dev` at the test database:

```powershell
cd backend
$env:DATABASE_URL="postgresql://reachinbox:reachinbox@localhost:5433/reachinbox_test?schema=public"; npx prisma migrate deploy
```

Every other test, lint, typecheck, format and build command above works the same on Windows.

At the time of this submission, the backend suite contains 64 tests and the frontend suite 4.

**What the tests cover:**

| Area | Coverage |
| ---- | -------- |
| Lua rate limiter (real Redis) | Allows up to N then denies; exact under 100 concurrent calls; hours counted separately; global cap |
| Deferral | Ordered slots, next-hour rollover, unique slots under concurrency |
| Hour windows | UTC keys and slot times (pure functions) |
| Scheduling | `scheduledAt` spacing, round-robin assignment, and a selected sender used for every email (unknown sender rejected) |
| Idempotency | Concurrent claims; stale reclaim; not claimable before due |
| Processor end-to-end | Send, defer, one Slack alert, no resend |
| Slack | OAuth code exchange with encrypted storage; callback redirects; webhook failures don't throw; disconnected = skipped |
| Elasticsearch (real cluster) | Mapping, prefix/text search, user isolation, status filter, out-of-order updates ignored |
| Load-test cleanup | Removes only the load test's share of Redis rate-limit state |

## Load test

Schedules a large campaign whose leads are all due at once, with a low hourly limit, to show deferral into later windows. It runs as a separate "Load Test" user. Run the worker in mock mode so nothing goes through Ethereal, and make sure **no other worker is running** (e.g. stop `npm run dev:all`), or that worker will also pick up the jobs:

Terminal 1, the mock-mode worker:

```bash
# macOS / Linux
cd backend
MOCK_SMTP=true MIN_SEND_INTERVAL_MS=50 npm run dev:worker
```

```powershell
# Windows PowerShell (the variables stay set for this terminal session only)
cd backend
$env:MOCK_SMTP="true"; $env:MIN_SEND_INTERVAL_MS="50"; npm run dev:worker
```

Terminal 2, the same on every platform:

```bash
cd backend
npm run load-test -- --count 1200 --hourly-limit 50 --watch
npm run load-test -- --cleanup       # afterwards
```

**What `--watch` prints:**
- progress;
- emails sent per sender per UTC hour, flagging any hour over the limit;
- deferred emails by target hour;
- the number of sent emails that needed more than one attempt.

**What `--cleanup` removes:**
- the load-test user's rows, queued jobs and search documents;
- its Slack alert guards;
- deferral counters in windows where no other user has deferred emails;
- this hour's quota used by load-test sends.

Rate-limit state belonging to other users is left alone.

## Demo script

**1. Basic flow (~2 min)**
1. Sign in with Google and point out the avatar, name and email in the header.
2. Click **Compose New Email**. Upload a CSV (see "N emails detected" and the preview), set a start time about 1 minute ahead, a delay of 2 s and an hourly limit of 50, then click **Schedule**.
3. On the Scheduled tab, show the local times.
4. Once they're sent, open the Sent tab and click **Preview** to see the email on Ethereal.
5. Search for a recipient or a subject word.

**2. Restart survival (~1 min)**
1. Schedule an email about 2 minutes ahead.
2. Stop the API and worker (Ctrl+C on `npm run dev:all`), and wait until the scheduled time has passed.
3. Start `npm run dev:all` again. The email is sent right away, **once**. In the Sent tab it shows up once, and `attempts = 1` in the database.

**3. Rate limit and Slack (~1 min)**

> **Start from a clean rate-limit state.** Hourly counters are kept **per sender per UTC hour** and shared by every campaign and user. Anything those senders already sent earlier in the same UTC hour (steps 1–2, or other tests) counts toward the limit.
>
> Run this part **at the start of a fresh UTC hour, before anything else is sent that hour**, and with no other emails due in it. (You can also record it first.) Otherwise more emails will be deferred than listed below, and there can be up to one alert per sender, so the exact numbers aren't guaranteed.

**Per-sender limit** (`MAX_EMAILS_PER_HOUR` unset, Slack connected):
1. Schedule **4 leads** with **hourly limit 1**, starting a minute or so ahead but still within the same hour.
2. Round-robin assigns sender 1 → lead 1, sender 2 → lead 2, sender 3 → lead 3, sender 1 → lead 4.
3. From a clean state, **3 are sent** and **lead 4 becomes Rate limited**. It's rescheduled to the start of the next UTC hour, and its row shows "moved from …".
4. `#channel` receives **one** "Hourly send limit reached" alert, for sender 1.

**Global cap** (optional, shows the global limit):
1. Set `MAX_EMAILS_PER_HOUR=1` in `backend/.env` and restart the API and worker.
2. Schedule **3 leads** (one per sender) with **hourly limit 50**.
   - Each email is checked against its sender's limit first, then the global cap.
   - A high per-sender limit means only the global cap can stop them.
   - With hourly limit 1, a sender that already sent this hour would be stopped by its own limit first, with a separate per-sender alert.
3. **Needs a clean state too:** no sender at its limit, and nothing sent this UTC hour while the global cap was on. (The global counter only counts while `MAX_EMAILS_PER_HOUR` is set.)
4. **Result from that state:**
   - **1 sent** and **2 deferred:** the next hour's global capacity is 1, so one goes to the start of the next hour and the other rolls to the hour after.
   - **one** alert for "all senders (global limit)".
5. Remove `MAX_EMAILS_PER_HOUR` from `backend/.env` again and restart afterwards.

**4. Bull Board.** Open `http://localhost:4000/admin/queues` (basic auth) and show the delayed jobs for the deferred emails.

## Assumptions, trade-offs and known limitations

- **At-least-once edge case:** if a worker crashes *after* SMTP accepted a message but *before* the `SENT` update, the row stays `SENDING`. It's reclaimed after `STALE_SENDING_MS` and sent again. The fixed `Message-ID <emailId@reachinbox.local>` makes such a duplicate identifiable. Exactly-once delivery isn't possible over plain SMTP without the provider's help.
- **Hour windows** are fixed UTC clock hours, not a sliding 60 minutes. A sender can send up to L at 10:59 and L again at 11:00.
- **The limiter counts deferrals too.** In a window with a large backlog over the limit, deferral decisions use limiter slots (Example B1). If the backlog spills past the hour boundary, those emails are charged to the next window, so order across windows is best-effort. Per-sender limits are never exceeded.
- **All workers must share `MIN_SEND_INTERVAL_MS`**, since the BullMQ limiter key is shared.
- **Round-robin assignment is fixed at creation.** The hourly limit is per sender, so the total per hour is `senders × limit` unless `MAX_EMAILS_PER_HOUR` is set.
- **The UI polls every 5 s** (SWR) instead of using websockets. That's a UI refresh, not scheduling.
- **Search** is eventually consistent. Results are loaded from Postgres so statuses are always current, and `npm run reindex` rebuilds the index.
- **Slack alerts** go once per *user* per sender per window, so a sender shared by several users alerts each of them. A free ngrok URL changes on restart (see the Slack section).
- **Sessions** are stateless JWTs (7 days). Logout clears the cookie; there's no server-side revocation list.
- **Session cookie:** locally it's `HttpOnly; SameSite=Lax` over plain `http://localhost`. With `NODE_ENV=production` it's `HttpOnly; Secure; SameSite=None`, so it's sent even when the dashboard and API are on different sites (e.g. separate `*.up.railway.app` domains). No `Domain` attribute is set, so the API remains the cookie's owner.
  - To the dashboard, this is a third-party cookie.
  - **Chrome** sends it with default settings.
  - **Safari** blocks third-party cookies, and **Firefox** keeps them in separate per-site storage, so on those browsers login can succeed but API calls then return 401.
  - Hosting the dashboard and API under one domain (e.g. `app.example.com` and `api.example.com`) avoids this.
- **Ethereal SMTP passwords** in the `Sender` table are stored in plain text. They're throwaway test accounts; only the Slack webhook is encrypted, as required.
- **UI design:** the Figma file wasn't available, so the dashboard follows the written requirements.
