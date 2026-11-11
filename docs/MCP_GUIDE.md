# Model Context Protocol (MCP) Integration Guide

This application backend provides a native Model Context Protocol (MCP) server for external AI agents like Claude Desktop.

---

## 1. Architecture Highlights

| Architecture Element | Implementation Status | Details |
| :--- | :---: | :--- |
| **Remove Internal AI** | ✅ Verified | The backend contains **zero** internal OpenAI, Anthropic, or proprietary LLM API keys or smart-generation calls. The application pays **\$0.00** for AI. |
| **MCP Server Implementation** | ✅ Implemented | Built using the official `@modelcontextprotocol/sdk` (`McpServer`). |
| **Core Tool 1: `trigger_job_scan`** | ✅ Implemented | Scans platforms (LinkedIn, Adzuna, WeWorkRemotely, RemoteOK, Remotive, etc.), parses listings with given keywords/location, and populates the database and live feed. |
| **Core Tool 2: `update_job_status`** | ✅ Implemented | Accepts `job_id` and `status` (`Saved`, `Applied`, `Interviewing`, `Offer`, `Rejected`, `Archived`), updates the database record, and synchronizes with the frontend UI dashboard. |
| **Clean Stdio Transport** | ✅ Verified | All logging is strictly directed to `stderr`. `stdout` is exclusively dedicated to pristine JSON-RPC protocol frames, preventing any parse errors in Claude Desktop. |

---

## 2. Exposed MCP Tools

### Tool 1: `trigger_job_scan`
Triggers scrapers and APIs across enabled sources to discover new job postings.
* **Parameters**:
  * `keywords` *(string, optional)*: Comma-separated job titles or skill keywords (e.g. `"Full Stack Developer, React, Node.js"`).
  * `location` *(string, optional)*: Location preference (e.g. `"Remote"`, `"India"`, `"San Francisco, CA"`).
  * `sources` *(array or string, optional)*: List of sources to scan (e.g. `["linkedin", "adzuna", "weworkremotely", "remoteok", "remotive", "hackernews"]`).
  * `savePreferences` *(boolean, optional, default: true)*: Persists keywords and location into the user dashboard settings.
  * `userId` *(number, optional)*: Target user ID (defaults to primary/admin user).
* **Output**:
  Structured report indicating total discovered postings, count of newly saved jobs, platform breakdown, and a preview of newly added job titles and URLs.

### Tool 2: `update_job_status`
Updates a job listing's application lifecycle status in the database.
* **Parameters**:
  * `job_id` *(string or number, required)*: The numeric database ID or platform job hash.
  * `status` *(string, required)*: One of `["Discovered", "Saved", "Applied", "Interviewing", "Offer", "Rejected", "Archived"]`.
  * `user_id` *(number, optional)*: Target user ID.
* **Output**:
  Confirmation with job title, company, new status, applied flag, and confirmation that the change is reflected in the frontend UI dashboard.

### Companion Tools Included:
* **`list_jobs`**: Allows Claude to query existing jobs in the feed with filters (`status`, `search`, `limit`) so it knows which `job_id` to update.
* **`get_job_details`**: Retrieves full job description, salary, location, and discovered timestamp.
* **`get_scan_status`**: Queries whether a background scan is currently in progress.

---

## 3. Registering with Claude Desktop

### Configuration File Location
* **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`  
  *(Typically: `C:\Users\<YourUsername>\AppData\Roaming\Claude\claude_desktop_config.json`)*
* **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
* **Linux**: `~/.config/Claude/claude_desktop_config.json`

### Configuration Snippet
Add the `job-pulse` server entry inside the `mcpServers` object:

```json
{
  "mcpServers": {
    "job-pulse": {
      "command": "node",
      "args": [
        "C:\\Users\\Sagar\\Downloads\\volopay\\Job-Notifier2-main\\Job-Notifier2-main\\backend\\mcp-server.js"
      ],
      "env": {
        "NODE_ENV": "development"
      }
    }
  }
}
```

> **Note on Windows Paths**: Remember to use double backslashes (`\\`) in JSON file paths.

---

## 4. How to Use with Claude Desktop

1. Save your `claude_desktop_config.json` file.
2. Restart **Claude Desktop**.
3. Look for the 🔨 **tool icon** in the bottom-right of the Claude Desktop prompt box. You will see `job-pulse` with tools like `trigger_job_scan`, `update_job_status`, and `list_jobs`.
4. Try prompts such as:
   * *"Scan LinkedIn and WeWorkRemotely for 'Senior React Developer' jobs in 'Remote' and show me what you found."*
   * *"List my current jobs with status 'Discovered'."*
   * *"Update job ID 13 to status 'Interviewing' and mark job ID 14 as 'Saved'."*
   * *"Open http://localhost:5173 to see the status tags directly on your web dashboard."*
