# CLAUDE.md

The React frontend of this template. Project-wide commands, layout, and the
smart-account rules are in [`../AGENTS.md`](../AGENTS.md); read it first.

## Provider tree (`src/main.tsx`)

`NotificationProvider` → `QueryClientProvider` → `WalletProvider` →
`BrowserRouter`

- `src/providers/WalletProvider.tsx` subscribes to wallet state through
  `onWalletChange` from `@stellar-scaffold/app-lib` and records Nido's answer to
  a session request (`resumeAppSession`) on load. It exposes `address`,
  `balances`, `networkPassphrase`, `isPending`, `signTransaction`, and
  `updateBalances`; read them with `src/hooks/useWallet.ts`.
- Wallet primitives (kit setup, connect, `submitContract`, balances, session
  passkeys) live in `app-lib`, not here.

## Routes

- `/` — `src/pages/Home.tsx`
- `/debug`, `/debug/:contractName` — `src/pages/Debug.tsx`, the contract
  explorer for every generated client

## Contract clients

Generated into `../app-lib/clients/` by `stellar scaffold` (gitignored) and
imported from `@stellar-scaffold/app-lib/clients`. The network the app talks to
is the one the clients were generated for.

## Vite notes

- Only `PUBLIC_`-prefixed env vars reach the frontend.
- WASM via `vite-plugin-wasm`; `Buffer` via `vite-plugin-node-polyfills`.
- `@stellar/stellar-sdk` is deduplicated so generated clients and app-lib share
  XDR types.
- Local friendbot is proxied at `/friendbot` →
  `http://localhost:8000/friendbot`.

## Tests

Unit tests (`npm run test:unit`) cover `app-lib`; Playwright
(`npm run test:e2e`) runs this app with mocked wallet pages and RPC.
