import { expect, type BrowserContext, type Page } from "@playwright/test"
import {
	Account,
	Address,
	Contract,
	Networks,
	SorobanDataBuilder,
	StrKey,
	TransactionBuilder,
	nativeToScVal,
	xdr,
} from "@stellar/stellar-sdk"

// The real kit, module, popup transport, generated client and RPC parser run.
// Only the external wallet ceremony and network responses are fixtures.
export const account = StrKey.encodeContract(Buffer.alloc(32, 1))
export const source = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 2))
export const hash = "ab".repeat(32)
// The hosted wallet (app-lib NIDO_BASE) and its account subdomains.
const nidoWallet = /https:\/\/([^/]+\.)?test\.nido\.fyi\//
/** The WebAuthn verifier the mocked account names for passkey signers. */
export const verifier = StrKey.encodeContract(Buffer.alloc(32, 9))
const data = new SorobanDataBuilder().build().toXDR("base64")
const envelope = new TransactionBuilder(new Account(source, "0"), {
	fee: "100",
	networkPassphrase: Networks.TESTNET,
})
	.addOperation(new Contract(account).call("noop"))
	.setTimeout(30)
	.build()
	.toXDR()
const meta = new xdr.TransactionMeta(
	3,
	new xdr.TransactionMetaV3({
		ext: new xdr.ExtensionPoint(0),
		txChangesBefore: [],
		txChangesAfter: [],
		operations: [],
		sorobanMeta: new xdr.SorobanTransactionMeta({
			ext: new xdr.SorobanTransactionMetaExt(0),
			events: [],
			diagnosticEvents: [],
			returnValue: nativeToScVal(true),
		}),
	}),
).toXDR("base64")
const result = new xdr.TransactionResult({
	feeCharged: xdr.Int64.fromString("100"),
	result: xdr.TransactionResultResult.txSuccess([]),
	ext: new xdr.TransactionResultExt(0),
}).toXDR("base64")

/** One grant of a request to Nido's grant page, with the request's passkey
 * and duration. */
export type AskedGrant = Record<string, string>

/** What Nido's grant page does with the request at `index`: the answer it
 * posts back (e.g. `?delegation=ok`) and whether its rules landed on the
 * account. */
export type GrantAnswer = (
	grants: AskedGrant[],
	index: number,
) => { answer: string; landed: boolean }

export const approveAll: GrantAnswer = () => ({
	answer: "?delegation=ok",
	landed: true,
})

/**
 * Mock the testnet RPC, Friendbot, Nido's pages and Nido's relayer for
 * `context`. `auth` gives the auth entries a simulated call asks the account
 * for (by function name and contract), `grantAnswer` plays the owner on
 * Nido's grant page, and `refuse` plays the account: an error it returns
 * fails the enforced simulation of a session call (e.g.
 * `Error(Contract, #3221)` over a cap).
 */
export async function mockServices(
	context: BrowserContext,
	{
		signResult = `?nido_submitted=${hash}&kind=tx`,
		grantAnswer = approveAll,
		auth = () => [],
		refuse = () => undefined,
	}: {
		signResult?: string
		grantAnswer?: GrantAnswer
		auth?: (method: string, target: string) => xdr.SorobanAuthorizationEntry[]
		refuse?: () => string | undefined
	} = {},
) {
	const calls: string[] = []
	const requests: AskedGrant[][] = []
	const landed: AskedGrant[] = []
	const sent: xdr.TransactionEnvelope[] = []
	const relayed: { func: string; auth: string[] }[] = []
	const funded: string[] = []
	await context.route(
		"https://soroban-testnet.stellar.org/**",
		async (route) => {
			const body = route.request().postDataJSON() as {
				id: string
				method: string
				params: { transaction?: string }
			}
			calls.push(body.method)
			let response: unknown
			if (body.method === "simulateTransaction") {
				const tx = TransactionBuilder.fromXDR(
					body.params.transaction!,
					Networks.TESTNET,
				)
				if (!("operations" in tx)) throw new Error("Unexpected fee bump")
				const op = tx.operations[0]
				if (op?.type !== "invokeHostFunction")
					throw new Error("Unexpected operation")
				const call = op.func.invokeContract()
				const method = call.functionName().toString()
				const target = Address.fromScAddress(call.contractAddress()).toString()
				const enforced =
					(body.params as { authMode?: string }).authMode === "enforce"
				const refusal = enforced ? refuse() : undefined
				const retval =
					method === "balance"
						? nativeToScVal(125000000n, { type: "i128" })
						: method === "installed_rules"
							? installedRules(landed)
							: method === "capabilities"
								? nativeToScVal(
										{ auth_digest: "addr_oz_v1" },
										{ type: { auth_digest: ["symbol", "symbol"] } },
									)
								: nativeToScVal(false)
				response = refusal
					? { latestLedger: 100, error: refusal }
					: {
							latestLedger: 100,
							minResourceFee: "100",
							transactionData: data,
							events: [],
							results: [
								{
									auth: auth(method, target).map((a) => a.toXDR("base64")),
									xdr: retval.toXDR("base64"),
								},
							],
						}
			} else if (body.method === "getTransaction") {
				response = {
					status: "SUCCESS",
					latestLedger: 102,
					ledger: 101,
					createdAt: 1,
					applicationOrder: 1,
					feeBump: false,
					envelopeXdr: envelope,
					resultXdr: result,
					resultMetaXdr: meta,
				}
			} else if (body.method === "getLedgerEntries") {
				// Only classic accounts are read this way.
				const keys = (body.params as unknown as { keys: string[] }).keys
				response = { latestLedger: 100, entries: keys.map(accountEntry) }
			} else if (body.method === "sendTransaction") {
				const tx = xdr.TransactionEnvelope.fromXDR(
					body.params.transaction!,
					"base64",
				)
				sent.push(tx)
				response = { status: "PENDING", hash, latestLedger: 100 }
			} else throw new Error(`Unexpected RPC method: ${body.method}`)
			await route.fulfill({
				json: { jsonrpc: "2.0", id: body.id, result: response },
			})
		},
	)
	await context.route("https://friendbot.stellar.org/**", (route) => {
		funded.push(new URL(route.request().url()).searchParams.get("addr")!)
		return route.fulfill({ json: { successful: true } })
	})
	// Nido's relayer: submits a signed call and pays its fee.
	await context.route("https://nido.fly.dev/relay", async (route) => {
		const { params } = route.request().postDataJSON() as {
			params: { func: string; auth: string[] }
		}
		relayed.push(params)
		await route.fulfill({
			json: {
				success: true,
				data: { transactionId: "t1", hash, status: "confirmed" },
			},
		})
	})
	await context.route(nidoWallet, async (route) => {
		const url = new URL(route.request().url())
		if (url.pathname === "/security/delegate-doc/") {
			// The owner approves (or not) every grant at once on Nido's page,
			// which posts the answer to the app that opened it and closes.
			const q = url.searchParams
			const asked: AskedGrant[] = []
			for (let i = 0; q.has(`grant.${i}.label`); i++)
				asked.push({
					pubkey: q.get("pubkey")!,
					duration: q.get("duration")!,
					...Object.fromEntries(
						[...q]
							.filter(([k]) => k.startsWith(`grant.${i}.`))
							.map(([k, v]) => [k.slice(`grant.${i}.`.length), v]),
					),
				})
			requests.push(asked)
			const outcome = grantAnswer(asked, requests.length - 1)
			if (outcome.landed) landed.push(...asked)
			return route.fulfill({
				contentType: "text/html",
				body: `<!doctype html><title>Nido test grant</title><script>opener.postMessage({source:'nido-wallet',search:${JSON.stringify(outcome.answer)}}, ${JSON.stringify(q.get("origin"))}); window.close()</script>`,
			})
		}
		const search =
			url.pathname === "/connect/" ? `?nido_address=${account}` : signResult
		await route.fulfill({
			contentType: "text/html",
			body: `<!doctype html><title>Nido test ceremony</title><h1>Test wallet fixture</h1><button id="approve">Approve test request</button><script>document.querySelector('#approve').onclick = () => { opener.postMessage({source:'nido-wallet',search:${JSON.stringify(search)}}, ${JSON.stringify(url.searchParams.get("dapp"))}); window.close(); }</script>`,
		})
	})
	return { calls, requests, landed, sent, relayed, funded }
}

/** What the account reports after `grants` landed, as rules 2, 3, … */
function installedRules(grants: AskedGrant[]) {
	return xdr.ScVal.scvVec(
		grants.map((grant, i) =>
			nativeToScVal(
				{
					context_type: xdr.ScVal.scvVec([
						xdr.ScVal.scvSymbol("CallContract"),
						new Address(grant.target!).toScVal(),
					]),
					id: nativeToScVal(i + 2, { type: "u32" }),
					name: grant.label!,
					signers: xdr.ScVal.scvVec([
						xdr.ScVal.scvVec([
							xdr.ScVal.scvSymbol("External"),
							new Address(verifier).toScVal(),
							nativeToScVal(Buffer.from(grant.pubkey!, "hex")),
						]),
					]),
					valid_until: nativeToScVal(1000, { type: "u32" }),
				},
				{ type: { id: ["symbol", null] } },
			),
		),
	)
}

/** A call into `contract`, with its own sub-calls. */
export function invocation(
	contract: string,
	fn: string,
	args: xdr.ScVal[],
	subInvocations: xdr.SorobanAuthorizedInvocation[] = [],
) {
	return new xdr.SorobanAuthorizedInvocation({
		function:
			xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
				new xdr.InvokeContractArgs({
					contractAddress: new Address(contract).toScAddress(),
					functionName: fn,
					args,
				}),
			),
		subInvocations,
	})
}

/** The account's unsigned auth entry for `root`, as simulation returns it. */
export function accountAuth(root: xdr.SorobanAuthorizedInvocation) {
	return new xdr.SorobanAuthorizationEntry({
		credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
			new xdr.SorobanAddressCredentials({
				address: new Address(account).toScAddress(),
				nonce: xdr.Int64.fromString("7"),
				signatureExpirationLedger: 0,
				signature: xdr.ScVal.scvVoid(),
			}),
		),
		rootInvocation: root,
	})
}

/** A funded classic account entry for the requested account key. */
function accountEntry(key: string) {
	const accountId = xdr.LedgerKey.fromXDR(key, "base64").account().accountId()
	const entry = new xdr.LedgerEntryData.account(
		new xdr.AccountEntry({
			accountId,
			balance: xdr.Int64.fromString("100000000000"),
			seqNum: xdr.SequenceNumber.fromString("1"),
			numSubEntries: 0,
			inflationDest: null,
			flags: 0,
			homeDomain: "",
			thresholds: Buffer.from([1, 0, 0, 0]),
			signers: [],
			ext: new xdr.AccountEntryExt(0),
		}),
	)
	return { key, xdr: entry.toXDR("base64"), lastModifiedLedgerSeq: 1 }
}

/**
 * Give `page` a virtual authenticator, as a device with a platform passkey:
 * every prompt is answered at once, with user verification. Returns a count
 * of the credentials it holds.
 */
export async function virtualAuthenticator(page: Page) {
	const cdp = await page.context().newCDPSession(page)
	await cdp.send("WebAuthn.enable")
	const { authenticatorId } = await cdp.send(
		"WebAuthn.addVirtualAuthenticator",
		{
			options: {
				protocol: "ctap2",
				transport: "internal",
				hasResidentKey: true,
				hasUserVerification: true,
				isUserVerified: true,
				automaticPresenceSimulation: true,
			},
		},
	)
	return async () =>
		(await cdp.send("WebAuthn.getCredentials", { authenticatorId })).credentials
}

/** Connect the mocked Nido account through the real wallet picker. */
export async function connect(page: Page) {
	await page.goto("/")
	await page.getByRole("button", { name: "Connect", exact: true }).click()
	const popupPromise = page.waitForEvent("popup")
	await page.getByText("Nido", { exact: true }).click()
	const popup = await popupPromise
	await popup.getByRole("button", { name: "Approve test request" }).click()
	await expect(page.locator(".wallet-balance")).toContainText("12.5 XLM")
}
