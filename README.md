# billion-context-pi-pocket-adapter

Runs [billion-context-pi](https://pi.dev/packages/billion-context-pi) in [Pi Pocket](https://github.com/TannerMidd/pi-pocket), with compression that survives forks.

billion-context-pi lets the model fold old parts of a long conversation into summaries itself (`compress`, `decompress`, `search_context`), so long sessions stay under the model's context limit. It is a pi extension, written for pi's terminal extension API. Pi Pocket runs Pi Durable extensions instead, so it cannot load billion-context-pi directly. This adapter is a single Pi Pocket drop-in that gives billion-context-pi the API it expects.

## Requirements

- **Pi Pocket**.
- **billion-context-pi**, installed with pi: `pi install npm:billion-context-pi` ([pi package](https://pi.dev/packages/billion-context-pi), [npm](https://www.npmjs.com/package/billion-context-pi)). Tested with version 0.1.83. Other versions load, with a warning in the app.

The adapter does not install billion-context-pi itself.

## Install

1. Copy `billion-context-pi-pocket-adapter.ts` into Pi Pocket's `extensions/` folder (`~/.pi-pocket/extensions/` by default).
2. Turn it on in Menu → Extensions.

Read the file before turning it on: a drop-in runs inside Pi Pocket's server, with the owner's rights.

## Settings

All optional. Put them in `billion-context-pi-pocket-adapter.json`, next to the `.ts` file:

```json
{
  "billionContextPi": "/path/to/node_modules/billion-context-pi",
  "stateDir": "billion-context-pi",
  "extensionName": "billion-context-pi"
}
```

| Setting | Default | What it is |
| --- | --- | --- |
| `billionContextPi` | `<pi agent folder>/npm/node_modules/billion-context-pi`, where `pi install` puts it | billion-context-pi's package folder, if it is installed elsewhere |
| `stateDir` | `billion-context-pi`, in Pi Pocket's data folder | Where compression state and fork checkpoints are kept. A relative path is resolved from the data folder |
| `extensionName` | `billion-context-pi` | The extension's name in Pi Pocket. Sessions store it, so do not change it after you start using the adapter |

billion-context-pi's own settings stay where it keeps them: `~/.pi/acp.json`, with its log in `~/.pi/acp.log` (see its README).

A settings change takes effect when the adapter reloads. To reload it, save the `.ts` file, or turn the adapter off and on again.

## Forks

billion-context-pi keeps its compression state in a file for each session. On its own, a fork of a session starts without that state, so the old messages come back at full size.

After each compression, the adapter saves a checkpoint of the state and puts its ID in the tool result. The model does not see it. A fork restores the newest checkpoint in the history it inherited, so it starts with exactly the compression made before its fork point:

- later compression in the parent is not carried over,
- the parent's state is never changed,
- a fork that already has its own state keeps it.

Sessions compressed before checkpoints existed fall back to billion-context-pi's own replay of the compress calls in their history.

Checkpoints are stored in `checkpoints/` inside the state folder, one file per state. They are not deleted automatically.

## Plan mode

Pi Pocket's plan mode blocks tools that are not on its list. The adapter marks `compress`, `decompress`, `search_context`, `acp_status`, and `acp_cache` as read-only (`annotations: { readOnlyHint: true }`), since they change only what the model sees of the conversation. A Pi Pocket that lets read-only tools run in plan mode keeps compression working while Pi plans; an older one blocks them there until the plan is approved. The delegate tools start subagents, so they stay blocked in plan mode.

## What does not work

Pi Pocket has no terminal UI, so these billion-context-pi features are ignored:

- slash commands
- keyboard shortcuts
- the status line
- custom message rendering

## Process-wide effects

Loading the adapter:

- sets `PI_ACP_FORK_HOST=1`, which billion-context-pi needs to run outside pi's terminal,
- sets `ACP_AUTO_UPDATE=0`, so billion-context-pi cannot update itself under a running server; update it with `pi update` instead,
- adds a Node module resolve hook, so billion-context-pi's imports of pi's packages (`@earendil-works/pi-coding-agent` and the rest) resolve to Pi Pocket's own copies.

## Tests

```sh
npm install
PI_POCKET_CHECKOUT=/path/to/pi-pocket npm test
```

The tests load the adapter into a test Pi Pocket app with a scripted model and a temporary home folder. No request reaches a real provider, and your own `~/.pi` and Pi Pocket data are not touched.

## License

MIT. billion-context-pi is a separate project with its own MIT license; this repository does not include it.
