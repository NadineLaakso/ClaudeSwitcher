# ClaudeSwitcher

Tray app for running several Claude Desktop (Windows, Microsoft Store) instances side by side, each signed in to a different account.

- Each instance gets its own profile at `%APPDATA%\Claude-<name>` and is launched with `--user-data-dir`.
- The same account can't run in two instances at once.
- **First login for a new instance:** ClaudeSwitcher closes all Claude windows and opens only that instance. The `claude://` sign-in callback arrives as a new `Claude.exe` process without a profile flag; `login-watcher.ps1` kills it and re-sends the link into the instance's profile.
- Lives in the system tray: launch/stop/log in per instance, optional "Start with Windows".

## Run

```bash
npm install
npm start
```
