# Basecamp Simple Timer

A Chrome extension that tracks time on Basecamp tasks. Use it as a stopwatch with click-to-copy hours, or connect your own Cloudflare backend to log time directly to Basecamp Timesheets.

* Start a timer from the current Basecamp page.
* Automatically pause the previous task when starting another.
* Keep elapsed time across browser restarts using locally saved timestamps.
* Copy decimal hours or log them directly after connecting Basecamp.

## Quick Start

The stopwatch works without a backend, Node.js, or API credentials.

1. Download or clone this repository.
2. Open `chrome://extensions` in Chrome and enable **Developer mode**.
3. Click **Load unpacked** and select the repository's `extension/` folder.
4. Open a supported Basecamp page, open the extension, and click **+ Start Timer**.

To enable the **Log** button, follow the [self-hosting setup guide](docs/SETUP.md). You need your own Cloudflare Worker, D1 database, and Basecamp OAuth integration. This repository does not provide a shared backend.

## Usage

| Action | How it works |
| --- | --- |
| Start or resume | Click **+ Start Timer** on the current page, or the play icon on an existing timer. Any other running task pauses. |
| Pause | Click the pause icon beside a task. |
| Copy hours | Click the decimal hours and paste the value into Basecamp manually. |
| Open task | Click its title to navigate to the Basecamp page. |
| Log time | After connecting Basecamp, click **Log** and confirm an optional note. The entry uses today's local date; the timer is removed after successful logging. |
| Delete timer | Click the trash icon to remove the local timer. |

### Keyboard Shortcuts

- `Cmd` + `Shift` + `E`: Open or close the extension popup on macOS (`Alt` + `Shift` + `E` on Windows/Linux).

With the popup open:

- `a`: Start/add timer
- `s`: Save/log selected timer
- `Space`: Play/pause selected timer
- `d`: Delete selected timer
- `q`: Close popup
- `Enter`: Jump to selected task in Basecamp
- `Arrow Up` / `Arrow Down`: Move selection
- `Tab` / `Shift` + `Tab`: Move selection

## Supported Pages and Limitations

Timers support Basecamp to-dos, cards, messages, documents, and schedule entries on `3.basecamp.com` and `app.basecamp.com`.

Project overview pages are not supported for starting timers. Direct logging targets a concrete recording, such as a to-do or card. The connected user must have permission to create the corresponding Timesheet entry.

## Privacy and Permissions

Task timers are stored locally in Chrome. When connected, the extension also stores an app session token. The backend stores user/account information and encrypted Basecamp OAuth tokens in D1; the extension never receives those OAuth tokens. Logging sends the time-entry details to your backend and then Basecamp.

Chrome permissions are used as follows:

* `storage`: save timers and connection settings locally.
* `activeTab`: access the current page when you interact with the extension.
* `identity`: complete the Basecamp sign-in flow.
* Cloudflare host permissions: call backends on `*.workers.dev` and `*.pages.dev`.
* Optional host permissions: request access to your specific backend origin when connecting to a custom domain.

Keep secrets and deployment-specific configuration in the ignored local files described in the [setup guide](docs/SETUP.md).

## Development

Run the local syntax and mocked behavior checks from the repository root:

```bash
npm run check
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for project structure and local development, [AGENTS.md](AGENTS.md) for coding-agent instructions, and the [API reference](docs/API.md) for backend routes.

Deployment owners can use the [deployment checklist](DEPLOYMENT_CHECKLIST.md) after following the setup guide.

## Project Status

This tool is built for our team's internal use and shared for others to adapt to their own workflows.
