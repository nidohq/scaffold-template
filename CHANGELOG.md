# Changelog

## Unreleased

### Passkey sessions: one approval, then one device prompt per call

Needs Nido with nidohq/nido#318 (several grants per request, a passkey signer,
`to=`), which test.nido.fyi runs.

- **The session signer is a second passkey** the device makes for the app on its
  own origin (`createAppPasskey`), in place of an ed25519 key in `localStorage`.
  The browser keeps only its public key and credential id, so nothing there can
  spend, and the owner's Nido passkey is never used to play. The rules name it
  as an `External` signer, checked by the account's WebAuthn verifier.
- **One approval.** `SessionGate` makes the passkey on first use, then opens
  Nido's grant page in a popup with every grant the screen needs (`grant.<i>.*`,
  `pubkey=`); the owner confirms once and the popup posts the answer back. A
  blocked popup falls back to the page going to Nido, and `resumeAppSession`
  reads the answer on return. Uncapped grants are sent as `limit=none`, and caps
  arrive filled in.
- **One device prompt per call.** The passkey signs the account's auth entry in
  the account's digest scheme (`addr_oz_v1`, or `oz_rule_ids` for older
  accounts); the account checks the signature, rules and cap in a simulation;
  Nido's relayer submits and pays the fee (`PUBLIC_NIDO_RELAYER`, default
  `https://nido.fly.dev`).
- **Pays only the game.** A `Grant` can name `to`, the only address its
  `transfer` may pay (`grant.<i>.to`, an `address-eq` on argument 1, shown by
  Nido as "Pays to"). Guess the Number's XLM grant names the game, so the
  passkey can't send its 2 XLM a day anywhere else.
- **The right rule for each call**, by contract and function, read from the
  account's policy document (`document()`), preferring this app's own grants
  over other rules on the same contract.
- **A spent cap is said before the prompt.** The app reads a capped rule's
  spending record and refuses a call that would go over (`CapReachedError`, with
  `until`); `capReachedUntil(address, grants)` remembers it, and Guess the
  Number shows "Cap reached until ≈ …" with Submit off. Re-approving keeps the
  rule's spending record, so renewing doesn't refresh a cap.
- **A call says what it waits for.** `submitCall`/`submitContract` take
  `{ onStage }` (`preparing`, `passkey` or `wallet`, `sending`, `confirming`);
  the `Pending` component shows it with a spinner in a live region. Guess the
  Number and the `--blank` check-in lock their form while a call runs, and
  `SessionGate` does the same while it makes the passkey, waits for Nido and
  checks the chain. The guess form is a submit handler, not a React form
  `action` (which holds state updates until it ends).
- **Removed:** Friendbot funding of a session key, CAP-0071 delegate signing and
  `delegation=signed`. Sessions stored by an earlier version are dropped and
  asked for again.
- The PG Atlas SBOM workflow checks that the repository's dependency graph is on
  and skips with a notice when it isn't, instead of failing on every push.

### Guess the Number shows the spending cap

- The sample's XLM grant caps spending at 2 XLM a day (was 3), so two wrong
  guesses go through without a prompt and the account refuses the third. The
  cap's `day` matches the session's `24h`, so it is also the most one approval
  can spend.
- The gate and the result say what a guess costs, and a refused guess says which
  cap stopped it and that it cost nothing, instead of the generic refusal.
- `isOverCap(error)` in app-lib recognises the #3221 refusal, before or after
  `describe` has explained it, and a test covers the over-cap guess.

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
