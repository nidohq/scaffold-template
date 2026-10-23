import { createHash, generateKeyPairSync, sign, verify } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	Account,
	Address,
	Networks,
	Operation,
	StrKey,
	TransactionBuilder,
	contract,
	hash,
	nativeToScVal,
	rpc,
	scValToNative,
	xdr,
} from "@stellar/stellar-sdk"
import {
	activeSession,
	authContexts,
	authDigest,
	authPayload,
	checkSession,
	createSessionPasskey,
	derToCompact,
	describe as explain,
	explainRefusal,
	grantUrl,
	isOverCap,
	loadSession,
	parseRules,
	passkeySigners,
	requestSession,
	resumeSession,
	ruleIdsFor,
	sessionCovers,
	sessionStatus,
	submitWithSession,
	webAuthnSigData,
	type Grant,
	type InstalledRule,
	type Session,
	type SessionPasskey,
} from "./session"

const account = StrKey.encodeContract(Buffer.alloc(32, 1))
const sac = StrKey.encodeContract(Buffer.alloc(32, 2))
const app = StrKey.encodeContract(Buffer.alloc(32, 3))
const verifier = StrKey.encodeContract(Buffer.alloc(32, 4))
const pending = "scaffold:nido-session:pending"

/** A P-256 key standing in for the device's authenticator. */
const device = generateKeyPairSync("ec", { namedCurve: "P-256" })
const spki = device.publicKey.export({ format: "der", type: "spki" })
const passkey: SessionPasskey = {
	credentialId: "Y3JlZGVudGlhbA",
	publicKey: spki.subarray(-65).toString("hex"),
}
/** Key data as Nido installs it: the public key, then the credential id. */
const keyData = passkey.publicKey + Buffer.from("credential").toString("hex")

const call = (
	contractId: string,
	subInvocations: xdr.SorobanAuthorizedInvocation[] = [],
) =>
	new xdr.SorobanAuthorizedInvocation({
		function:
			xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
				new xdr.InvokeContractArgs({
					contractAddress: new Address(contractId).toScAddress(),
					functionName: "f",
					args: [],
				}),
			),
		subInvocations,
	})

afterEach(() => {
	localStorage.clear()
	vi.unstubAllGlobals()
	vi.useRealTimers()
})

const hour = 3_600_000
const play: Grant = {
	target: app,
	functions: ["play"],
	duration: "24h",
	label: "play",
}
const spend: Grant = {
	target: sac,
	functions: ["transfer"],
	duration: "24h",
	limit: { amount: "2", period: "day" },
	label: "spend",
}
const store = (grants: Session["grants"], extra: Partial<Session> = {}) =>
	localStorage.setItem(
		`scaffold:nido-session:${account}`,
		JSON.stringify({ account, passkey, grants, ...extra }),
	)

describe("asking Nido for grants", () => {
	const ask = (base: string, grants = [play, spend]) =>
		new URL(
			grantUrl({
				base,
				account,
				passkey,
				grants,
				returnUrl: "http://localhost:5180/board",
			}),
		)
	it("sends every grant for the app's passkey in one request", () => {
		const url = ask("https://test.nido.fyi")
		expect(url.host).toBe(`${account.toLowerCase()}.test.nido.fyi`)
		expect(url.pathname).toBe("/security/delegate-doc/")
		expect(Object.fromEntries(url.searchParams)).toEqual({
			origin: "http://localhost:5180",
			pubkey: passkey.publicKey,
			duration: "24h",
			"grant.0.label": "play",
			"grant.0.target": app,
			"grant.0.functions": "play",
			// The app declares a rule without a cap uncapped
			"grant.0.limit": "none",
			"grant.1.label": "spend",
			"grant.1.target": sac,
			"grant.1.functions": "transfer",
			"grant.1.limit": "2",
			"grant.1.limit_period": "day",
			return: "http://localhost:5180/board",
		})
	})
	it("finds the account on a Nido preview and on a local wallet", () => {
		expect(ask("https://318.test.nido.fyi").host).toBe(
			`${account.toLowerCase()}--318.test.nido.fyi`,
		)
		expect(ask("http://localhost:4321").origin).toBe(
			`http://${account.toLowerCase()}.localhost:4321`,
		)
	})
	it("refuses requests Nido would reject", () => {
		const long = { ...play, label: "a label that is far too long" }
		expect(() => ask("https://test.nido.fyi", [long])).toThrow(/20 bytes/)
		const week = { ...spend, duration: "7d" as const }
		expect(() => ask("https://test.nido.fyi", [play, week])).toThrow(
			/share one duration/,
		)
		const nine = Array.from({ length: 9 }, (_, i) => ({
			...play,
			label: `g${i}`,
		}))
		expect(() => ask("https://test.nido.fyi", nine)).toThrow(/at most 8/)
	})
})

describe("session authorization", () => {
	const rules: InstalledRule[] = [
		{
			id: 0,
			name: "admin",
			contract: account,
			external: [{ verifier, key: "04".padEnd(130, "a") }],
			delegated: [],
			validUntil: undefined,
		},
		{
			id: 3,
			name: "app",
			contract: app,
			external: [{ verifier, key: keyData }],
			delegated: [],
			validUntil: 900,
		},
		{
			id: 4,
			name: "spend",
			contract: sac,
			external: [{ verifier, key: keyData }],
			delegated: [],
			validUntil: 900,
		},
	]
	it("lists authorized contracts in the order __check_auth sees them", () => {
		expect(
			authContexts(call(app, [call(sac), call(app, [call(sac)])])),
		).toEqual([app, sac, app, sac])
	})
	it("selects the passkey's unexpired rule for each context", () => {
		expect(ruleIdsFor([app, sac], rules, passkey, 900)).toEqual([3, 4])
		expect(() => ruleIdsFor([sac], rules, passkey, 901)).toThrow(/expired/)
		expect(() => ruleIdsFor([account], rules, passkey, 1)).toThrow(account)
		const other = { ...passkey, publicKey: "04".padEnd(130, "b") }
		expect(() => ruleIdsFor([sac], rules, other, 1)).toThrow()
		expect(passkeySigners([3, 4], rules, passkey)).toEqual([
			{ verifier, key: keyData },
		])
	})
	it("encodes the AuthPayload byte for byte as Perch does", () => {
		// perch testdata/auth/auth-vectors.json, auth_payload (external signer)
		const payload = authPayload(
			[0, 9],
			[
				{
					verifier: "CDGGTZJDHAPV3S5LD36GAETRHWZ6ASCEZ5YRH7O5JOK3WXW55RRHOLL5",
					key: "aa".repeat(65),
				},
			],
			Buffer.alloc(64, 1),
		)
		expect(payload.toXDR("hex")).toBe(
			"0000001100000001000000020000000f00000010636f6e746578745f72756c655f696473000000100000000100000002000000030000000000000003000000090000000f000000077369676e657273000000001100000001000000010000001000000001000000030000000f0000000845787465726e616c0000001200000001cc69e523381f5dcbab1efc6012713db3e04844cf7113fddd4b95bb5eddec62770000000d00000041" +
				"aa".repeat(65) +
				"0000000000000d00000040" +
				"01".repeat(64),
		)
	})
	it("signs the digest each kind of account recomputes", async () => {
		// perch testdata/auth/auth-vectors.json, signing_digest (addr_oz_v1)
		const vectors = [
			[
				"837885c8f8091aeaeb9ec3c3f85a6ff470a415e610b8ba3e49f9b33c9cf9d619",
				[],
				"2d6b4c41959204bf3e439539be30d0e8f358499867c42158e2faf20eec5d680a",
			],
			[
				"da4a51839ac39aec93a9000e4ac50b7441655d1569772703e4ecf90d46c4dac5",
				[1, 2, 3],
				"51e5fa49edb7b9bcd2c3ee5a14bb9f995e95929318cdc6fbaaf005b5504572df",
			],
			[
				"12a552b1c1b28ed6ca45d87d75e9d2ce7764ed42bc3f9586e2228d02e9879ea0",
				[4294967295, 7],
				"a80e2b10a7a271711943ee8c4e600f6287c8a20e1a90c2e3d25afb3bfc8a4214",
			],
		] as const
		const perchAccount =
			"CC5QACNC45UM2FLTKPXD2TME7647YHUPF4PGHQBFRP26PHHDQ6LWAPBF"
		for (const [payload, ids, digest] of vectors)
			expect(
				Buffer.from(
					await authDigest(
						perchAccount,
						Buffer.from(payload, "hex"),
						[...ids],
						"addr_oz_v1",
					),
				).toString("hex"),
			).toBe(digest)
		// Accounts made before the address binding hash the payload and ids only
		const [payload, ids] = vectors[1]
		const unbound = createHash("sha256")
			.update(Buffer.from(payload, "hex"))
			.update(xdr.ScVal.scvVec(ids.map((id) => xdr.ScVal.scvU32(id))).toXDR())
			.digest("hex")
		expect(
			Buffer.from(
				await authDigest(
					account,
					Buffer.from(payload, "hex"),
					[...ids],
					"oz_rule_ids",
				),
			).toString("hex"),
		).toBe(unbound)
	})
	it("turns the device's DER signature into a low-S r‖s", () => {
		const message = Buffer.from("message")
		for (let i = 0; i < 8; i++) {
			const der = sign("sha256", message, device.privateKey)
			const compact = derToCompact(der)
			expect(compact).toHaveLength(64)
			expect(compact[32]! < 0x80).toBe(true)
			expect(
				verify(
					"sha256",
					message,
					{ key: device.publicKey, dsaEncoding: "ieee-p1363" },
					compact,
				),
			).toBe(true)
		}
	})
	it("decodes installed_rules in either tuple-enum shape", () => {
		expect(
			parseRules([
				{
					id: 1,
					name: "probe",
					context_type: ["CallContract", sac],
					signers: [["External", verifier, Buffer.from(keyData, "hex")]],
					valid_until: 5342016,
				},
				{
					id: 0,
					name: "admin",
					context_type: { CallContract: account },
					signers: [
						{ External: [verifier, new Uint8Array(65)] },
						{ Delegated: sac },
					],
					valid_until: null,
				},
			]),
		).toEqual([
			{
				id: 1,
				name: "probe",
				contract: sac,
				external: [{ verifier, key: keyData }],
				delegated: [],
				validUntil: 5342016,
			},
			{
				id: 0,
				name: "admin",
				contract: account,
				external: [{ verifier, key: "00".repeat(65) }],
				delegated: [sac],
				validUntil: undefined,
			},
		])
	})
	it("explains the refusals a person can act on", () => {
		expect(explainRefusal("HostError: Error(Contract, #3221)")).toMatch(
			/spending cap/,
		)
		expect(explainRefusal("Error(Contract, #3002)")).toMatch(/no approved rule/)
		expect(explainRefusal("network down")).toBe("network down")
	})
})

describe("session coverage", () => {
	it("needs the same target, functions and cap, unexpired", () => {
		const now = 1_000 * hour
		const session: Session = {
			account,
			passkey,
			grants: [
				{ ...play, expiresAt: now + hour },
				{ ...spend, expiresAt: now + 2 * hour },
			],
		}
		expect(sessionCovers(session, [play, spend], now)).toMatchObject({
			ask: [],
			expiresAt: now + hour,
		})
		const moved = { ...play, target: sac }
		const wider = { ...play, functions: ["play", "reset"] }
		const capped = { ...spend, limit: { amount: "5", period: "day" as const } }
		expect(sessionCovers(session, [moved, wider, capped], now).ask).toEqual([
			moved,
			wider,
			capped,
		])
		expect(sessionCovers(session, [play], now + hour).expired).toEqual([play])
	})
	it("tells a gate whether to make a passkey, ask, wait, renew or go ahead", () => {
		const now = 1_000 * hour
		expect(sessionStatus(account, [play], now)).toEqual({
			state: "ask",
			ask: [play],
			reason: "new",
			passkey: false,
		})
		store([])
		expect(sessionStatus(account, [play], now)).toMatchObject({
			reason: "new",
			passkey: true,
		})
		store([{ ...play, expiresAt: now + hour }, spend])
		expect(sessionStatus(account, [play], now).state).toBe("ready")
		expect(sessionStatus(account, [play, spend], now)).toMatchObject({
			state: "waiting",
			waiting: [spend],
		})
		store([{ ...play, expiresAt: now + hour }])
		expect(sessionStatus(account, [play, spend], now)).toMatchObject({
			state: "ask",
			ask: [spend],
			reason: "changed",
		})
		expect(sessionStatus(account, [play], now + hour)).toMatchObject({
			state: "ask",
			reason: "expired",
		})
		expect(activeSession(account, now)).toBeDefined()
		expect(activeSession(account, now + hour)).toBeUndefined()
	})
	it("drops a session from before passkeys: its ed25519 key no longer signs", () => {
		localStorage.setItem(
			`scaffold:nido-session:${account}`,
			JSON.stringify({ account, publicKey: "G", secret: "S", grants: [play] }),
		)
		expect(loadSession(account)).toBeUndefined()
		expect(sessionStatus(account, [play])).toMatchObject({ passkey: false })
	})
})

describe("the app's passkey", () => {
	const page = (hostname: string) =>
		vi.stubGlobal("window", { location: { hostname } })
	it("keeps only the public key and credential id", async () => {
		page("localhost")
		const create = vi.fn(async () => ({
			rawId: Uint8Array.from(Buffer.from("credential")).buffer,
			response: {
				getPublicKey: () => Uint8Array.from(spki).buffer,
				getPublicKeyAlgorithm: () => -7,
			},
		}))
		vi.stubGlobal("navigator", { credentials: { create } })
		store([{ ...play, expiresAt: Date.now() + hour }])
		const session = await createSessionPasskey(account, "Guess")
		expect(session).toEqual({ account, passkey, grants: [] })
		expect(
			JSON.parse(localStorage.getItem(`scaffold:nido-session:${account}`)!),
		).toEqual({ account, passkey, grants: [] })
		const options = (
			create.mock.calls[0] as unknown as [
				{ publicKey: PublicKeyCredentialCreationOptions },
			]
		)[0].publicKey
		expect(options.rp.id).toBe("localhost")
		expect(options.pubKeyCredParams).toEqual([{ type: "public-key", alg: -7 }])
		expect(options.authenticatorSelection?.userVerification).toBe("required")
	})
	it("needs a host name, which an IP address is not", async () => {
		page("127.0.0.1")
		await expect(createSessionPasskey(account, "Guess")).rejects.toThrow(
			/open this app at localhost/,
		)
	})
})

/** A page whose popups and messages the test controls. */
const browser = (href: string, { blocked = false } = {}) => {
	const listeners = new Set<(event: unknown) => void>()
	const popup = { closed: false, close: vi.fn() }
	const assign = vi.fn()
	const replaceState = vi.fn()
	const open = vi.fn((_url: string, _name?: string, _features?: string) =>
		blocked ? null : popup,
	)
	vi.stubGlobal("window", {
		location: { href, hostname: new URL(href).hostname, assign },
		history: { replaceState },
		open,
		addEventListener: (_: string, l: (event: unknown) => void) =>
			listeners.add(l),
		removeEventListener: (_: string, l: (event: unknown) => void) =>
			listeners.delete(l),
	})
	/** Nido's page posts `search` back to the app and closes. */
	const answer = (search: string) => {
		const origin = new URL(open.mock.calls[0]![0]).origin
		for (const listener of [...listeners])
			listener({
				origin,
				source: popup,
				data: { source: "nido-wallet", search },
			})
	}
	return { open, assign, replaceState, popup, answer }
}
const request = (grants = [play, spend]) =>
	requestSession({ account, grants, base: "https://test.nido.fyi" })

describe("asking for and resuming a session", () => {
	it("opens one popup for every grant and records Nido's approval", async () => {
		store([{ ...play, expiresAt: 1 }])
		const page = browser("http://localhost:5180/board?x=1#top")
		const result = request()
		const url = new URL(page.open.mock.calls[0]![0])
		expect(url.searchParams.get("pubkey")).toBe(passkey.publicKey)
		expect(url.searchParams.get("grant.1.label")).toBe("spend")
		expect(url.searchParams.get("return")).toBe("http://localhost:5180/board")
		expect(loadSession(account)?.grants).toEqual([play, spend])
		page.answer("?delegation=ok")
		expect(await result).toEqual({ account, outcome: "approved" })
		for (const grant of loadSession(account)!.grants)
			expect(grant.expiresAt! - Date.now()).toBeGreaterThan(23 * hour)
		expect(localStorage.getItem(pending)).toBeNull()
	})
	it("asks for grants with another duration in a second request", async () => {
		store([])
		const page = browser("http://localhost:5180/")
		void request([play, { ...spend, duration: "7d" }])
		const url = new URL(page.open.mock.calls[0]![0])
		expect(url.searchParams.has("grant.1.label")).toBe(false)
		expect(loadSession(account)?.grants).toEqual([play])
	})
	it("keeps the passkey and approved grants when the owner cancels", async () => {
		store([{ ...play, expiresAt: Date.now() + hour }])
		const page = browser("http://localhost:5180/")
		const result = request([spend])
		page.answer("?delegation=cancelled")
		expect((await result).outcome).toBe("cancelled")
		expect(loadSession(account)?.grants.map((g) => g.label)).toEqual(["play"])
		expect(loadSession(account)?.passkey).toEqual(passkey)
	})
	it("reports a relayer refusal and leaves the grants waiting", async () => {
		store([])
		const page = browser("http://localhost:5180/")
		const result = request()
		page.answer("?delegation=error&code=FEE_LIMIT_EXCEEDED")
		expect(await result).toMatchObject({
			outcome: "refused",
			message: expect.stringMatching(/budget is used up.*nothing was sent/),
		})
		expect(sessionStatus(account, [play, spend])).toMatchObject({
			state: "waiting",
			session: { refused: "FEE_LIMIT_EXCEEDED" },
		})
	})
	it("leaves the grants waiting when Nido's window closes without an answer", async () => {
		vi.useFakeTimers()
		store([])
		const page = browser("http://localhost:5180/")
		const result = request()
		page.popup.closed = true
		await vi.advanceTimersByTimeAsync(600)
		expect(await result).toEqual({ account, outcome: "closed" })
		expect(sessionStatus(account, [play, spend]).state).toBe("waiting")
	})
	it("goes to Nido in the page when the popup is blocked, and resumes on return", () => {
		store([])
		const page = browser("http://localhost:5180/", { blocked: true })
		void request()
		return vi.waitFor(() => {
			expect(page.assign).toHaveBeenCalled()
			expect(String(page.assign.mock.calls[0]![0])).toContain(
				"/security/delegate-doc/",
			)
			expect(localStorage.getItem(pending)).toBe(account)
			const back = browser("http://localhost:5180/#delegation=ok")
			expect(resumeSession()).toEqual({ account, outcome: "approved" })
			expect(String(back.replaceState.mock.calls[0]![2])).not.toContain(
				"delegation",
			)
			expect(resumeSession()).toBeNull()
		})
	})
	it("needs the app's passkey first", () => {
		browser("http://localhost:5180/")
		expect(() => request()).toThrow(/passkey/)
	})
})

/** A simulation that reads `retval`, as the RPC client parses one. */
const simulated = (retval: xdr.ScVal, latestLedger = 1_000) => ({
	latestLedger,
	transactionData: {},
	result: { retval, auth: [] },
})
const installed = (
	rules: { id: number; name: string; contract: string; key: string }[],
) =>
	nativeToScVal(
		rules.map(({ id, name, contract: target, key }) => ({
			context_type: xdr.ScVal.scvVec([
				xdr.ScVal.scvSymbol("CallContract"),
				new Address(target).toScVal(),
			]),
			id: nativeToScVal(id, { type: "u32" }),
			name,
			signers: xdr.ScVal.scvVec([
				xdr.ScVal.scvVec([
					xdr.ScVal.scvSymbol("External"),
					new Address(verifier).toScVal(),
					nativeToScVal(Buffer.from(key, "hex")),
				]),
			]),
			valid_until: nativeToScVal(1_720, { type: "u32" }),
		})),
		{ type: { id: ["symbol", null] } },
	)

describe("checking the chain for what landed", () => {
	it("approves grants found on chain and drops replaced ones", async () => {
		store([{ ...play, expiresAt: Date.now() + hour }, spend])
		localStorage.setItem(pending, account)
		const server = {
			simulateTransaction: vi.fn(async () =>
				simulated(
					installed([
						// `play` now names another passkey: approved again elsewhere
						{ id: 2, name: "play", contract: app, key: "04".padEnd(130, "b") },
						{ id: 3, name: "spend", contract: sac, key: keyData },
					]),
				),
			),
		} as unknown as rpc.Server
		expect(await checkSession(account, server, Networks.TESTNET)).toEqual({
			approved: 1,
			waiting: 0,
		})
		const [grant] = loadSession(account)!.grants
		expect(grant!.label).toBe("spend")
		// 720 ledgers of five seconds is an hour
		expect(Math.round((grant!.expiresAt! - Date.now()) / 60_000)).toBe(60)
		expect(localStorage.getItem(pending)).toBeNull()
	})
})

describe("a call signed by the app's passkey", () => {
	const me = new Address(account).toScVal()
	// A losing guess: `guess` on the game, then 1 XLM from the account
	const recorded = new xdr.SorobanAuthorizationEntry({
		credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
			new xdr.SorobanAddressCredentials({
				address: new Address(account).toScAddress(),
				nonce: xdr.Int64.fromString("7"),
				signatureExpirationLedger: 0,
				signature: xdr.ScVal.scvVoid(),
			}),
		),
		rootInvocation: call(app, [call(sac)]),
	})
	const func = xdr.HostFunction.hostFunctionTypeInvokeContract(
		new xdr.InvokeContractArgs({
			contractAddress: new Address(app).toScAddress(),
			functionName: "guess",
			args: [nativeToScVal(3, { type: "u64" }), me],
		}),
	)
	const assembled = {
		built: new TransactionBuilder(
			new Account(StrKey.encodeEd25519PublicKey(Buffer.alloc(32)), "0"),
			{
				fee: "100",
				networkPassphrase: Networks.TESTNET,
			},
		)
			.addOperation(Operation.invokeHostFunction({ func, auth: [recorded] }))
			.setTimeout(30)
			.build(),
		options: { parseResultXdr: (v: xdr.ScVal) => scValToNative(v) as boolean },
	} as unknown as contract.AssembledTransaction<boolean>
	const txHash = "cd".repeat(32)

	/** The device: signs a WebAuthn assertion over the challenge. */
	const authenticator = () => {
		const challenges: Buffer[] = []
		const get = vi.fn(
			async ({
				publicKey,
			}: {
				publicKey: PublicKeyCredentialRequestOptions
			}) => {
				const challenge = Buffer.from(publicKey.challenge as Uint8Array)
				challenges.push(challenge)
				const authenticatorData = Buffer.concat([
					createHash("sha256").update("localhost").digest(),
					Buffer.from([0x05, 0, 0, 0, 1]),
				])
				const clientDataJSON = Buffer.from(
					JSON.stringify({
						type: "webauthn.get",
						challenge: challenge.toString("base64url"),
						origin: "http://localhost:5180",
					}),
				)
				const signed = Buffer.concat([
					authenticatorData,
					createHash("sha256").update(clientDataJSON).digest(),
				])
				return {
					response: {
						authenticatorData: Uint8Array.from(authenticatorData).buffer,
						clientDataJSON: Uint8Array.from(clientDataJSON).buffer,
						signature: Uint8Array.from(
							sign("sha256", signed, device.privateKey),
						).buffer,
					},
				}
			},
		)
		vi.stubGlobal("navigator", { credentials: { get } })
		return { get, challenges }
	}
	const network = (refusal?: string) => {
		const modes: (string | undefined)[] = []
		const server = {
			simulateTransaction: vi.fn(
				async (
					tx: { operations: Operation.InvokeHostFunction[] },
					_: unknown,
					mode?: string,
				) => {
					modes.push(mode)
					if (mode === "enforce")
						return refusal
							? { latestLedger: 1_000, error: refusal }
							: simulated(nativeToScVal(false))
					const method = tx.operations[0]!.func.invokeContract()
						.functionName()
						.toString()
					return method === "capabilities"
						? simulated(
								nativeToScVal(
									{ auth_digest: "addr_oz_v1" },
									{ type: { auth_digest: ["symbol", "symbol"] } },
								),
							)
						: simulated(
								installed([
									{ id: 2, name: "play", contract: app, key: keyData },
									{ id: 3, name: "spend", contract: sac, key: keyData },
								]),
							)
				},
			),
			pollTransaction: vi.fn(async () => ({
				status: rpc.Api.GetTransactionStatus.SUCCESS,
				returnValue: nativeToScVal(false),
			})),
		} as unknown as rpc.Server
		const relayed: { func: string; auth: string[] }[] = []
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init: { body: string }) => {
				const { params } = JSON.parse(init.body) as {
					params: { func: string; auth: string[] }
				}
				relayed.push(params)
				return new Response(
					JSON.stringify({
						success: true,
						data: { transactionId: "t1", hash: txHash, status: "confirmed" },
					}),
				)
			}),
		)
		return { server, modes, relayed }
	}

	it("asks the device once and hands the signed call to Nido's relayer", async () => {
		vi.stubGlobal("window", { location: { hostname: "localhost" } })
		const { get, challenges } = authenticator()
		const { server, modes, relayed } = network()
		const result = await submitWithSession(
			assembled,
			{ account, passkey, grants: [] },
			{ server, networkPassphrase: Networks.TESTNET, relayer: "https://relay" },
		)
		expect(result).toEqual({ result: false, hash: txHash })
		expect(get).toHaveBeenCalledOnce()
		expect(modes).toContain("enforce")
		expect(relayed).toHaveLength(1)
		expect(relayed[0]!.func).toBe(func.toXDR("base64"))

		const [entry] = relayed[0]!.auth.map((a) =>
			xdr.SorobanAuthorizationEntry.fromXDR(a, "base64"),
		)
		const creds = entry!.credentials().address()
		expect(creds.signatureExpirationLedger()).toBe(1_060)
		const [ids, signers] = creds.signature().map()!
		const ruleIds = ids!
			.val()
			.vec()!
			.map((v) => v.u32())
		// One rule per authorized contract, in tree order
		expect(ruleIds).toEqual([2, 3])
		const [signer] = signers!.val().map()!
		const [tag, by, key] = signer!.key().vec()!
		expect(tag!.sym().toString()).toBe("External")
		expect(Address.fromScVal(by!).toString()).toBe(verifier)
		expect(key!.bytes().toString("hex")).toBe(keyData)

		// The challenge is the digest the account recomputes for this entry
		const payload = hash(
			xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
				new xdr.HashIdPreimageSorobanAuthorization({
					networkId: hash(Networks.TESTNET),
					nonce: xdr.Int64.fromString("7"),
					signatureExpirationLedger: 1_060,
					invocation: entry!.rootInvocation(),
				}),
			).toXDR(),
		)
		expect(challenges[0]).toEqual(
			Buffer.from(await authDigest(account, payload, ruleIds, "addr_oz_v1")),
		)
		// …and the signature data is OZ's WebAuthnSigData over it
		const sig = scValToNative(
			xdr.ScVal.fromXDR(signer!.val().bytes()),
		) as Record<string, Buffer>
		expect(JSON.parse(sig.client_data!.toString()).challenge).toBe(
			challenges[0]!.toString("base64url"),
		)
		expect(
			verify(
				"sha256",
				Buffer.concat([
					sig.authenticator_data!,
					createHash("sha256").update(sig.client_data!).digest(),
				]),
				{ key: device.publicKey, dsaEncoding: "ieee-p1363" },
				sig.signature!,
			),
		).toBe(true)
		expect(
			webAuthnSigData({
				authenticatorData: sig.authenticator_data!,
				clientDataJson: sig.client_data!,
				signature: sig.signature!,
			}),
		).toEqual(signer!.val().bytes())
	})
	it("sends nothing when the account refuses, as over the cap", async () => {
		vi.stubGlobal("window", { location: { hostname: "localhost" } })
		authenticator()
		const { server, relayed } = network("HostError: Error(Contract, #3221)")
		const refused = submitWithSession(
			assembled,
			{ account, passkey, grants: [] },
			{ server, networkPassphrase: Networks.TESTNET, relayer: "https://relay" },
		)
		await expect(refused).rejects.toSatisfy(isOverCap)
		expect(relayed).toHaveLength(0)
	})
})

describe("describing errors", () => {
	it("maps account refusals, relayer codes and the app's own errors", () => {
		const errors = { 4: { message: "Already claimed" }, 5: "Sold out" }
		expect(explain(new Error("Error(Contract, #3221)"))).toMatch(/cap/)
		// Still recognisable after submitWithSession has explained it
		expect(isOverCap(new Error(explainRefusal("Error(Contract, #3221)")))).toBe(
			true,
		)
		expect(isOverCap("Error(Contract, #3002)")).toBe(false)
		expect(explain("relay: FEE_LIMIT_EXCEEDED")).toMatch(/budget/)
		expect(explain("POOL_CAPACITY")).toMatch(/busy/)
		const dismissed = Object.assign(new Error("The operation was aborted"), {
			name: "NotAllowedError",
		})
		expect(explain(dismissed)).toMatch(/passkey prompt was dismissed/)
		expect(explain("HostError: Error(Contract, #4)", errors)).toBe(
			"The contract refused: Already claimed",
		)
		expect(explain("Error(Contract, #5)", errors)).toMatch(/Sold out/)
		expect(
			explain("Error(Auth, InvalidAction) Error(Contract, #4)", errors),
		).not.toMatch(/Already claimed/)
		expect(explain("Error(Contract, #9)", errors)).toBe("Error(Contract, #9)")
	})
})
