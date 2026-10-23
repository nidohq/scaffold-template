# Nido React template

A Scaffold Stellar React app with Nido passkey smart accounts in the wallet
picker, and the sessions a smart account needs to use your contracts: a second
passkey, made by the app, that the owner allows to make a few calls for a while.
This is the guide for people. Coding agents read [`AGENTS.md`](AGENTS.md), which
states the same rules in fewer words.

Everything runs on testnet: hosted Nido is testnet-only. Use throwaway testnet
keys only, never mainnet or a key a person holds.

## Quick start

You need Node 22.12+, Rust with the `wasm32v1-none` target
(`rustup target add wasm32v1-none`), and the
[Stellar CLI](https://developers.stellar.org/docs/tools/cli/install-cli). The
project installs its own Scaffold.

Start your own app from GitHub (in an app you already have, start at
`npm run tools:scaffold`):

```sh
stellar scaffold init --template nidohq/scaffold-template my-app
cd my-app
npm run tools:scaffold     # stellar-scaffold for this project, in .tools/ (seconds)
npm ci                     # npm 11 prints allow-scripts warnings; they are harmless
npm run doctor             # tools, testnet, keys and clients, with fixes
npm run clients:testnet    # client for the shared Guess the Number deployment
npm run dev                # the URL it prints
```

From a checkout of the template, `new-app` does the same with your local
changes, and `--blank` swaps the sample for a one-function starter contract:

```sh
npm run new-app -- ../my-app --blank
cd ../my-app
npm run tools:scaffold && npm ci && npm run doctor
npm run deploy:testnet     # deploys contracts/check-in, pins its ID, writes its client
npm run dev                # on the app's own port
```

Without `--blank`, the copy keeps the Guess the Number sample; run
`npm run clients:testnet` instead of `deploy:testnet` to use its shared
deployment. To try the sample in the checkout itself, run the same commands from
`tools:scaffold` on, after `cp .env.example .env`.

Then open the app at `http://localhost:<PORT>` (passkeys need a host name, so
not `127.0.0.1`), press Connect and choose Nido. Without a Nido account yet,
create one at https://test.nido.fyi: one passkey, and it arrives with 5 test
XLM. Back in the app, your device makes a passkey for the app, and Nido asks you
once, in a popup, to approve what that passkey may do. After that, each call
asks your device for the app's passkey and nothing else: no Nido page.

In the sample, each wrong guess sends 1 XLM to the game. The session you approve
lets the game's passkey call `guess` and spend up to 2 XLM a day from your
account, so two wrong guesses go through (one device prompt each) and your
account refuses the third before anything is sent. The app says so and the guess
costs nothing.

`new-app` gives the copy its own package name, page title, deployer identity
(`<name>-deployer`) and dev-server port, so several apps on one machine don't
collide. Pass `--name` when the folder name isn't the app name.

### What each command touches

| Command                   | Does                                                                                                                                         | Deploys  | Spends or writes keys                                               |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------- |
| `npm run tools:scaffold`  | Downloads the tested `stellar-scaffold` into `.tools/bin`                                                                                    | No       | No                                                                  |
| `npm run doctor`          | Checks tools, `.env`, pins, clients, deployer, testnet RPC, Nido, the port; `-- --json` for scripts                                          | No       | No (reads only)                                                     |
| `npm run clients:testnet` | Compiles the contracts and writes clients for the IDs under `testnet:` in `scaffold.yml`                                                     | No       | Creates the deployer key and has Friendbot fund it, on first run    |
| `npm run deploy:testnet`  | Compiles, deploys new or changed contracts (network `testnet-dev`), runs `after-deploy` calls, pins the IDs under `testnet:`, writes clients | Yes      | The deployer pays the fees (Friendbot XLM); creates it on first run |
| `npm run dev`             | `stellar scaffold watch` for the network in `.env`, plus Vite on `PORT`                                                                      | No       | Creates the deployer on first run                                   |
| `npm run test-browser`    | A throwaway Chrome with virtual passkeys, for automating a real Nido account                                                                 | No       | Saves throwaway passkeys in `target/`                               |
| `npm run stellar -- …`    | The `stellar` CLI with this project's tools and keys, e.g. `npm run stellar -- keys ls`                                                      | If asked | If asked                                                            |

Keys and contract aliases live in `.stellar-config/` (gitignored), not in your
global `~/.config/stellar`. The deployer is a throwaway testnet key; nothing
else holds it.

## Your own contract in five steps

1. **Write it.** A crate in `contracts/<name>` with `crate-type = ["cdylib"]`
   (or grow the `--blank` starter, `contracts/check-in`). In each function a
   user calls, `user.require_auth()` comes first.
2. **Find its grants.** A Nido account approves one grant per contract it
   authorizes in a call: the root call, plus every sub-call that needs the same
   account, such as a token `transfer` from the user. Assert `env.auths()` in a
   unit test: the contracts in that list are your grants
   (`contracts/check-in/src/test.rs` does this).
3. **List it in `scaffold.yml`** under `contracts:`, with `local` and
   `testnet-dev` entries: `type: workspace`, `source: <package name>`, and the
   constructor `args`.
4. **Deploy it:** `npm run deploy:testnet`. It deploys to testnet, pins the new
   ID under `testnet:` (the network `npm run dev` uses), and writes the client,
   a camelCase export of `@stellar-scaffold/app-lib/clients`. A redeploy gets a
   new ID; sessions approved for the old one no longer cover it, and the app
   asks again.
5. **Call it from React** with the pattern below, inside a `SessionGate` that
   asks for the grants from step 2.

Build contracts through Scaffold. A plain `stellar contract build` compiles for
the local network, and `stellar_registry::import_asset!("xlm")` bakes that
network's XLM contract in at compile time: deployed to testnet, it fails with
`Error(Context, InvalidAction)`. To recover, run
`cargo clean -p <crate> --target wasm32v1-none --release` and deploy again.

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

Everything here comes from `@stellar-scaffold/app-lib` (the template's
`app-lib/`), except `SessionGate` (`app/src/components/`) and your client.
`components/GuessTheNumber.tsx` is the full sample; `--blank` apps have
`components/CheckIn.tsx`.

- `submitCall(address, build)` is the call site in one step. It reserves Nido's
  popup during the click, builds the call with a transaction source a C-address
  can use, submits it, and resolves with `{ result, hash }` once confirmed:
  through the connected wallet for a G-address, signed by this app's passkey
  (one device prompt) and submitted by Nido's relayer for a Nido account with a
  session, otherwise through Nido's popup. The parts are exported too, for your
  own flow: `reserveSigningPopup`, `transactionSource`, `submitContract`.
- A call takes several seconds, so say what it waits for: pass
  `{ onStage: setStage }` as `submitCall`'s third argument and render
  `<Pending>{stageText[stage]}</Pending>` (`app/src/components/Pending.tsx`)
  while `stage` is set: "Preparing…", "Waiting for your passkey…" (or "…your
  wallet…"), "Sending…", "Confirming on Stellar…", announced to screen readers.
  Clear it in a `finally`, and lock the inputs meanwhile. Use a submit handler,
  not a form `action`: React holds an action's state updates until it ends.
- `SessionGate` shows its children to classic wallets, and to a Nido account
  once its approvals cover `grants`. Until then it explains what will be asked,
  has the device make the app's passkey on first use, and opens Nido's page in a
  popup for every grant still missing or expired, approved with one
  confirmation. With `actionsOnly`, the children stay visible and only their
  buttons and inputs wait.
- `describe(error, contractErrors)` turns failures into sentences: the account's
  refusals (#3221 over the cap; #3002 or #3016 no rule covers the call, or it
  expired; #3014 a contract in the call has no rule), Nido's relayer codes, and
  your contract's `Error(Contract, #n)` looked up in `contractErrors` (the
  generated client's `Errors`, or your own table).
- `isOverCap(error)` is true when the account refused a call for going over a
  grant's cap (#3221), so you can say what the cap was and when to come back.
  The account checks during simulation, after the device signed, so nothing was
  sent or paid.
- `isSmartAccount(address)` tells a Nido C-address from a classic G-address, for
  example to link `/contract/` rather than `/account/` on an explorer.

## How a Nido account authorizes your app

A Nido account is a Perch smart account. Its passkey signs under rule 0,
"admin", which covers only calls on the account itself. **Nido's sign popup
cannot authorize a call into your contract**: the account refuses with `#3002`
(one contract) or `#3014` (several). Your app acts for the account through a
**session** instead (`app-lib/session.ts`), and the session's signer is a second
passkey:

1. The device makes a passkey for the app, on the app's own origin
   (`createAppPasskey`). The app keeps its public key and credential id; the
   private key never leaves the device.
2. The owner opens `https://<account>.test.nido.fyi/security/delegate-doc/` in a
   popup, with every grant the screen needs and the app's public key
   (`pubkey=`). Nido shows each rule, the owner confirms once with their own
   passkey, and Nido applies the updated policy document (`apply_doc`) through
   its relayer. The rules name the app's passkey as an `External` signer,
   checked by the same WebAuthn verifier as the owner's.
3. For each later call the app asks the device to sign the account's auth entry
   with its passkey (one prompt), naming the approved rule for each contract.
   The account checks the signature, the rules and the cap in a simulation, then
   Nido's relayer submits the call and pays the fee.

The rules that follow from it:

- **One grant per contract in the call's authorization tree**, and
  `require_auth()` at the root. Relying on a token's own check instead makes the
  authorization non-root, and simulation refuses it: "authorization not tied to
  the root contract invocation".
- **`limit` caps cumulative `transfer` amounts**, and only on a grant whose
  `target` is that token (`xlmTokenId` for XLM). The app sends a grant without a
  cap as `limit=none`; Nido takes that without asking when the grant's
  `functions` move no tokens (like `guess`), and otherwise asks the owner to
  choose a cap or accept "no cap" explicitly.
- **`label`** is the rule's name, at most 20 bytes. Asking again with the same
  label replaces that rule, which is how the app renews an expired one.
  `duration` is `24h`, `7d` or `30d`, and the grants in one request share it.
- **Nothing in the browser can spend.** The app's passkey lives in the device's
  authenticator; `localStorage` holds only its public key, its credential id and
  what was asked. Every call needs the device to agree, and the account allows
  at most what the rules do. Whoever controls the page can still prompt the
  device, so the cap still bounds what one approval can cost.
- **One prompt per call.** That is the price of keeping no key in the browser:
  each session call shows the device's passkey prompt, even one the account then
  refuses for the cap.
- **Origins include the port, and passkeys need a host name.** Sessions are
  stored per origin, so each app has a fixed `PORT` with `strictPort`, and you
  open it at `localhost`: browsers refuse passkeys on an IP address such as
  `127.0.0.1`.
- **Revoking doesn't work in Nido yet**, so grants end at their expiry. "Forget
  it" makes this browser forget the app's passkey (the device may still list
  it); approving again makes a new passkey and replaces the rules, so the old
  one stops working.
- **Nido's relayer submits session calls** and pays their fees out of its shared
  budget, as it does for account creation and grants.

Some patterns that work:

- **An action that moves no money** (claim, vote, check in): one grant on your
  contract, no cap. The `--blank` starter is this.
- **A capped payment** (tip, buy): two grants, your contract plus the token with
  a `limit`, approved together. Guess the Number is this: 1 XLM a wrong guess,
  capped at 2 XLM a day. Its `period` matches the grant's 24-hour `duration`, so
  the cap is also the most one approval can spend.
- **Shared funds** (a group pot): your contract holds the money and pays out
  when enough members approve; each member uses their own Nido account.
- **Limits for someone else** (an allowance): a cap limits a key, not the
  account's admin. Keep custody in a contract the limited person doesn't
  administer.
- **Time locks**: a rule's expiry stops a key; it doesn't delay a withdrawal.
  Put unlock dates in your contract.

## When Nido's relayer says no

Nido's relayer pays for creating accounts, applying grants and submitting
session calls, out of one budget shared by everyone on testnet (100 XLM a day,
counted by the fee bid). Measured on 2026-10-22: an account costs about 1.4 XLM,
a first grant about 4.5 XLM (it writes the policy document), a capped grant
about 2.7 XLM. On 2026-10-23 a guess cost 0.56 XLM the first time (the cap's
first write) and 0.035 XLM after that.

When the budget runs out, or the relayer is busy or slow, Nido's grant page
currently says "We couldn't confirm what happened to this transaction on-chain…
retrying could pay twice" in every case, though they differ:

| What happened                          | Relayer answer           | Landed?   |
| -------------------------------------- | ------------------------ | --------- |
| The shared budget is used up           | 429 `FEE_LIMIT_EXCEEDED` | No        |
| The relayer is busy                    | 503 `POOL_CAPACITY`      | No        |
| The relayer timed out after submitting | 504                      | Sometimes |

What to do:

1. **Close Nido's window**, or let it report the error back. The gate says Nido
   hasn't confirmed the grants.
2. **Check again.** The app reads your account's rules on chain. If the grants
   landed, the session is ready.
3. If nothing landed, **Ask Nido again**. It reuses the app's passkey, and
   asking again can't pay twice for a grant that isn't there. If the budget is
   used up, wait and try later.

A session call the relayer refuses (`FEE_LIMIT_EXCEEDED`, `POOL_CAPACITY`) was
not sent; the app says so. When the browser blocks Nido's popup, the page goes
to Nido instead, and `resumeAppSession` reads `?delegation=…` on the way back.

By hand, the rules are one command away:
`npm run stellar -- contract invoke --id <your C-address> --network testnet --send=no -- installed_rules`.

## Testing

```sh
npm run test:unit           # app-lib session logic, new-app, vendor module
npm run prepare:prototype   # offline clients with a placeholder ID: no deploy, no keys
npm run test:e2e            # Playwright against the real app; wallet pages and RPC mocked
```

The browser tests run the real React app, wallet picker, Nido popup transport,
session requests, a virtual authenticator's passkey and the WebAuthn signature
it makes, the generated client and RPC parser, with Nido's pages, its relayer
and the RPC mocked. They prove the app's side of each exchange, not that the
chain accepts it. Don't sign against a prototype client's placeholder contract
ID.

For the real thing without a person, `npm run test-browser` starts a throwaway
Chrome whose every tab and popup has a virtual passkey (the app's passkey is a
virtual one too), and prints the settings for a browser driver such as
chrome-devtools-axi. Create the account at https://test.nido.fyi in that
browser. To try a Nido preview, set `PUBLIC_NIDO_BASE` in `app/.env`, e.g.
`https://318.test.nido.fyi`.

### Verified live on testnet

With a Nido account created in an automated browser with throwaway virtual
passkeys (`npm run test-browser`), against Nido's preview of grant requests with
several grants and a passkey signer
(`PUBLIC_NIDO_BASE=https://318.test.nido.fyi`):

| Check (2026-10-23)                | Result                                                                                                                        |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Create a Nido account             | Deployed and funded with 5 XLM by Nido's relayer                                                                              |
| Connect through the wallet picker | C-address and its 5 XLM balance in the header                                                                                 |
| Make the app's passkey            | One device prompt; `localStorage` holds its public key and credential id only                                                 |
| Approve the session               | One popup, both rules and the 2 XLM/day cap already filled in, one confirmation; `guess` and `guess-xlm` name the app passkey |
| Guess 1 and guess 2               | One device prompt each, no Nido page; submitted by Nido's relayer: 0.565 and 0.035 XLM in fees, paid by the relayer           |
| Guess 3                           | Refused by the account: `#3221` (`SpendingLimitExceeded`); nothing sent, balance unchanged at 3 XLM                           |

Guesses `a5966b61fe9f47b804ddeeece967674c576e3c6c3834914e9532e86e4e13ce97` and
`f912bd60e709c099203dea8aa4ffb485cda85111792a31c973fbeeef8d64452a`.

## Troubleshooting

- **`npm warn allow-scripts`** lines during `npm ci`: harmless; nothing in the
  template needs those install scripts.
- **"An identity with the name … already exists"**: harmless; Scaffold checks
  for the deployer on every build.
- **Port in use** when `npm run dev` starts: another process holds this app's
  `PORT`. Stop it, or set another `PORT` in `.env` and approve the session again
  on the new origin.
- **Two incompatible `AssembledTransaction` types** in TypeScript: a fresh
  client brought its own SDK; run `npm run link-clients`.
- **504 "Outdated Optimize Dep"** after changing dependencies: restart Vite with
  `--force`.
- **Contracts gone after a testnet reset**: `npm run deploy:testnet` again.

## Reference

- `vendor/nido-wallet` carries the Nido Wallets Kit module from nidohq/nido
  `3e3f350`, which handles `nido_submitted` responses, plus the small changes
  listed in its README, including `reserveCeremonyPopup`. Replace it with a
  reviewed public release when one exists.
- Session calls are signed in the account's own digest scheme
  (`capabilities().auth_digest`: `addr_oz_v1` binds the account's address, older
  accounts report `oz_rule_ids`); the unit tests pin it to Perch's auth vectors.
  `npm run link-clients` keeps generated clients on app-lib's copy of
  `@stellar/stellar-sdk`.
- Session calls go to Nido's relayer at `https://nido.fly.dev`; set
  `PUBLIC_NIDO_RELAYER` in `app/.env` for another. The grant request leaves out
  `credential_id`: Perch's document compiler refuses a WebAuthn key with the id
  appended (`#7`, `KeyNotCanonicalizable`).
- Nido's `ADD-NIDO-TO-DAPP.md` and module README still say the dApp submits the
  signed XDR; for transactions the wallet now submits and returns a hash, which
  the app must not broadcast again.
- The adapter reports a configured passphrase; it can't discover the
  deployment's actual network, so Nido is registered only on testnet. Other
  networks keep the default wallet list. Friendbot creates classic accounts; the
  Fund button is hidden for C-addresses.
- This layout derives from the official React template at
  `stellar-scaffold/ui@505354435c43e8d7af19c84bcb198990e36f983b`, already in its
  final `app/`, `app-lib/`, `contracts/` shape.
