# dsh-balance

**English** · [简体中文](./README.md)

A balance & usage plugin for [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) (`dsh web` / the macOS desktop wrapper): a balance chip in the sidebar footer, a click popup with today's per-model consumption, and a **余额配置** settings section (platform `userToken` + auto-refresh interval).

> Tested against `@deepseek-ai/dsh@0.1.2-rc.1` and `0.1.5-rc.1` (MIT). dsh is
> pre-1.0 — its plugin internals may change between releases; pin the engine
> version you run. To use the new `deepseek-flash` model, run `0.1.5-rc.1`
> (its built-in model catalog already includes it).

![dsh-balance preview](./assets/preview.png)

## Features

- **Balance chip** (sidebar footer, bottom-left): always shows the latest **official** balance from `api.deepseek.com/user/balance` (authenticated with your normal `DEEPSEEK_API_KEY` — the endpoint is free, recalibration never spends model credits).
- **Click popup**: today's per-model consumption (tokens & ¥), 上次校准 time, 刷新数据, and a 充值 link.
- **Model-agnostic**: the popup lists **whatever models the platform reports**, so upstream renames or additions (e.g. `deepseek-flash`) need no plugin update; known models come first, the rest follow by spend.
- **设置 → 余额配置**:
  - **DeepSeek 开放平台登录 Token** — paste your platform `userToken` to enable today's per-model data (read on the platform web console, see below). Stored only in the local credentials store (`~/.dsh`).
  - **刷新间隔** — 30 s / 60 s (default) / 120 s / custom (1–86400 s). Controls the chip auto-calibration cadence:
    - refresh immediately on first page load (always),
    - refresh every *N* seconds while the page is open,
    - catch-up refresh when returning to the foreground if the last refresh was ≥ *N* s ago,
    - 刷新数据 refreshes immediately (always).
  - The interval is saved **server-side next to the token** in the same `~/.dsh` credentials store, so it survives restarts and port changes.

## Install (for regular dsh web users)

Requirements: Node.js + `pnpm` on `PATH`, and dsh initialized once.

```bash
# 1) init ~/.dsh with the pinned engine (only needed the first time)
npx @deepseek-ai/dsh@0.1.5-rc.1 web --no-open
# stop it (Ctrl+C)

# 2) install the plugin into the web profile (pin a release tag / commit;
#    git-hosted packages are fetched by pnpm)
dsh plugin --profile web add github:ryyyzer/dsh-balance#v0.1.1

# 3) start the GUI again and hard-refresh the page
npx @deepseek-ai/dsh@0.1.5-rc.1 web
```

The package declares `dsh.bundle.patch`, so the `dsh plugin` command installs it
as a profile **bundle layer** and it self-registers (no manual `cordis.patch.yml`
editing). Uninstall: `dsh plugin --profile web remove dsh-balance`.

First run: open 设置 → models and fill in your DeepSeek API key (the chip needs
it to show a balance). For the today-per-model rows, also configure the platform
token below.

## Getting the platform userToken (optional, for “today” data)

1. Log in to `platform.deepseek.com` in a browser.
2. Open DevTools (F12) → Console and run:

   ```js
   localStorage.getItem("userToken")
   ```

3. Paste the returned string into 设置 → 余额配置 → DeepSeek 开放平台登录 Token.

The token is only used to call the platform console's own usage-export endpoint
from your local machine and is stored in the local credentials store — it is
never uploaded anywhere by this plugin.

## Privacy & security notes

- API key and `userToken` never leave your machine; both live in `~/.dsh`
  credentials (the same store dsh itself uses).
- All `/dsh-balance/*` routes only accept loopback + same-origin requests
  (DNS-rebinding guard); this is not a substitute for auth against other
  processes on your own machine.
- The `userToken` is a **platform session credential**: treat it as sensitive
  (same as a password). Only paste it into the dsh GUI on a machine you trust.

## Caveats / disclaimer

- Today's per-model consumption comes from `platform.deepseek.com/api/v0/usage/export` — a **private, undocumented console endpoint** (zip of CSVs). It may change or break at any time, and calling it may violate platform terms of service. The official balance feature (`/user/balance`) has no such issue.
- The plugin relies on dsh internal injection points (`connection` / `credentials` / `webServer` host services and client slot modules `@deepseek-ai/dsh-client-ui-sidebar` / `-settings-general`). Verified on `0.1.2-rc.1` and `0.1.5-rc.1`; engine upgrades may still require small tweaks — pin the version you run.
- The model picker itself is driven by the engine's built-in catalog: e.g. `0.1.2-rc.1` only offers `deepseek-v4-flash` / `deepseek-v4-pro` / `deepseek-v4-flash-vision-exp`. Upgrade to `0.1.5-rc.1` to select the new `deepseek-flash`.

## Changelog

- **0.1.1** — per-model rows now follow whatever ids the platform reports (no hardcoded model list); added the `requestBody` field required by dsh `0.1.5-rc.1`'s `connection.fetch.register` (older engines ignore it); refresh interval is stored next to the token in the local credentials.
- **0.1.0** — first release: balance chip, today's per-model popup, 余额配置 (token + refresh interval).

## License

MIT. The data-interface approach (platform usage export + `userToken`) is
informed by [AzureHalcyon/dsh-deepseek-usage](https://github.com/AzureHalcyon/dsh-deepseek-usage)
(GPL-2.0); this is an independent implementation.
