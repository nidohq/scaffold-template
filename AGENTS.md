# AGENTS.md

A Scaffold Stellar React app with Nido passkey smart accounts in the wallet
picker. Testnet only: hosted Nido runs on testnet, and so should you. Never use
mainnet or a key a person holds; generate throwaway testnet keys.

[`NIDO.md`](NIDO.md) is the same material for people, with more explanation:
read it for the relayer failure modes and the patterns. This file and NIDO.md
must agree; `scripts/docs.test.ts` checks the commands and the call pattern.

## Commands

```sh
npm run tools:scaffold     # stellar-scaffold into .tools/bin (prebuilt, seconds; nothing global)
npm ci                     # npm 11 prints allow-scripts warnings; they are harmless
npm run doctor             # preflight; `npm run doctor -- --json` for a machine-readable report
npm run deploy:testnet     # build, deploy to testnet (network testnet-dev), pin IDs under `testnet:`, write clients
npm run clients:testnet    # write clients for the IDs under `testnet:` in scaffold.yml (no deploy)
npm run dev                # stellar scaffold watch + Vite on PORT from .env (strictPort)
npm run build              # tsc -b && vite build
npm run lint
npm run test:unit          # vitest: app-lib, scripts, vendor
npm run prepare:prototype  # offline clients with a placeholder ID (no deploy, no keys)
npm run test:e2e           # Playwright against the real app; wallet pages and RPC are mocked
npm run test-browser       # throwaway Chrome + virtual passkeys for a real Nido account
npm run stellar -- keys ls # the stellar CLI with this project's tools and keys
npm run new-app -- ../x --blank   # (template checkout only) start a new app; --name, --port
```

Requires Node 22.12+, Rust from `rust-toolchain.toml` with `wasm32v1-none`, the
`stellar` CLI, and `stellar-scaffold` 0.0.30 or newer. Every npm script runs
`stellar` through `scripts/stellar.mjs`: `.tools/bin` first on PATH, and
`STELLAR_CONFIG_HOME=.stellar-config`, so identities and aliases are per project
(the deployer is `<app>-deployer`). Older Scaffold ignores `scaffold.yml` v2
without an error (it compiles and writes no clients), so the wrapper refuses it;
`npm run tools:scaffold` fixes that.

## Layout

- `contracts/<crate>` — Soroban contracts (Cargo workspace).
- `scaffold.yml` — which contracts deploy to which network. `local` and
  `testnet-dev` deploy from the workspace; `testnet` points at fixed IDs, which
  `deploy:testnet` writes for you.
- `app-lib/clients/` — generated, gitignored. Import clients from
  `@stellar-scaffold/app-lib/clients`; never edit them.
- `app-lib/` — the wallet layer: `wallet.ts` (kit, `submitCall`,
  `submitContract`, balances), `nido.ts` (Nido popup path), `session.ts`
  (session passkeys, coverage, `describe`).
- `app/src/` — React UI. `components/SessionGate.tsx` asks a Nido account for a
  session; `components/GuessTheNumber.tsx` (or `CheckIn.tsx` in a `--blank` app)
  is the reference call site.
- `scripts/` — the tooling above; `webauthn-sidecar.mjs` arms virtual passkeys.
- `vendor/nido-wallet/` — the Nido Wallets Kit module, vendored (see its README
  for the diff from upstream).

## Adding a contract

1. Create `contracts/<crate>` with `crate-type = ["cdylib"]`; `require_auth()`
   on the user first in each function a user calls.
2. Assert `env.auths()` in a unit test: the contracts in it are the grants a
   Nido account needs (see `contracts/check-in/src/test.rs` in a `--blank` app).
3. List it in `scaffold.yml` under `contracts:` with `local` and `testnet-dev`
   entries (`type: workspace`, `source: <package name>`, constructor `args`).
4. `npm run deploy:testnet`. It pins the new ID under `testnet:` (what
   `npm run dev` uses) and the client appears as a camelCase export of
   `@stellar-scaffold/app-lib/clients`. A redeploy changes the ID, and gates ask
   again because the old session doesn't cover it.
5. Call it with the pattern below, inside a `SessionGate`.

Build contracts through Scaffold. Plain `stellar contract build` compiles for
the local network: `stellar_registry::import_asset!("xlm")` bakes the network's
XLM contract ID in at compile time, so a local build deployed to testnet fails
with `Error(Context, InvalidAction)`. Recover with
`cargo clean -p <crate> --target wasm32v1-none --release`, then deploy again.
`prepare:prototype` builds into `target/prototype` to stay out of the way.

## Calling a contract from React

```tsx
// One grant per contract the call authorizes for the user
const grants: Grant[] = [
	{
		target: myContract.options.contractId,
		functions: ["my_fn"],
		duration: "24h",
		label: "my-app",
	},
]

export const MyAction = () => {
	const { address } = useWallet()
	const [message, setMessage] = useState<string>()
	const onClick = async () => {
		if (!address) return
		try {
			// No await before submitCall: Nido's popup needs the click's gesture
			const { result, hash } = await submitCall(address, (publicKey) =>
				myContract.my_fn({ user: address }, { publicKey }),
			)
			setMessage(`Done: ${String(result)} in ${hash}`)
		} catch (error) {
			setMessage(describe(error, Errors)) // Errors: the generated client's table
		}
	}
	return (
		<SessionGate
			grants={grants}
			explain={<p>What the app may do, and how long</p>}
		>
			<button onClick={() => void onClick()}>Do it</button>
			{message && <p>{message}</p>}
		</SessionGate>
	)
}
```

- `submitCall` = `reserveSigningPopup` + `transactionSource` (a C-address can't
  be a transaction source) + `submitContract` + release. It always resolves
  `{ result, hash }`: G-address via the wallet, C-address via the app's session
  passkey (one device prompt, submitted by Nido's relayer), otherwise Nido's
  popup. Its third argument `{ onStage }` reports `preparing`,
  `passkey`/`wallet`, `sending`, `confirming`; show them with `Pending` and
  `stageText` (`app/src/components/Pending.tsx`), cleared in a `finally`. Use
  `onSubmit`, not a form `action` (React defers an action's state updates).
- `SessionGate` compares `grants` with what the account approved
  (`sessionStatus`/`sessionCovers`: target, functions, cap, expiry) and shows
  make-passkey / ask / renew / waiting states; `actionsOnly` keeps children
  visible but disabled. Several gates share one passkey; each asks only for what
  it lacks, all of it in one Nido popup and one confirmation.
- `describe(error, contractErrors)`: #3221 over the cap, #3002/#3016 no rule or
  expired, #3014 an uncovered contract in the tree, Nido relayer codes, and your
  contract's `Error(Contract, #n)`.
- `isOverCap(error)`: the #3221 refusal, for a message that names your cap. A
  call over a cap stops before the passkey prompt (`CapReachedError`, `until`);
  `capReachedUntil(address, grants)` says until when, to keep a button off.
- Rules are picked per call by contract and function (from the account's
  `document()`), preferring this app's grant labels over other rules on the same
  contract.
- `isSmartAccount(address)` tells a C-address from a G-address.

## Smart accounts (C-addresses): what works

Nido accounts are Perch smart accounts. Their passkey signs under the "admin"
rule, which only covers calls on the account itself. **Nido's sign popup cannot
authorize a call into your contract** (the account answers #3002 for one
contract, #3014 for several). An app acts for a Nido account through a session.

- One `Grant` per contract the account authorizes in the call: the root call,
  plus every sub-call that needs the same account's `require_auth` (e.g. a token
  `transfer` from the user). The owner approves all of them at once in Nido's
  popup (`grant.<i>.*` on `/security/delegate-doc/`), with one passkey
  confirmation.
- `limit` caps cumulative `transfer(from, to, amount)` amounts and only works on
  a grant whose `target` is that token contract (`xlmTokenId` for XLM). A grant
  without `limit` is sent as `limit=none`; Nido asks the owner to accept "no
  cap" unless its `functions` move no tokens.
- `label` ≤ 20 bytes; asking again with the same label replaces that rule.
  `duration` is `24h`, `7d` or `30d`, shared by the grants of one request.
- The session signer is a second passkey the device makes for the app on its own
  origin (`createAppPasskey`), named in the rules as an `External` signer. The
  browser keeps only its public key and credential id: nothing there can spend.
  Each session call asks the device once and goes through Nido's relayer, which
  pays the fee. Origins include the port, so a moved dev server has no session:
  keep `PORT` fixed. Browsers refuse passkeys on an IP, so open the app at
  `localhost`, not `127.0.0.1`.
- Keep `from.require_auth()` at the top of the function that moves the user's
  tokens, and ask for one grant per contract. Skipping it to rely on the token's
  own check makes the auth non-root, and simulation (recording mode, which
  generated clients use) refuses that: "authorization not tied to the root
  contract invocation".
- Nido's Revoke does not work yet; grants end at their expiry.

## When Nido's relayer refuses

Account creation and grants go through Nido's relayer, which has one shared
testnet budget (100 XLM a day; a first grant bids about 4.5 XLM, a capped one
about 2.7). Session calls go through it too. Its grant page shows "We couldn't
confirm what happened…" for a 429 `FEE_LIMIT_EXCEEDED` (nothing sent), a 503
`POOL_CAPACITY` (nothing sent) and a 504 (may have landed). Recover from the
app, not by retrying blindly: the gate's **Check again** reads `installed_rules`
and records any grant that landed; **Ask Nido again** reuses the passkey.
`delegation=error&code=…` becomes a sentence; when the popup was blocked and the
page went to Nido, `resumeSession` reads the answer on return.

## Testing with a real Nido account

Mocks (`npm run test:e2e`) do not prove the chain accepts anything. For the real
flow without a person, run `npm run test-browser` (keep it running): it launches
a throwaway Chrome on a free port with a `target/` profile, arms every tab and
popup with virtual passkeys saved in `target/nido-passkeys.json`, and writes
`target/test-browser.env` (`CHROME_DEVTOOLS_AXI_BROWSER_URL`,
`CHROME_DEVTOOLS_AXI_SESSION`). Load it (`set -a; . target/test-browser.env`)
and drive the browser, for example with chrome-devtools-axi. Create the account
at https://test.nido.fyi; it arrives funded with 5 test XLM.

chrome-devtools-axi notes: refs go stale after any re-render, so take a fresh
snapshot right before each click; `fill` may not update a React-controlled
input, so click and `type` instead; the Wallets Kit modal has unnamed buttons
(click the "Nido" item with `eval`); "Session closed" after Nido's popup
approves is the popup closing, not a failure.

## Gotchas

- After changing dependencies under a running dev server, restart Vite with
  `--force` (stale optimized deps give 504 "Outdated Optimize Dep").
- If TypeScript reports two incompatible `AssembledTransaction` types, run
  `npm run link-clients`: a fresh client brought its own SDK install.
- "An identity with the name … already exists" on every build is harmless.
- Testnet resets wipe deployments; `npm run deploy:testnet` again.
