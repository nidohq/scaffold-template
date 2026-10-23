import {
	KitEventType,
	type Networks,
	StellarWalletsKit,
} from "@creit.tech/stellar-wallets-kit"
import { defaultModules } from "@creit.tech/stellar-wallets-kit/modules/utils"
import { Asset, Keypair, rpc, xdr, type contract } from "@stellar/stellar-sdk"
import {
	ACCOUNT_SWITCH_REQUESTED,
	NIDO_ID,
	reserveCeremonyPopup,
} from "@nidohq/stellar-wallets-kit-module"
import {
	NIDO_BASE,
	NIDO_RELAYER,
	createNidoModules,
	isSmartAccount,
	smartAccountBalance,
	submitSmartAccount,
	transactionSource,
} from "./nido"
import { allowHttp, networkPassphrase, rpcUrl, stellarNetwork } from "./env"
import {
	activeSession,
	checkSession,
	createSessionPasskey,
	requestSession,
	resumeSession,
	submitWithSession,
	type Grant,
	type SubmitStage,
} from "./session"

/**
 * Make this app's own passkey for a Nido account: the device asks once. It is
 * the key the session's rules name, so it signs every later call (one prompt
 * each) and can do nothing those rules don't allow. Call from a click handler.
 */
export const createAppPasskey = (account: string) =>
	createSessionPasskey(account, document.title || window.location.host)

/**
 * Ask the owner of a Nido account to let this app's passkey act within
 * `grants`: Nido's page opens in a popup, and one confirmation with the
 * owner's passkey installs every rule. Call from a click handler before any
 * `await`; resolves with Nido's answer. Pass only the grants still to approve
 * (`sessionStatus(...).ask`).
 */
export const requestAppSession = (account: string, grants: Grant[]) =>
	requestSession({ account, grants, base: nidoBase })

/** Record Nido's answer when it came back by redirect; call once on page load. */
export const resumeAppSession = resumeSession

/** Read the account's rules to see which pending grants actually landed. */
export const checkAppSession = (account: string) =>
	checkSession(account, server, networkPassphrase)

// These wallets work on Local and Futurenet while the rest enforce or fail on
// any networks beside Testnet and Mainnet. Filter below based on dApp config.
const CUSTOM_NETWORK_WALLETS = new Set(["freighter", "xbull", "hana"])

/** The native XLM token's contract (its Stellar Asset Contract) on this network. */
export const xlmTokenId = Asset.native().contractId(networkPassphrase)

/** The Nido deployment this app connects to (`PUBLIC_NIDO_BASE`). */
export const nidoBase: string = import.meta.env.PUBLIC_NIDO_BASE || NIDO_BASE

/** The relayer that submits session calls and pays their fees
 * (`PUBLIC_NIDO_RELAYER`). */
export const nidoRelayer: string =
	import.meta.env.PUBLIC_NIDO_RELAYER || NIDO_RELAYER

StellarWalletsKit.init({
	network: networkPassphrase as Networks,
	modules: [
		...createNidoModules(networkPassphrase, nidoBase),
		...(stellarNetwork === "LOCAL" || stellarNetwork === "FUTURENET"
			? defaultModules({
					filterBy: (m) => CUSTOM_NETWORK_WALLETS.has(m.productId),
				})
			: defaultModules()),
	],
})

/** Open the built-in wallet-selection modal; resolves once a wallet is connected. */
export const connectWallet = () => StellarWalletsKit.authModal()

/** Open the built-in profile modal (shows the connected account + disconnect). */
export const profileModal = () => StellarWalletsKit.profileModal()

/** Disconnect the active wallet. The kit clears its own persisted state. */
export const disconnectWallet = () => StellarWalletsKit.disconnect()

/** Sign a transaction with the active wallet. Passed to generated contract clients. */
export const signTransaction: typeof StellarWalletsKit.signTransaction = async (
	tx,
	opts,
) => {
	try {
		return await StellarWalletsKit.signTransaction(tx, opts)
	} catch (error) {
		if (error instanceof Error && error.name === ACCOUNT_SWITCH_REQUESTED) {
			await disconnectWallet()
			throw new Error(
				"Connect again to choose another account, then rebuild and retry the transaction.",
			)
		}
		throw error
	}
}

/**
 * Nido signs in a popup, and browsers allow popups only during a user
 * gesture. Building a contract call simulates it over RPC first, which loses
 * the gesture, so the popup is blocked. Call this synchronously at the top of
 * the click/submit handler, before any `await`, and call the returned function
 * in a `finally`. A no-op for every other wallet, and when the app's session
 * passkey will sign instead.
 */
export function reserveSigningPopup(address: string | undefined): () => void {
	if (
		!address ||
		!isSmartAccount(address) ||
		activeSession(address) ||
		StellarWalletsKit.selectedModule?.productId !== NIDO_ID
	)
		return () => {}
	return reserveCeremonyPopup()
}

/** Options for `submitCall` and `submitContract`. */
export interface SubmitOptions {
	/** Hears each stage as it starts, so a screen can say what it waits for:
	 * `preparing`, then `passkey` (the app's session passkey) or `wallet`,
	 * then `sending` and `confirming`. */
	onStage?: (stage: SubmitStage) => void
}

/**
 * Submit a generated-client call for the connected account and resolve with
 * the confirmed result and its transaction hash.
 *
 * - G-address: the wallet signs, the SDK sends (`signAndSend`).
 * - C-address with an approved session (see `session.ts`): this app's
 *   passkey signs under the account's rules (one device prompt), and Nido's
 *   relayer submits.
 * - C-address without one: Nido's popup. Its passkey signs under the
 *   account's admin rule, which only covers calls on the account itself, so
 *   a call into another contract is refused; request a session for those.
 */
export async function submitContract<T>(
	tx: contract.AssembledTransaction<T>,
	address: string,
	{ onStage }: SubmitOptions = {},
): Promise<{ result: T; hash: string }> {
	if (!isSmartAccount(address)) {
		onStage?.("wallet")
		const sent = await tx.signAndSend({ signTransaction })
		const hash = sent.sendTransactionResponse?.hash
		if (!hash) throw new Error("The wallet sent no transaction")
		return { result: sent.result, hash }
	}
	const session = activeSession(address)
	if (session)
		return submitWithSession(
			tx,
			session,
			{ server, networkPassphrase, relayer: nidoRelayer },
			onStage,
		)
	if (StellarWalletsKit.selectedModule.productId !== NIDO_ID) {
		throw new Error("This smart-account submission flow requires Nido")
	}
	return submitSmartAccount(tx, address, signTransaction, server, onStage)
}

/**
 * Build and submit one contract call for `address`, the whole call site in
 * one step: reserves Nido's popup, builds the call with a transaction source
 * a C-address can use, submits it, and releases the popup. Call it before any
 * other `await` in the click handler, so the popup keeps the user's gesture:
 *
 *     const { result, hash } = await submitCall(address, (publicKey) =>
 *         myContract.my_fn({ user: address }, { publicKey }))
 *
 * Pass `{ onStage }` to show what the call is waiting for.
 */
export async function submitCall<T>(
	address: string,
	build: (
		publicKey: string | undefined,
	) => Promise<contract.AssembledTransaction<T>>,
	options: SubmitOptions = {},
): Promise<{ result: T; hash: string }> {
	const release = reserveSigningPopup(address)
	try {
		options.onStage?.("preparing")
		return await submitContract(
			await build(transactionSource(address)),
			address,
			options,
		)
	} finally {
		release()
	}
}

/**
 * Use the wallet's reported network if it supports it, otherwise flag the
 * wallet as unsupported. Note that even if a wallet is `unsupported`, this
 * only means it does not support the `getNetwork` function. It *may* still
 * support passing `networkPassphrase` to `signTransaction`. For the wallets
 * that do not support the `networkPassphrase` argument to `signTransaction`,
 * you can fall back to error parsing to determine if `signTransaction`
 * failures were due to network mismatch.
 */
export const getWalletNetwork = async (): Promise<{
	supported: boolean
	networkPassphrase?: string
}> => {
	try {
		const { networkPassphrase } = await StellarWalletsKit.getNetwork()
		return { supported: true, networkPassphrase }
	} catch {
		return { supported: false }
	}
}

/**
 * Watch the network the wallet itself reports. Extensions emit no event when
 * the user switches networks, so this polls `getNetwork` — the only available
 * signal. The callback fires immediately with the current passphrase
 * (`undefined` when the wallet can't report one) and again on every change.
 *
 * Returns a cleanup function that stops polling. Only used in `onWalletChange`
 */
const onWalletNetworkChange = (
	cb: (networkPassphrase: string | undefined) => void,
	pollInterval = 3000,
): (() => void) => {
	let last: string | undefined
	let first = true
	let timeoutId: ReturnType<typeof setTimeout> | null = null
	let stopped = false

	const poll = async () => {
		const { networkPassphrase } = await getWalletNetwork()
		if (stopped) return
		if (first || networkPassphrase !== last) {
			first = false
			last = networkPassphrase
			cb(networkPassphrase)
		}
		timeoutId = setTimeout(() => void poll(), pollInterval)
	}
	void poll()

	return () => {
		stopped = true
		if (timeoutId != null) clearTimeout(timeoutId)
	}
}

export interface WalletState {
	address: string | undefined
	networkPassphrase: string | undefined
}

/**
 * Subscribe to full wallet state: connected address and network. Fires
 * immediately with the current state on subscribe (covering reload restore)
 * and on every subsequent change: connect, disconnect, or the wallet
 * switching networks (detected via polling, see `onWalletNetworkChange`).
 *
 * Returns an framework-agnostic unsubscribe function.
 */
export const onWalletChange = (
	cb: (state: WalletState) => void,
): (() => void) => {
	let stopPoll: (() => void) | undefined

	const stopState = StellarWalletsKit.on(
		KitEventType.STATE_UPDATED,
		(event) => {
			stopPoll?.()
			stopPoll = undefined
			// NOTE: `event.networkPassphrase` is the app's configured network, not
			// the wallet's connected network. Disregard it and start our own polling
			// logic below if we have an address.
			const { address } = event.payload
			if (address) {
				stopPoll = onWalletNetworkChange((networkPassphrase) =>
					cb({ address, networkPassphrase }),
				)
			} else {
				cb({ address: undefined, networkPassphrase: undefined })
			}
		},
	)

	const stopDisconnect = StellarWalletsKit.on(KitEventType.DISCONNECT, () => {
		stopPoll?.()
		stopPoll = undefined
		cb({ address: undefined, networkPassphrase: undefined })
	})

	return () => {
		stopState()
		stopDisconnect()
		stopPoll?.()
	}
}

// Server is configured from the generated clients' options, which don't change at runtime
const server = new rpc.Server(rpcUrl, { allowHttp })

const formatter = new Intl.NumberFormat()

/** One stroop is 10^-7 XLM. */
const STROOPS_PER_XLM = 10_000_000n

/**
 * Format a stroop amount as XLM. Splits the integer and fractional parts in
 * bigint so large balances don't lose stroops before formatting.
 */
const formatStroops = (stroops: bigint): string => {
	const whole = stroops / STROOPS_PER_XLM
	const fraction = (stroops % STROOPS_PER_XLM).toString().padStart(7, "0")
	return formatter.format(Number(`${whole}.${fraction}`))
}

/**
 * Balances keyed by asset. Only native XLM (`xlm`) is fetched: RPC reads
 * ledger entries by key and can't list an account's trustlines.
 */
export type MappedBalances = { xlm?: { balance: string } }

/**
 * Fetch the account's native XLM balance over RPC. An unfunded account has no
 * ledger entry, so it resolves to `{}` and consumers see no `xlm` key. RPC
 * failures are logged and also resolve to `{}`.
 */
export const fetchBalances = async (
	address: string,
): Promise<MappedBalances> => {
	try {
		if (isSmartAccount(address)) {
			return {
				xlm: {
					balance: formatStroops(
						await smartAccountBalance(address, server, networkPassphrase),
					),
				},
			}
		}
		const key = xdr.LedgerKey.account(
			new xdr.LedgerKeyAccount({
				accountId: Keypair.fromPublicKey(address).xdrPublicKey(),
			}),
		)
		// `getLedgerEntries` rather than `getAccountEntry`, which reports every
		// failure (including RPC outages) as "Account not found"
		const { entries } = await server.getLedgerEntries(key)
		const account = entries[0]?.val.account()
		if (!account) return {}
		return { xlm: { balance: formatStroops(account.balance().toBigInt()) } }
	} catch (err) {
		console.error(err)
		return {}
	}
}

// The kit itself, for templates that need `on(...)` subscriptions or `setWallet`.
export const wallet = StellarWalletsKit
