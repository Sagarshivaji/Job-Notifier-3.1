# Local setup guide

## Prerequisites

Make sure these are installed first:

- Node.js 18 or newer
- npm
- A terminal such as PowerShell, Command Prompt, or Git Bash

## Install dependencies

From the project root:

```bash
cd backend
npm install

cd ../frontend
npm install
```

The app uses these packages:

- Backend packages: express, cors, dotenv, axios, cheerio, sqlite3, node-cron, rss-parser
- Frontend packages: react, react-dom, vite, typescript, and supporting type packages

If you prefer to install everything from the root later, you can add your own convenience script, but the two folders are separate Node projects.

## Environment variables

Create a backend environment file:

```bash
cd backend
copy .env.example .env
```

The file can include optional values such as:

```env
PORT=5000
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
DISCORD_WEBHOOK_URL=
ADZUNA_APP_ID=
ADZUNA_APP_KEY=
ADZUNA_COUNTRY_CODE=us
```

These values are optional. The app can still run without them, but notifications and Adzuna scraping will be limited.

## Start the backend

```bash
cd backend
npm start
```

The server will run on http://localhost:5000.

## Start the frontend

In a second terminal:

```bash
cd frontend
npm run dev
```

The frontend will run on http://localhost:5173.

## Windows launcher

If you are on Windows, you can launch both with:

```bat
run.bat
```

## Troubleshooting

- If the frontend cannot load data, make sure the backend is running on port 5000.
- If Vite shows a port conflict, stop the process using that port or run a different port:

```bash
npm run dev -- --port 5174
```

- If the app shows a blank screen, check the browser console and the backend terminal for errors.
- The first run creates backend/job_notifier.db automatically.
