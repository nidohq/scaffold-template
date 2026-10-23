# Changelog

## Unreleased

### The session signer is a passkey

- A session's signer is now a second passkey the device makes for the app, on
  the app's own origin, in place of an ed25519 key in `localStorage`. The
  browser keeps only its public key and credential id, so nothing there can
  spend, and the owner's Nido passkey is never used for play. The rules name it
  as an `External` signer, checked by the account's WebAuthn verifier.
- One approval: `SessionGate` makes the passkey on first use, then opens Nido's
  grant page in a popup with every grant the screen needs (`grant.<i>.*`,
  `pubkey=`). The owner confirms once, and the popup posts the answer back. A
  blocked popup falls back to the page going to Nido; `resumeAppSession` reads
  the answer on return. Uncapped grants are sent as `limit=none`, and the XLM
  cap arrives filled in, so the owner types nothing.
- Each session call asks the device once: the passkey signs the account's auth
  entry in the account's digest scheme (`addr_oz_v1`, or `oz_rule_ids` for older
  accounts), the account checks it, the rules and the cap in a simulation, and
  Nido's relayer submits it and pays the fee. An over-cap call is refused before
  it is sent.
- New in app-lib: `createAppPasskey`, `nidoRelayer` (`PUBLIC_NIDO_RELAYER`),
  `authDigest`, `webAuthnSigData`. `requestAppSession` resolves with Nido's
  answer; `resumeAppSession` is synchronous. `grantUrl` builds the account host
  with the module's `accountOrigin`, so a Nido preview base
  (`https://318.test.nido.fyi`) reaches `<account>--318.test.nido.fyi`.
- Removed: Friendbot funding of a session key, CAP-0071 delegate signing, and
  `delegation=signed` (there is no key in the browser to pay with). Sessions
  stored by an earlier version are dropped and asked for again.
- Verified on testnet against Nido's preview: one approval for both rules, two
  guesses with one device prompt each (fees 0.565 and 0.035 XLM, paid by Nido's
  relayer), the third refused by the 2 XLM/day cap.

### The right rule, and a spent cap said before the prompt

- The app picks the rule for each call by contract and function, reading the
  functions from the account's policy document (`document()`), and prefers a
  rule this app asked for over another rule on the same contract for the same
  passkey (another gate's, or one left from an earlier approval), which could
  charge the wrong cap. `authContexts` returns `{ contract, fn, args }`.
- Before the passkey prompt, the app reads a capped rule's spending record (the
  `spending_limit` policy's storage) and refuses a call that would go over:
  `CapReachedError` with `until`, the time the oldest spend ages out. The
  refusal is remembered per grant; `capReachedUntil(address, grants)` returns it
  until then. Guess the Number shows "Cap reached until ≈ …" and keeps Submit
  off, across reloads, instead of asking the device for a guess the account
  would refuse. Approving the grant again clears it.
- The last guess's result sits inside the `SessionGate`, so the renew screen no
  longer shows a stale refusal under it.

### A call says what it waits for

- From Submit to the result, Guess the Number locks the input and the button (a
  spinner and "Guessing…") and shows the stage in a live region: "Preparing…",
  "Waiting for your passkey…", "Sending…", "Confirming on Stellar…". The
  `--blank` check-in does the same. Before, nothing changed on screen for the 15
  to 20 seconds a guess takes: the form used a React `action`, which holds state
  updates until it ends, so "loading" never rendered.
- `SessionGate` shows a spinner and says what it waits for while it makes the
  app's passkey, waits for Nido's window (approve and renew) and checks the
  chain.
- `submitCall` and `submitContract` take `{ onStage }`; `submitWithSession`
  reports `passkey`, `sending` and `confirming`, and the Nido popup path
  `wallet` and `confirming`. New `Pending` component and `stageText`.

### Guess the Number shows the spending cap

- The sample's XLM grant caps spending at 2 XLM a day (was 3), so two wrong
  guesses go through without a prompt and the account refuses the third. The
  cap's `day` matches the session's `24h`, so it is also the most one approval
  can spend.
- The gate and the result say what a guess costs, and a refused guess says which
  cap stopped it and that it cost nothing, instead of the generic refusal.
- `isOverCap(error)` in app-lib recognises the #3221 refusal, before or after
  `describe` has explained it. The e2e mocks can refuse an enforced simulation
  (`refuse`), and a test covers the over-cap guess.

## v2 (2026-10-22): after the hackathon simulation

Each change names the action or finding it answers in the feedback report from a
simulated six-team hackathon run, Oct 2026 (top-10 action numbers; finding IDs
from §5.3).

### One human path (action 4: T-H3, T-H4, T-A5)

- `NIDO.md` is the guide for people: quick start, what each command deploys,
  funds or writes, your own contract in five steps (including the pin under
  `testnet:` and the `env.auths()` recipe, T-A8), the call pattern,
  `describe`/`isSmartAccount`, the rules, patterns, relayer failure modes with
  measured costs, troubleshooting (allow-scripts, the identity message, ports).
- `README.md` replaces the stock Scaffold README with a short front door;
  `CONTRIBUTING.md` replaces the monorepo text with how to work on this
  template.
- `AGENTS.md` keeps the same rules for agents. `scripts/docs.test.ts` fails when
  either doc names a missing npm script or their call patterns differ.
- `.env.example` no longer says "use testnet-dev"; `deploy:testnet` pins IDs
  under `testnet:` itself (`scripts/pin-testnet.mjs`), so `npm run dev` keeps
  your contract.

### Fast, isolated setup (action 6: T-H5, T-A7, T-A1, S-H1)

- `npm run tools:scaffold` installs the tested `stellar-scaffold` prebuilt
  (0.0.31) into `.tools/bin` in about a second; no global install, no 10 to 16
  minute compile.
- `scripts/stellar.mjs` runs every `stellar` call with `.tools/bin` first and
  `STELLAR_CONFIG_HOME=.stellar-config`; `npm run stellar -- …` for hands-on
  use. It replaces `dev-guard.mjs`.
- `npm run doctor` (and `-- --json`) checks Node, the Rust target, the CLIs and
  Scaffold version, `.env`, pins, clients, deployer funds, testnet RPC, Nido and
  the dev port, with a fix for each problem.
- `npm run test-browser` finds Chrome (system, `CHROME_PATH` or Playwright's
  Chrome for Testing), starts it on a free port with a `target/` profile and the
  passkey sidecar, persists passkeys, and writes `target/test-browser.env` for
  chrome-devtools-axi. AGENTS.md lists the axi workarounds (S-A1).

### Collision-free new-app (action 7: T-A2, T-A3, T-H6, T-H10)

- `--name`, a `<name>-deployer` identity, per-project keys and aliases, a fixed
  per-app `PORT` with `strictPort` (session keys are per origin), the page
  title, and a written `.env`.
- `--blank` replaces Guess the Number and the OpenZeppelin samples with a
  one-function `check-in` starter (contract, `env.auths()` test, gated screen)
  and fixes the lockfile, e2e and release workflow to match.
- Accepts an empty target directory, refuses one inside the template, prints the
  right next steps, and leaves template-only files out of the copy.
- `prepare:prototype` works for any app's testnet contracts and builds into
  `target/prototype`, so a local-network wasm can't reach a testnet deploy.
- Wallet e2e tests are separate from the sample's (`guess.spec.ts`), so a blank
  app's suite passes; screenshot tests are opt-in (`E2E_VISUAL=1`).

### A truthful SessionGate and submitContract (action 8: T-H1, T-H2, T-A4, T-H8, T-H9)

- `sessionCovers`/`sessionStatus` compare a gate's grants with the approvals
  (target, functions, cap, expiry): ask, renew, waiting or ready, instead of a
  count. Gates share one key and ask only for what they lack.
- "Approve with Nido" shows "Preparing a key for this app…" and can't be clicked
  twice; retries reuse the key, so no second Friendbot wait.
- `<SessionGate actionsOnly>` keeps the view visible; one `SessionNote` per page
  replaces the per-gate "Forget it".
- `submitContract` always returns `{ result, hash }`;
  `submitCall(address, build)` is the whole call site;
  `describe(error, contractErrors)` covers account refusals, relayer codes and
  the contract's own errors.

### Pay your own fee, template half (action 3: N-A2)

- `resumeSession` accepts `delegation=signed&payload=…` (query or fragment): the
  session key submits Nido's passkey-signed `{func, auth}` and pays the fee,
  after checking that it changes only the pending account. Also
  `delegation=error&code=…` (N-A1), which leaves the grant waiting with a
  sentence instead of dropping the key.
- "Check again" reads `installed_rules`, records a grant that landed behind a
  failed page (the 504 case) and drops approvals whose rule was replaced.

### Deferred

- Nido has to send `delegation=signed` and `delegation=error` (nido repo,
  actions 1 and 3); until then the gate's Check again / Ask Nido again is the
  recovery path.
- A read-only `clients:testnet` that skips compiling (T-A6): Scaffold builds the
  workspace either way; the side effects are documented instead.
- Bundle size and dependency advisories (T-H7); the `input { width: 100% }`
  style (T-H10).
