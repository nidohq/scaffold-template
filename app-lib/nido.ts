import { NidoModule } from "@nidohq/stellar-wallets-kit-module"
import {
	Account,
	Asset,
	Contract,
	Networks,
	StrKey,
	TransactionBuilder,
	contract,
	nativeToScVal,
	rpc,
	scValToNative,
} from "@stellar/stellar-sdk"

export const isSmartAccount = StrKey.isValidContract

/** Hosted Nido's testnet wallet; apps override it with `PUBLIC_NIDO_BASE`. */
export const NIDO_BASE = "https://test.nido.fyi"

/** Hosted Nido's testnet relayer; apps override it with `PUBLIC_NIDO_RELAYER`. */
export const NIDO_RELAYER = "https://nido.fly.dev"

// Hosted Nido is testnet-only. Do not advertise it on incompatible networks.
export function createNidoModules(passphrase: string, base = NIDO_BASE) {
	return passphrase === Networks.TESTNET
		? [new NidoModule({ base, networkPassphrase: passphrase })]
		: []
}

// A C-address authorizes a contract call; it cannot source a transaction.
// Omitting publicKey uses the generated SDK client's simulation-only source.
export const transactionSource = (address: string) =>
	isSmartAccount(address) ? undefined : address

export async function smartAccountBalance(
	address: string,
	server: rpc.Server,
	networkPassphrase: string,
): Promise<bigint> {
	const tx = new TransactionBuilder(
		new Account(
			"GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
			"0",
		),
		{ fee: "100", networkPassphrase },
	)
		.addOperation(
			new Contract(Asset.native().contractId(networkPassphrase)).call(
				"balance",
				nativeToScVal(address, { type: "address" }),
			),
		)
		.setTimeout(30)
		.build()
	const simulation = await server.simulateTransaction(tx)
	if (!rpc.Api.isSimulationSuccess(simulation) || !simulation.result) {
		throw new Error("Unable to read smart-account XLM balance")
	}
	return BigInt(scValToNative(simulation.result.retval) as bigint)
}

export type WalletSignResult = {
	signedTxXdr: string
	signerAddress?: string
	submitted?: true
}

/** Nido submits through its relayer. Never feed the returned hash to signAndSend. */
export async function submitSmartAccount<T>(
	tx: contract.AssembledTransaction<T>,
	address: string,
	sign: (
		xdr: string,
		opts: { address: string; networkPassphrase: string },
	) => Promise<WalletSignResult>,
	server: rpc.Server,
): Promise<{ result: T; hash: string }> {
	const response = await sign(tx.toXDR(), {
		address,
		networkPassphrase: tx.options.networkPassphrase,
	})
	if (!response.submitted) {
		throw new Error(
			"This Nido deployment returned signed XDR without submitting. Use a Nido deployment with relayer support.",
		)
	}
	const hash = response.signedTxXdr
	if (!/^[a-f0-9]{64}$/i.test(hash))
		throw new Error("Nido returned an invalid transaction hash")
	for (let attempt = 0; attempt < 20; attempt++) {
		const confirmed = await server.getTransaction(hash)
		if (confirmed.status === rpc.Api.GetTransactionStatus.SUCCESS) {
			if (!confirmed.returnValue)
				throw new Error(`Transaction ${hash} has no return value`)
			return { result: tx.options.parseResultXdr(confirmed.returnValue), hash }
		}
		if (confirmed.status === rpc.Api.GetTransactionStatus.FAILED) {
			throw new Error(`Transaction ${hash} failed on chain`)
		}
		await new Promise((resolve) => setTimeout(resolve, 1000))
	}
	throw new Error(
		`Nido submitted ${hash}, but confirmation is still pending. Check this hash before retrying.`,
	)
}
