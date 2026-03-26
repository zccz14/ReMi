# OpenCode Takeover Demo

Experimental single-session polling demo.

## What it does

- polls one OpenCode session
- waits until the tail message is a completed `assistant` turn
- mirrors the recent window with `user` / `assistant` swapped
- sends the mirrored window to your avatar API
- writes the avatar's full reply back as the next OpenCode `user` prompt

## Limits

- single session only
- polling only, no SSE
- in-memory anchor tracking only
- no permission handling
- assumes you have already manually verified the write API behavior

## Required flags

- `--session-id=<id>`
- `--write-api-confirmed=true`
- `--avatar-base-url=<url>`
- `--avatar-model=<model>`

## Optional flags

- `--avatar-api-key=<token>`
- `--opencode-base-url=http://localhost:4096`
- `--poll-ms=2000`
- `--window-size=8`

## Start

```bash
npm run start --workspace @remi/opencode-takeover -- \
  --session-id=ses_xxx \
  --write-api-confirmed=true \
  --avatar-base-url=http://localhost:3001 \
  --avatar-model=ReMi-your-pubkey \
  --avatar-api-key=sk-xxxx
```

If your avatar endpoint does not need auth, omit `--avatar-api-key`.

## Important

`--write-api-confirmed=true` is mandatory. It means you have already manually verified that posting to the configured OpenCode message endpoint really triggers a new agent turn for your local OpenCode instance.
