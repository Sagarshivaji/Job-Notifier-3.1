# Job Notifier — Browser Extension

A Chrome extension that captures job listings directly from your browser as you search on **Indeed**, **Naukri**, **Glassdoor**, and **LinkedIn** — then sends them straight to your Job Notifier dashboard.

---

## How It Works

```
Browser (Indeed / Naukri / Glassdoor / LinkedIn)
        ↓  you search & browse manually
[Extension] reads job cards from the page DOM
        ↓
POST /api/jobs/import  →  Backend
        ↓
Normalize → Deduplicate → Apply your filters
        ↓
Database → Discord / Telegram / Dashboard
```

---

## Installation (Developer Mode)

> **No Chrome Web Store required — load it directly.**

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer Mode** (toggle in top-right)
3. Click **"Load unpacked"**
4. Select the `browser-extension/` folder inside this project

The extension icon (🔔) will appear in your toolbar.

---

## Usage

1. Go to **[Indeed](https://www.indeed.com)**, **[Naukri](https://www.naukri.com)**, **[Glassdoor](https://www.glassdoor.co.in)**, or **[LinkedIn Jobs](https://www.linkedin.com/jobs/)** and search for roles
2. Scroll through results to load more job cards
3. Click the **Job Notifier extension icon** in your toolbar
4. The popup shows how many jobs were detected
5. Enter your **Backend URL** (default: `http://localhost:5000`)
6. Enter your **Auth Token** (copy from your dashboard — see below)
7. Click **"Send to Job Notifier"**
8. New jobs appear in your dashboard and Discord/Telegram notifications fire 🎉

---

## Getting Your Auth Token

1. Log into your Job Notifier dashboard in another tab
2. Open DevTools → Application → Local Storage → your site
3. Copy the value of `token`
4. Paste it into the extension's **Auth Token** field

> The token is saved in the extension so you only need to do this once (until you log out).

---

## Supported Sites

| Site | Status |
|------|--------|
| Indeed | ✅ Full support |
| Naukri | ✅ Full support |
| LinkedIn Jobs | ✅ Full support |
| Glassdoor | ✅ Full support (selectors may need updates if Glassdoor changes its markup) |
| Dice | 🔜 Coming soon |

---

## Files

```
browser-extension/
├── manifest.json     ← Chrome extension config
├── content.js        ← DOM parser (injected into job sites)
├── popup.html        ← Extension popup UI
├── popup.js          ← Popup controller
├── background.js     ← Service worker (badge updates)
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## Backend API

The extension calls:

```
POST /api/jobs/import
Authorization: Bearer <token>
Content-Type: application/json

{
  "jobs": [
    {
      "id": "ind_abc123",
      "title": "Frontend Developer",
      "company": "Acme Corp",
      "url": "https://www.indeed.com/viewjob?jk=abc123",
      "location": "Mumbai, India",
      "salary": "₹12-18 LPA",
      "description": "...",
      "source": "Indeed (Extension)"
    }
  ]
}
```

Response:
```json
{ "success": true, "added": 3, "skipped": 7 }
```
