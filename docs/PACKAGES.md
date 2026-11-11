# Packages and Dependencies Documentation

This document describes the third-party packages used in the Job Pulse application and explains their purpose in the architecture.

## Backend Dependencies

The backend is built as a Node.js service (`backend/package.json`) and relies on the following key packages:

| Package | Version | Purpose |
| :--- | :--- | :--- |
| **express** | `^4.19.2` | A fast, minimalist web framework. It powers the REST API endpoints that the frontend UI communicates with (e.g. fetching jobs, toggling applied status, updating settings, viewing logs). |
| **sqlite3** | `^5.1.7` | Self-contained, serverless database engine. Used to store job listings, scraper configuration keys, and system activity logs locally in `backend/job_notifier.db`. |
| **axios** | `^1.6.8` | Promise-based HTTP client. Used to fetch public search pages from LinkedIn, SimplyHired, and Dice, and query the Adzuna API. |
| **cheerio** | `^1.2.0` | Server-side implementation of jQuery. Used to parse the scraped HTML markup from job boards and extract structured fields like job title, company, URL, and location. |
| **rss-parser** | `^3.13.0` | A lightweight XML-to-JSON parser. Used to read job listings from RSS feeds of platforms like We Work Remotely, RemoteOK, and Working Nomads. |
| **node-cron** | `^3.0.3` | A pure JavaScript task scheduler. Used to run the job scraping cycle in the background on a configurable cron schedule. |
| **cors** | `^2.8.5` | Cross-Origin Resource Sharing middleware. Allows the React frontend (running on port `5173`) to make API requests to the Express backend (running on port `5000`) during development. |
| **dotenv** | `^16.4.5` | Zero-dependency module that loads environment variables from a `.env` file into Node's `process.env`. |

---

## Frontend Dependencies

The frontend dashboard is a React application built with TypeScript and Vite (`frontend/package.json`).

### Production Dependencies

| Package | Version | Purpose |
| :--- | :--- | :--- |
| **react** | `^19.2.7` | UI library used to build the component-based, interactive single-page dashboard. |
| **react-dom** | `^19.2.7` | Serves as the entry point to the browser DOM for React. |

### Development Dependencies

| Package | Version | Purpose |
| :--- | :--- | :--- |
| **vite** | `^8.1.1` | A fast build tool and development server that handles hot module replacement (HMR) and compiles assets. |
| **typescript** | `~6.0.2` | Provides static typing and modern JavaScript compilation for safer and cleaner development. |
| **oxlint** | `^1.71.0` | An ultra-fast JavaScript and TypeScript linter to catch syntax bugs and code smell. |
| **@vitejs/plugin-react** | `^6.0.3` | The official Vite plugin for React, supporting fast compilation and JSX processing. |
