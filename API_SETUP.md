# API Key Setup Instructions

Transcription calls go through the dev server. The Groq key is read in that Node process and is not compiled into the browser bundle.

## Setting Up Your Groq API Key

### Method 1: Server environment (recommended)

1. **Create `.env.local` in the project root** (this file is gitignored):

   ```bash
   GROQ_P7_KEY=your_groq_api_key_here
   VITE_DEFAULT_LANGUAGE=en
   ```

2. **Restart the development server:**

   ```bash
   npm run dev
   ```

3. **Confirm the status bar says "API configured on the server."** The browser never receives the key. `GET /api/stt/status` returns only `{ "configured": true }`.

Do not prefix the key with `VITE_`. Vite exposes `VITE_` variables to client code. This app additionally limits client env vars to `VITE_DEFAULT_` and `VITE_DEBUG_`. A key that was previously built into client assets should be rotated in the Groq console.

### Method 2: Session entry

1. **Start the application** without `GROQ_P7_KEY`.
2. **Click "Enter API Key"** in the configuration banner.
3. **Enter a Groq API key** when prompted.

That key stays in memory for the current page session. It is not written to `localStorage`, and it is not baked into the built JavaScript. Refreshing the page clears it.

## Security Notes

- `.env.local` is ignored by Git.
- `GROQ_P7_KEY` is used only by the `/api/stt` proxy when you run `npm run dev` or `npm run preview`.
- The proxy adds the bearer token on the server. Client code posts audio to `/api/stt/transcriptions` and does not call Groq with a shared key.
- If `VITE_GROQ_P7_KEY` is still present in an old env file, the server may use it as a fallback, but the Vite config does not inline it into the client. Prefer `GROQ_P7_KEY`, and rotate any key that was shipped in a previous build.

## Getting a Groq API Key

1. Visit https://console.groq.com/
2. Create an API key.
3. Put it in `.env.local` as `GROQ_P7_KEY`, or enter it for the current browser session.

## Testing

Once configured, you should see:

- Green "API configured on the server" or "Session key only (not saved)" status
- No configuration banner when a key is available
- Transcription requests to `/api/stt/transcriptions` on this origin

## Troubleshooting

**API key not loading:**

- Confirm `.env.local` contains `GROQ_P7_KEY=` and restart `npm run dev`.
- A static host that only serves `dist/` has no proxy. Use `npm run preview` after building, or enter a session key.

**Transcription not working:**

- Check the browser network panel for `/api/stt/transcriptions`.
- Failed requests stop after three retries. HTTP 400 responses are not retried. Stop aborts the request in progress.
- Recording stops automatically at the 10 minute limit.
