# User guide

## Open the app

After starting both services, open the frontend at:

- http://localhost:5173

## Configure search settings

Use the settings panel to choose:

- Keywords, such as React, Node, Python
- Location, such as United States or Remote
- Work type, such as onsite, remote, or hybrid
- Scrape interval
- Enabled sources

## Run the scraper manually

You can trigger a manual sync from the dashboard or settings area. This will fetch new jobs and save them to the local database.

## Review jobs

The dashboard shows stored jobs with details such as:

- Title
- Company
- Location
- Source
- Link

You can mark jobs as applied when needed.

## Notifications

To test or enable alerts:

1. Open the settings screen.
2. Enter Telegram or Discord details.
3. Use the test notification button.

If you do not provide these values, the app will still work for scraping and display, but notifications will be skipped.

## Logs

The app keeps a local log of scraper activity and notification attempts. Review logs if a scrape does not return jobs or a notification fails.
