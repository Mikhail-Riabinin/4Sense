# 4Sense (Obsidian Plugin)

4Sense summarizes supported files in a selected folder via external API,
saves the summary in folder context, and provides a chat modal that can use the
summary as context.

Settings include API host, API key, and endpoint paths for transcription,
summary, and chat.
Audio files are sent to a transcription endpoint first and then included in the summary.

## Commands

- Summarize folder (select)
- Summarize current file folder

## UI

- Ribbon icon for chat (opens folder picker and creates summary if missing)
- File explorer context menu item for chat (folder or file parent folder)

## Privacy and Network

- The plugin sends selected folder content to your configured API host.
- Sent data can include markdown text, image binaries (base64), and audio binaries for transcription.
- If `API key` is configured, it is sent as `Authorization: Bearer <key>`.
- Chat transport is WebSocket by default: `ws(s)://<host>/<chatPath>?websocket=True`.
- If WebSocket is unavailable or fails, plugin falls back to HTTP `POST <host>/<chatPath>`.
- For WebSocket chat, `apiKey` is included in the first JSON payload message.
- Generated summary, chat logs, and downloaded artifacts are stored under `<folder>/4senseContext/`.

## Build

```bash
npm install
npm run dev
```

Copy `main.js`, `manifest.json`, and `styles.css` into your Obsidian vault
plugin folder.
