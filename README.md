# Scaffold Stellar + Nido passkey accounts

```sh
stellar scaffold init --template nidohq/scaffold-template my-app
```

A React app template for Stellar smart contracts where people sign in with a
passkey. [Nido](https://test.nido.fyi) smart accounts sit in the wallet picker
next to the usual wallets, and the template carries what a smart account needs
to use your contracts: a second passkey, made by the app, that the owner allows
once to make a few calls, the calls it signs, and the screens that ask. Built on
[Scaffold Stellar](https://github.com/stellar-scaffold/cli). Testnet only.

You need Node 22.12+, Rust with the `wasm32v1-none` target and the
[Stellar CLI](https://developers.stellar.org/docs/tools/cli/install-cli); the
project installs its own Scaffold. Then, in the new app:

```sh
npm run tools:scaffold && npm ci && npm run doctor
npm run clients:testnet && npm run dev
```

`npm run doctor` says what is missing and how to fix it. Open the app, connect
with Nido and approve the sample once: Guess the Number then plays with one
device passkey prompt per guess and no Nido page, at 1 XLM a wrong guess, until
the 2 XLM a day you allowed runs out.

- **Building an app?** Read [`NIDO.md`](NIDO.md): the quick start, your own
  contract in five steps, the call pattern, the rules a Nido account follows,
  and what to do when Nido's relayer says no.
- **A coding agent?** Read [`AGENTS.md`](AGENTS.md): the same rules, shorter.
- **Changing the template?** Read [`CONTRIBUTING.md`](CONTRIBUTING.md). From a
  checkout, `npm run new-app -- ../my-app --blank` starts an app from your local
  copy, with a one-function starter contract in place of the sample.

Nido is at <https://github.com/nidohq/nido>; the Perch policy language its
accounts enforce is at <https://github.com/stellar-registry/perch>. The "Stellar
smart accounts" talk built on this template lives at
<https://github.com/nidohq/smart-accounts-talk>.

The one secret key in the tree, in
[`.github/workflows/build.yml`](.github/workflows/build.yml), comes unchanged
from the public upstream
[stellar-scaffold/ui](https://github.com/stellar-scaffold/ui) workflow: it funds
a throwaway identity on the CI job's local quickstart network.

[License](LICENSE) · [Security](SECURITY.md) ·
[Code of conduct](CODE_OF_CONDUCT.md)
