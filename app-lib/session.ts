// Scoped session passkeys for Nido (Perch) smart accounts.
//
// Nido's sign popup approves a call under the account's "admin" rule, and
// Perch scopes that rule to the account itself. So the popup cannot authorize
// a call into any other contract: the account answers
// ContextRuleIdsLengthMismatch (#3014) or UnvalidatedContext (#3002). An app
// acts for a Nido account through a session instead. The app makes a passkey
// of its own, on its own origin, and the owner approves, once and with their
// Nido passkey, Perch rules that let that second passkey call listed functions
// on listed contracts until an expiry, optionally under a rolling spending
// cap. The account enforces those rules on chain for every later call.
//
// The app's passkey is an `External` signer, checked by the same WebAuthn
// verifier as the owner's passkey but only under the approved rules. The
// device asks for it on every call, and its private key never leaves the
// authenticator: the app keeps only the public key and the credential id, so
// nothing in the browser can spend. A passkey-signed call is an ordinary
// authorization entry, so Nido's relayer submits it and pays the fee.
//
// One passkey per account and origin. The grants a gate needs go to Nido in
// one request, which the owner approves with one confirmation. Nido replaces a
// rule with the same name, so asking again for a label renews or changes that
// rule in place.
import {
	accountOrigin,
	openCeremonyPopup,
} from "@nidohq/stellar-wallets-kit-module"
import {
	Account,
	Address,
	Contract,
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

export type GrantDuration = "24h" | "7d" | "30d"
export type LimitPeriod = "day" | "week" | "30d"

/** One rule the owner is asked to approve, as Nido's grant page takes it. */
export interface Grant {
	/** The one contract the passkey may call. A capped grant must name the token. */
	target: string
	/** Functions the passkey may call on `target`; every function when omitted. */
	functions?: string[]
	/** When the rule expires. There is no "never" here on purpose. */
	duration: GrantDuration
	/** A rolling cap on `transfer` amounts, in whole-token decimal (XLM).
	 * Without one, the app tells Nido the rule is uncapped; Nido asks the
	 * owner to accept that unless the rule's functions cannot move tokens. */
	limit?: { amount: string; period: LimitPeriod }
	/** Rule name in the account's policy document, at most 20 bytes. Nido
	 * replaces an existing rule with the same name. */
	label: string
}

/** A grant this app's passkey asked for. */
export interface SessionGrant extends Grant {
	/** When the approved rule runs out, in ms since the epoch; absent until
	 * the owner approves it. */
	expiresAt?: number
}

/** This app's passkey for one account. Public data only: the private key
 * stays in the device's authenticator. */
export interface SessionPasskey {
	/** The WebAuthn credential id, base64url. */
	credentialId: string
	/** The 65-byte uncompressed P-256 public key (`04…`), hex. */
	publicKey: string
}

export interface Session {
	account: string
	/** The app's passkey, which the approved rules name as an `External` signer. */
	passkey: SessionPasskey
	/** Every grant asked for with this passkey, in request order. */
	grants: SessionGrant[]
	/** Why the last approval did not land, as Nido reported it (a code such as
	 * `FEE_LIMIT_EXCEEDED`, or a message). */
	refused?: string
}

/** What a gate should show for the grants it needs. */
export type SessionStatus =
	| { state: "ready"; expiresAt: number }
	| {
			state: "ask"
			/** The grants to ask for: never approved, changed, or expired. */
			ask: Grant[]
			reason: "new" | "changed" | "expired"
			/** Whether this app already has its passkey for the account. Without
			 * one, make it first (`createSessionPasskey`). */
			passkey: boolean
	  }
	| {
			state: "waiting"
			session: Session
			/** Grants sent to Nido with no answer recorded yet. */
			waiting: SessionGrant[]
	  }

/** A rule as the account reports it through `installed_rules()`. */
export interface InstalledRule {
	id: number
	name: string
	/** The contract the rule applies to; `undefined` for any other scope. */
	contract: string | undefined
	/** The rule's `External` signers: verifier contract and key data (hex). */
	external: { verifier: string; key: string }[]
	/** `G…`/`C…` addresses of the rule's `Delegated` signers. */
	delegated: string[]
	/** Last ledger the rule is valid in, or `undefined` for no expiry. */
	validUntil: number | undefined
}

const STORAGE = "scaffold:nido-session:"
const PENDING = `${STORAGE}pending`
const CHANGE = "scaffold:nido-session-change"
const MAX_LABEL_BYTES = 20
/** The most grants Nido's page takes in one request. */
const MAX_GRANTS = 8
/** How long a signed authorization stays valid: about five minutes. */
const AUTH_LIFETIME_LEDGERS = 60
/** Nido turns a duration into ledgers at five seconds each. */
const LEDGER_MS = 5_000
const DURATION_MS: Record<GrantDuration, number> = {
	"24h": 86_400_000,
	"7d": 7 * 86_400_000,
	"30d": 30 * 86_400_000,
}
/** Treat an approval as expired this long before its estimated end, so a
 * call doesn't race the rule's last ledgers. */
const EXPIRY_MARGIN_MS = 120_000
const NEVER = Number.MAX_SAFE_INTEGER
/** A transaction source for read-only simulations; it need not exist. */
const SIMULATION_SOURCE =
	"GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"

// --- Persistence -----------------------------------------------------------
// Only public data sits in this origin's localStorage: the passkey's public
// key and credential id, and what was asked. Origins include the port, so a
// dev server on another port has no session.

export function loadSession(account: string): Session | undefined {
	const raw = localStorage.getItem(STORAGE + account)
	if (!raw) return undefined
	const session = JSON.parse(raw) as Partial<Session>
	// A session from before passkeys held an ed25519 key; it no longer signs.
	return session.passkey ? (session as Session) : undefined
}

function saveSession(session: Session) {
	localStorage.setItem(STORAGE + session.account, JSON.stringify(session))
	changed()
}

export function forgetSession(account: string) {
	localStorage.removeItem(STORAGE + account)
	if (localStorage.getItem(PENDING) === account)
		localStorage.removeItem(PENDING)
	changed()
}

function changed() {
	globalThis.dispatchEvent?.(new Event(CHANGE))
}

/** Call `listener` whenever this tab or another one changes a session. */
export function onSessionChange(listener: () => void): () => void {
	globalThis.addEventListener?.(CHANGE, listener)
	globalThis.addEventListener?.("storage", listener)
	return () => {
		globalThis.removeEventListener?.(CHANGE, listener)
		globalThis.removeEventListener?.("storage", listener)
	}
}

/** The session for `account` when it holds at least one approved, unexpired
 * grant. Whether it covers a particular call is the account's decision. */
export function activeSession(
	account: string,
	now = Date.now(),
): Session | undefined {
	const session = loadSession(account)
	return session?.grants.some((g) => live(g, now)) ? session : undefined
}

// --- Coverage ----------------------------------------------------------------

const live = (g: SessionGrant, now: number) =>
	g.expiresAt !== undefined && g.expiresAt - EXPIRY_MARGIN_MS > now

/** Whether a rule asked for as `held` allows everything `wanted` does. */
function allows(held: Grant, wanted: Grant): boolean {
	if (held.target !== wanted.target) return false
	const functions = held.functions?.length
		? wanted.functions?.length &&
			wanted.functions.every((f) => held.functions!.includes(f))
		: true
	const limit = held.limit
		? wanted.limit?.amount === held.limit.amount &&
			wanted.limit.period === held.limit.period
		: !wanted.limit
	return Boolean(functions) && limit
}

/**
 * How far `session` covers the grants a screen needs at `now`: which of them
 * still have to be asked for (never asked, changed since, or expired), which
 * were sent to Nido without an answer yet, and when the covering approvals
 * run out.
 */
export function sessionCovers(
	session: Session | undefined,
	required: Grant[],
	now = Date.now(),
): {
	ask: Grant[]
	expired: Grant[]
	waiting: SessionGrant[]
	expiresAt: number | undefined
} {
	const ask: Grant[] = []
	const expired: Grant[] = []
	const waiting: SessionGrant[] = []
	let expiresAt: number | undefined
	for (const wanted of required) {
		const held = session?.grants.filter((g) => allows(g, wanted)).at(-1)
		if (!held) ask.push(wanted)
		else if (held.expiresAt === undefined) waiting.push(held)
		else if (!live(held, now)) {
			ask.push(wanted)
			expired.push(wanted)
		} else expiresAt = Math.min(expiresAt ?? NEVER, held.expiresAt)
	}
	return { ask, expired, waiting, expiresAt }
}

/** What a gate needing `required` should show for `account` right now. */
export function sessionStatus(
	account: string,
	required: Grant[],
	now = Date.now(),
): SessionStatus {
	const session = loadSession(account)
	const { ask, expired, waiting, expiresAt } = sessionCovers(
		session,
		required,
		now,
	)
	if (session && waiting.length) return { state: "waiting", session, waiting }
	if (ask.length)
		return {
			state: "ask",
			ask,
			reason: !session?.grants.some((g) => g.expiresAt !== undefined)
				? "new"
				: expired.length === ask.length
					? "expired"
					: "changed",
			passkey: Boolean(session),
		}
	return { state: "ready", expiresAt: expiresAt ?? NEVER }
}

// --- The app's passkey -----------------------------------------------------

const toBase64url = (bytes: Uint8Array) =>
	btoa(String.fromCharCode(...bytes))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "")

const fromBase64url = (text: string) =>
	Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (c) =>
		c.charCodeAt(0),
	)

const toHex = (bytes: Uint8Array) =>
	Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")

const fromHex = (hex: string) =>
	Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16))

const concat = (...parts: Uint8Array[]) => {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
	parts.reduce((at, p) => (out.set(p, at), at + p.length), 0)
	return out
}

const sha256 = async (bytes: Uint8Array) =>
	new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)))

/**
 * Make this app's passkey for `account`: a WebAuthn credential for this
 * page's host, P-256, with user verification (the account's verifier insists
 * on it). The device shows its passkey prompt. Stores only the public key and
 * credential id, replacing any session the app held for the account; ask
 * Nido to approve the passkey next (`requestSession`).
 */
export async function createSessionPasskey(
	account: string,
	appName: string,
): Promise<Session> {
	const { hostname } = window.location
	if (/^[\d.]+$/.test(hostname) || hostname.includes(":"))
		throw new Error(
			`Passkeys need a domain name, not ${hostname}: open this app at localhost instead.`,
		)
	const credential = (await navigator.credentials.create({
		publicKey: {
			challenge: crypto.getRandomValues(new Uint8Array(32)),
			rp: { id: hostname, name: appName },
			user: {
				id: crypto.getRandomValues(new Uint8Array(16)),
				name: `${appName} for ${account.slice(0, 4)}…${account.slice(-4)}`,
				displayName: `${appName} session`,
			},
			pubKeyCredParams: [{ type: "public-key", alg: -7 }],
			authenticatorSelection: {
				residentKey: "preferred",
				userVerification: "required",
			},
			attestation: "none",
		},
	})) as PublicKeyCredential | null
	if (!credential) throw new Error("The passkey was not created")
	const response = credential.response as AuthenticatorAttestationResponse
	const spki = response.getPublicKey()
	if (response.getPublicKeyAlgorithm() !== -7 || !spki)
		throw new Error("This device made a passkey the account cannot verify")
	// A P-256 SubjectPublicKeyInfo ends with the uncompressed point 04‖X‖Y.
	const point = new Uint8Array(spki).slice(-65)
	if (point[0] !== 4) throw new Error("Unexpected passkey public key format")
	const session: Session = {
		account,
		passkey: {
			credentialId: toBase64url(new Uint8Array(credential.rawId)),
			publicKey: toHex(point),
		},
		grants: [],
	}
	saveSession(session)
	return session
}

/** A WebAuthn assertion, as the account's verifier reads it. */
export interface PasskeyAssertion {
	authenticatorData: Uint8Array
	clientDataJson: Uint8Array
	/** `r‖s`, 64 bytes, low-S. */
	signature: Uint8Array
}

/** Ask the device to sign `challenge` with this app's passkey. */
async function signWithPasskey(
	passkey: SessionPasskey,
	challenge: Uint8Array,
): Promise<PasskeyAssertion> {
	const assertion = (await navigator.credentials.get({
		publicKey: {
			challenge: new Uint8Array(challenge),
			rpId: window.location.hostname,
			allowCredentials: [
				{ type: "public-key", id: fromBase64url(passkey.credentialId) },
			],
			userVerification: "required",
			timeout: 120_000,
		},
	})) as PublicKeyCredential | null
	if (!assertion) throw new Error("The passkey did not sign")
	const response = assertion.response as AuthenticatorAssertionResponse
	return {
		authenticatorData: new Uint8Array(response.authenticatorData),
		clientDataJson: new Uint8Array(response.clientDataJSON),
		signature: derToCompact(new Uint8Array(response.signature)),
	}
}

const P256_N =
	0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n

/** An ASN.1 DER ECDSA signature as the 64-byte `r‖s` the host accepts, with
 * `s` in the lower half of the curve order (it refuses high-S). */
export function derToCompact(der: Uint8Array): Uint8Array {
	const int = (at: number) => {
		if (der[at] !== 0x02) throw new Error("Malformed passkey signature")
		const length = der[at + 1]!
		const bytes = der.slice(at + 2, at + 2 + length)
		return { value: BigInt(`0x${toHex(bytes) || "0"}`), end: at + 2 + length }
	}
	if (der[0] !== 0x30) throw new Error("Malformed passkey signature")
	const r = int(2)
	let s = int(r.end).value
	if (s > P256_N / 2n) s = P256_N - s
	return fromHex(
		r.value.toString(16).padStart(64, "0") + s.toString(16).padStart(64, "0"),
	)
}

/** The XDR of OZ's `WebAuthnSigData`, the signature bytes the account's
 * WebAuthn verifier decodes: a struct, so a map with sorted symbol keys. */
export function webAuthnSigData(assertion: PasskeyAssertion): Uint8Array {
	const field = (name: string, bytes: Uint8Array) =>
		new xdr.ScMapEntry({
			key: xdr.ScVal.scvSymbol(name),
			val: nativeToScVal(bytes),
		})
	return xdr.ScVal.scvMap([
		field("authenticator_data", assertion.authenticatorData),
		field("client_data", assertion.clientDataJson),
		field("signature", assertion.signature),
	]).toXDR()
}

// --- Grant requests ----------------------------------------------------------

/**
 * Nido's grant page (`/security/delegate-doc/`) for `grants`, all for this
 * app's passkey: one request, one review, one passkey confirmation by the
 * owner. Every grant in a request shares its duration.
 */
export function grantUrl(args: {
	base: string
	account: string
	passkey: SessionPasskey
	grants: Grant[]
	returnUrl: string
}): string {
	const { base, account, passkey, grants, returnUrl } = args
	if (!StrKey.isValidContract(account))
		throw new Error(`Not a smart account: ${account}`)
	if (!grants.length) throw new Error("A session needs at least one grant")
	if (grants.length > MAX_GRANTS)
		throw new Error(`Nido takes at most ${MAX_GRANTS} grants in one request`)
	if (new Set(grants.map((g) => g.duration)).size > 1)
		throw new Error("The grants in one request share one duration")
	const url = new URL("/security/delegate-doc/", accountOrigin(base, account))
	const set = (key: string, value: string) => url.searchParams.set(key, value)
	set("origin", new URL(returnUrl).origin)
	// Not `credential_id`: Perch's compiler refuses a WebAuthn key with the id
	// appended (KeyNotCanonicalizable), and only this browser needs the id.
	set("pubkey", passkey.publicKey)
	set("duration", grants[0]!.duration)
	grants.forEach((grant, i) => {
		if (new TextEncoder().encode(grant.label).length > MAX_LABEL_BYTES)
			throw new Error(`Grant label "${grant.label}" is over 20 bytes`)
		const field = (name: string, value: string) =>
			set(`grant.${i}.${name}`, value)
		field("label", grant.label)
		field("target", grant.target)
		if (grant.functions?.length) field("functions", grant.functions.join(","))
		if (grant.limit) {
			field("limit", grant.limit.amount)
			field("limit_period", grant.limit.period)
		} else field("limit", "none")
	})
	set("return", returnUrl)
	return url.toString()
}

const asked = ({ target, functions, duration, limit, label }: Grant) => ({
	target,
	...(functions ? { functions } : {}),
	duration,
	...(limit ? { limit } : {}),
	label,
})

export interface ResumeResult {
	account: string
	/** `closed`: Nido's window closed without an answer. The grants wait;
	 * `checkSession` finds out whether they landed. */
	outcome: "approved" | "cancelled" | "refused" | "closed"
	/** For `refused`: what went wrong, in words a person can act on. */
	message?: string
}

/**
 * Ask the owner to approve `grants` for this app's passkey (make it first
 * with `createSessionPasskey`). Nido's grant page opens in a popup, shows every
 * rule, and installs them all with one confirmation of the owner's own
 * passkey. Call it from a click handler before any `await`, so the browser
 * lets the popup open; it resolves with Nido's answer. When the popup is
 * blocked, the page goes to Nido instead, and `resumeSession` reads the
 * answer on the way back. Grants with another duration than the first wait
 * for a second request. Testnet only, like hosted Nido.
 */
export function requestSession(args: {
	account: string
	grants: Grant[]
	base: string
}): Promise<ResumeResult> {
	const { account, grants, base } = args
	const session = loadSession(account)
	if (!session) throw new Error("Make this app's passkey for the account first")
	const batch = grants.filter((g) => g.duration === grants[0]?.duration)
	const back = new URL(window.location.href)
	back.search = ""
	back.hash = ""
	const url = grantUrl({
		base,
		account,
		passkey: session.passkey,
		grants: batch,
		returnUrl: back.toString(),
	})
	const labels = new Set(batch.map((g) => g.label))
	session.grants = [
		...session.grants.filter((g) => !labels.has(g.label)),
		...batch.map(asked),
	]
	delete session.refused
	saveSession(session)
	localStorage.setItem(PENDING, account)
	return openCeremonyPopup(url, new URL(url).origin).then(
		({ search }) => {
			const answer = new URLSearchParams(search)
			return record(
				account,
				answer.get("delegation") ?? undefined,
				answer.get("code") ?? undefined,
			)
		},
		(error: unknown) => {
			const message = error instanceof Error ? error.message : String(error)
			if (message.includes("blocked")) {
				window.location.assign(url)
				// The page is navigating away; never settle.
				return new Promise<never>(() => {})
			}
			if (message.includes("closed")) return { account, outcome: "closed" }
			throw error
		},
	)
}

/** Nido's answer parameters, from the query or the fragment. */
const ANSWER = ["delegation", "code", "retry_after", "payload"]

/**
 * Call once on page load. When the page comes back from Nido's grant page
 * by redirect rather than in a popup, records the answer for the pending
 * session and removes it from the address bar. The answer is `?delegation=`
 * (or `#delegation=`) with:
 *
 * - `ok`: the grants landed.
 * - `cancelled`: the owner said no; unanswered grants are dropped, the
 *   passkey and anything already approved stay.
 * - `error&code=…`: Nido could not apply them (e.g. `FEE_LIMIT_EXCEEDED` when
 *   its relayer's budget is spent); the grants wait for a retry.
 */
export function resumeSession(): ResumeResult | null {
	const url = new URL(window.location.href)
	const hash = new URLSearchParams(url.hash.slice(1))
	const answer = (key: string) =>
		url.searchParams.get(key) ?? hash.get(key) ?? undefined
	const delegation = answer("delegation")
	const account = localStorage.getItem(PENDING)
	if (!delegation || !account) return null
	const code = answer("code")
	for (const key of ANSWER) {
		url.searchParams.delete(key)
		hash.delete(key)
	}
	url.hash = hash.toString()
	window.history.replaceState(null, "", url)
	return record(account, delegation, code)
}

/** Record Nido's answer to the grants waiting for `account`. */
function record(
	account: string,
	delegation: string | undefined,
	code: string | undefined,
): ResumeResult {
	localStorage.removeItem(PENDING)
	const session = loadSession(account)
	const waiting = session?.grants.filter((g) => g.expiresAt === undefined)
	if (!session || !waiting?.length) return { account, outcome: "cancelled" }
	if (delegation === "cancelled") {
		session.grants = session.grants.filter((g) => g.expiresAt !== undefined)
		saveSession(session)
		return { account, outcome: "cancelled" }
	}
	if (delegation !== "ok") {
		session.refused =
			code ?? "Nido could not apply the approval and gave no reason."
		saveSession(session)
		return {
			account,
			outcome: "refused",
			message: describe(session.refused),
		}
	}
	const now = Date.now()
	for (const grant of waiting)
		grant.expiresAt = now + DURATION_MS[grant.duration]
	saveSession(session)
	return { account, outcome: "approved" }
}

/**
 * Read the account's rules and record what actually landed for this app's
 * passkey. Nido's page can report a failure for a grant that went through (a
 * gateway timeout after submission), or close without an answer; the
 * account's installed rules are the truth. Grants found on chain are approved
 * with their real expiry; approved grants whose rule is gone (replaced by
 * another passkey, or never applied) are dropped. Returns how many grants
 * still wait.
 */
export async function checkSession(
	account: string,
	server: rpc.Server,
	networkPassphrase: string,
): Promise<{ approved: number; waiting: number }> {
	const session = loadSession(account)
	if (!session) return { approved: 0, waiting: 0 }
	const { rules, latestLedger } = await readRules(
		account,
		server,
		networkPassphrase,
	)
	const now = Date.now()
	session.grants = session.grants.flatMap((g) => {
		const rule = rules.find(
			(r) =>
				r.name === g.label &&
				r.contract === g.target &&
				signedBy(r, session.passkey),
		)
		if (rule)
			return [
				{
					...g,
					expiresAt:
						rule.validUntil === undefined
							? NEVER
							: now + (rule.validUntil - latestLedger) * LEDGER_MS,
				},
			]
		return g.expiresAt === undefined ? [g] : []
	})
	const waiting = session.grants.filter((g) => g.expiresAt === undefined)
	if (!waiting.length) {
		delete session.refused
		if (localStorage.getItem(PENDING) === account)
			localStorage.removeItem(PENDING)
	}
	saveSession(session)
	return {
		approved: session.grants.length - waiting.length,
		waiting: waiting.length,
	}
}

// --- Authorization -----------------------------------------------------------

/** Contract addresses an auth entry authorizes, in the order the host passes
 * them to `__check_auth`: the root call, then its sub-calls depth first. */
export function authContexts(
	invocation: xdr.SorobanAuthorizedInvocation,
): string[] {
	const fn = invocation.function()
	const own =
		fn.switch().value ===
		xdr.SorobanAuthorizedFunctionType.sorobanAuthorizedFunctionTypeContractFn()
			.value
			? [Address.fromScAddress(fn.contractFn().contractAddress()).toString()]
			: ["create-contract"]
	return [...own, ...invocation.subInvocations().flatMap(authContexts)]
}

/** Whether `passkey` is one of `rule`'s `External` signers. Its key data is
 * the public key, possibly followed by the credential id. */
const signedBy = (rule: InstalledRule, passkey: SessionPasskey) =>
	rule.external.some((s) => s.key.slice(0, 130) === passkey.publicKey)

/**
 * For each context, the rule that lets `passkey` act there. Throws, naming
 * the contract, when no unexpired rule covers a context: the app needs another
 * grant before it can make this call.
 */
export function ruleIdsFor(
	contexts: string[],
	rules: InstalledRule[],
	passkey: SessionPasskey,
	ledger: number,
): number[] {
	return contexts.map((target) => {
		const rule = rules.find(
			(r) =>
				r.contract === target &&
				signedBy(r, passkey) &&
				(r.validUntil === undefined || r.validUntil >= ledger),
		)
		if (!rule)
			throw new Error(
				`This app's session does not cover calls to ${target} (or it expired). Ask for a grant on that contract.`,
			)
		return rule.id
	})
}

/** An `External` signer exactly as the rules installed it. */
export interface ExternalSigner {
	verifier: string
	/** Key data, hex. */
	key: string
}

/** The signers `ruleIds` name for `passkey`, exactly as installed: the
 * account looks them up by their bytes. */
export function passkeySigners(
	ruleIds: number[],
	rules: InstalledRule[],
	passkey: SessionPasskey,
): ExternalSigner[] {
	const found = new Map<string, ExternalSigner>()
	for (const rule of rules)
		if (ruleIds.includes(rule.id))
			for (const signer of rule.external)
				if (signer.key.slice(0, 130) === passkey.publicKey)
					found.set(`${signer.verifier}:${signer.key}`, signer)
	return [...found.values()]
}

/** The `AuthPayload` a Perch account reads from its credential: the rule per
 * context, and the passkey's signature under each of its signer entries. */
export function authPayload(
	ruleIds: number[],
	signers: ExternalSigner[],
	sigData: Uint8Array,
): xdr.ScVal {
	const key = (s: ExternalSigner) =>
		xdr.ScVal.scvVec([
			xdr.ScVal.scvSymbol("External"),
			new Address(s.verifier).toScVal(),
			nativeToScVal(fromHex(s.key)),
		])
	// A map's keys are sorted: by verifier, then key data, in byte order,
	// which their lowercase hex shares.
	const order = (s: ExternalSigner) =>
		[toHex(StrKey.decodeContract(s.verifier)), s.key] as const
	const sorted = [...signers].sort((a, b) => {
		const [x, y] = [order(a), order(b)]
		return x[0] === y[0] ? (x[1] < y[1] ? -1 : 1) : x[0] < y[0] ? -1 : 1
	})
	return xdr.ScVal.scvMap([
		new xdr.ScMapEntry({
			key: xdr.ScVal.scvSymbol("context_rule_ids"),
			val: xdr.ScVal.scvVec(ruleIds.map((id) => xdr.ScVal.scvU32(id))),
		}),
		new xdr.ScMapEntry({
			key: xdr.ScVal.scvSymbol("signers"),
			val: xdr.ScVal.scvMap(
				sorted.map(
					(s) =>
						new xdr.ScMapEntry({
							key: key(s),
							val: nativeToScVal(sigData),
						}),
				),
			),
		}),
	])
}

/** How an account folds rule ids into what a signer signs, as its
 * `capabilities().auth_digest` says: `addr_oz_v1` also binds the account's
 * own address; accounts made before that report `oz_rule_ids`. */
export type DigestScheme = "addr_oz_v1" | "oz_rule_ids"

/** Perch's domain tag for the address binding of `addr_oz_v1`. */
const AUTH_ADDR_DOMAIN = new TextEncoder().encode("perch/account/auth-addr-v1")

/**
 * What the passkey signs for one auth entry, as the account recomputes it in
 * `__check_auth`: the host's `signaturePayload`, bound to the account's
 * address (`addr_oz_v1`), then hashed with the chosen rule ids, so a signature
 * can't be replayed on another account or under other rules.
 */
export async function authDigest(
	account: string,
	signaturePayload: Uint8Array,
	ruleIds: number[],
	scheme: DigestScheme,
): Promise<Uint8Array> {
	const ids = xdr.ScVal.scvVec(
		ruleIds.map((id) => xdr.ScVal.scvU32(id)),
	).toXDR()
	const bound =
		scheme === "addr_oz_v1"
			? await sha256(
					concat(
						AUTH_ADDR_DOMAIN,
						StrKey.decodeContract(account),
						signaturePayload,
					),
				)
			: signaturePayload
	return sha256(concat(bound, ids))
}

type NativeRule = {
	id: number
	name: string
	context_type: unknown
	signers: unknown[]
	valid_until?: number | null
}

/** A contract enum variant as `[tag, ...fields]`, from either shape
 * `scValToNative` produces. */
const variant = (v: unknown): unknown[] | undefined => {
	if (Array.isArray(v) && typeof v[0] === "string") return v
	if (!v || typeof v !== "object") return undefined
	const [tag, fields] = Object.entries(v)[0] ?? []
	return tag === undefined
		? undefined
		: [tag, ...(Array.isArray(fields) ? fields : [fields])]
}

/** Decode `installed_rules()` output (`scValToNative` form). */
export function parseRules(native: NativeRule[]): InstalledRule[] {
	return native.map((rule) => {
		const scope = variant(rule.context_type)
		const signers = rule.signers.map(variant)
		return {
			id: Number(rule.id),
			name: String(rule.name),
			contract: scope?.[0] === "CallContract" ? String(scope[1]) : undefined,
			external: signers.flatMap((s) =>
				s?.[0] === "External"
					? [{ verifier: String(s[1]), key: toHex(s[2] as Uint8Array) }]
					: [],
			),
			delegated: signers.flatMap((s) =>
				s?.[0] === "Delegated" ? [String(s[1])] : [],
			),
			validUntil:
				rule.valid_until === null || rule.valid_until === undefined
					? undefined
					: Number(rule.valid_until),
		}
	})
}

/** The address an unsigned auth entry asks to authorize, if any. */
function credentialAddress(
	entry: xdr.SorobanAuthorizationEntry,
): string | undefined {
	const creds = entry.credentials()
	return creds.switch().name === "sorobanCredentialsAddress"
		? Address.fromScAddress(creds.address().address()).toString()
		: undefined
}

/** Call a read-only function on `account` through a simulation. */
async function read(
	account: string,
	method: string,
	server: rpc.Server,
	networkPassphrase: string,
): Promise<{ value: unknown; latestLedger: number }> {
	const tx = new TransactionBuilder(new Account(SIMULATION_SOURCE, "0"), {
		fee: "100",
		networkPassphrase,
	})
		.addOperation(new Contract(account).call(method))
		.setTimeout(30)
		.build()
	const sim = await server.simulateTransaction(tx)
	if (!rpc.Api.isSimulationSuccess(sim) || !sim.result)
		throw new Error(`Could not read ${method} of ${account}`)
	return {
		value: scValToNative(sim.result.retval),
		latestLedger: sim.latestLedger,
	}
}

/** Read the account's installed rules. */
export async function readRules(
	account: string,
	server: rpc.Server,
	networkPassphrase: string,
): Promise<{ rules: InstalledRule[]; latestLedger: number }> {
	const { value, latestLedger } = await read(
		account,
		"installed_rules",
		server,
		networkPassphrase,
	)
	return { rules: parseRules(value as NativeRule[]), latestLedger }
}

const schemes = new Map<string, Promise<DigestScheme>>()

/** The account's digest scheme, read once per page. */
function digestScheme(
	account: string,
	server: rpc.Server,
	networkPassphrase: string,
): Promise<DigestScheme> {
	let scheme = schemes.get(account)
	if (!scheme) {
		scheme = read(account, "capabilities", server, networkPassphrase).then(
			({ value }) =>
				(value as { auth_digest?: string }).auth_digest === "oz_rule_ids"
					? "oz_rule_ids"
					: "addr_oz_v1",
		)
		scheme.catch(() => schemes.delete(account))
		schemes.set(account, scheme)
	}
	return scheme
}

// --- Errors ------------------------------------------------------------------

/** A generated client's `Errors` table, or your own: code → text. */
export type ContractErrors = Record<number, string | { message: string }>

/** Codes Nido's relayer refuses with. In both cases nothing was submitted. */
const RELAYER: Record<string, string> = {
	FEE_LIMIT_EXCEEDED:
		"Nido's free transaction budget is used up for now, so nothing was sent. Try again later.",
	POOL_CAPACITY:
		"Nido's relayer is busy, so nothing was sent. Try again in a minute.",
}

const OVER_CAP =
	"Your account refused: this would go over the spending cap you gave this app."

/** Whether the account refused a call because it would go over a grant's
 * spending cap (#3221). The account checks before anything is sent, so the
 * refused call cost nothing. */
export function isOverCap(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error)
	return message.includes("#3221") || message.includes(OVER_CAP)
}

function accountRefusal(message: string): string | undefined {
	if (message.includes("#3221")) return OVER_CAP
	if (message.includes("#3002") || message.includes("#3016"))
		return "Your account refused: no approved rule covers this call for this app (it may have expired)."
	if (message.includes("#3014"))
		return "Your account refused: the call touches a contract the app has no rule for."
}

/** Turn the account's refusal codes into something a person can act on. */
export const explainRefusal = (message: string): string =>
	accountRefusal(message) ?? message

/**
 * Say what went wrong in words a person can act on: the account's refusals
 * (#3221 over the cap, #3002/#3016 no rule or expired, #3014 an uncovered
 * contract), Nido relayer codes, a passkey prompt the person dismissed, and
 * your contract's own `Error(Contract, #n)` looked up in `contractErrors` (a
 * generated client's `Errors` export works).
 */
export function describe(
	error: unknown,
	contractErrors?: ContractErrors,
): string {
	const message = error instanceof Error ? error.message : String(error)
	const refusal = accountRefusal(message)
	if (refusal) return refusal
	const relayer = Object.keys(RELAYER).find((code) => message.includes(code))
	if (relayer) return RELAYER[relayer]!
	if (error instanceof Error && error.name === "NotAllowedError")
		return "The passkey prompt was dismissed or timed out, so nothing was signed or sent."
	const own = /Error\(Contract, #(\d+)\)/.exec(message)
	const entry = own && contractErrors?.[Number(own[1])]
	if (entry && !message.includes("Error(Auth"))
		return `The contract refused: ${typeof entry === "string" ? entry : entry.message}`
	return message
}

// --- Submission --------------------------------------------------------------

type RelayerAnswer = {
	transactionId: string | null
	hash: string | null
	status: string | null
}

/** One call to Nido's relayer (`POST <relayer>/relay`, the OpenZeppelin
 * Channels plugin). Its refusals carry a code such as `FEE_LIMIT_EXCEEDED`. */
async function relayerCall(
	relayer: string,
	params: object,
): Promise<RelayerAnswer> {
	const response = await fetch(`${relayer}/relay`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ params }),
	})
	const body = (await response.json().catch(() => ({}))) as {
		success?: boolean
		error?: string | null
		data?: { code?: string; details?: unknown; result?: RelayerAnswer }
	}
	if (body.success === false || !response.ok) {
		const details = body.data?.details
		throw new Error(
			[
				body.data?.code,
				body.error ?? `Nido's relayer answered ${response.status}`,
				details === undefined ? "" : JSON.stringify(details),
			]
				.filter(Boolean)
				.join(": "),
		)
	}
	const answer = body.data?.result ?? (body.data as RelayerAnswer | undefined)
	if (!answer) throw new Error("Nido's relayer gave an empty answer")
	return answer
}

/** Hand `func` and its signed `auth` to Nido's relayer, which pays the fee,
 * and wait until it reports the transaction's hash and verdict. */
async function relay(
	relayer: string,
	func: xdr.HostFunction,
	auth: xdr.SorobanAuthorizationEntry[],
): Promise<string> {
	const sent = await relayerCall(relayer, {
		func: func.toXDR("base64"),
		auth: auth.map((a) => a.toXDR("base64")),
		skipWait: true,
	})
	let last = sent
	// The relayer's transaction is valid for about a minute; wait past it.
	for (let attempt = 0; attempt < 55; attempt++) {
		if (last.status === "confirmed" && last.hash) return last.hash
		if (last.status === "failed" || last.status === "expired")
			throw new Error(
				`Nido's relayer reports the transaction ${last.status}${last.hash ? ` (${last.hash})` : ""}`,
			)
		if (!last.transactionId) break
		await new Promise((resolve) => setTimeout(resolve, 1500))
		last = await relayerCall(relayer, {
			getTransaction: { transactionId: last.transactionId },
		})
	}
	if (last.hash) return last.hash
	throw new Error("Nido's relayer has not confirmed the transaction yet")
}

/**
 * Sign `tx`'s call with this app's passkey under the account's approved
 * rules (the device asks once), hand it to Nido's relayer, and return the
 * confirmed result. The account checks the signature, the rules and any cap
 * in a simulation first, so a refused call is never sent and costs nothing.
 */
export async function submitWithSession<T>(
	tx: contract.AssembledTransaction<T>,
	session: Session,
	network: { server: rpc.Server; networkPassphrase: string; relayer: string },
): Promise<{ result: T; hash: string }> {
	const { server, networkPassphrase, relayer } = network
	if (!tx.built) throw new Error("Simulate the call before submitting it")
	const op = tx.built.operations[0]
	if (op?.type !== "invokeHostFunction")
		throw new Error("A session only signs contract calls")
	const [{ rules, latestLedger }, scheme] = await Promise.all([
		readRules(session.account, server, networkPassphrase),
		digestScheme(session.account, server, networkPassphrase),
	])
	const validUntil = latestLedger + AUTH_LIFETIME_LEDGERS
	const auth: xdr.SorobanAuthorizationEntry[] = []
	for (const recorded of op.auth ?? []) {
		if (credentialAddress(recorded) !== session.account) {
			auth.push(recorded)
			continue
		}
		const entry = xdr.SorobanAuthorizationEntry.fromXDR(recorded.toXDR())
		const ruleIds = ruleIdsFor(
			authContexts(entry.rootInvocation()),
			rules,
			session.passkey,
			latestLedger,
		)
		const creds = entry.credentials().address()
		creds.signatureExpirationLedger(validUntil)
		const signaturePayload = hash(
			xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
				new xdr.HashIdPreimageSorobanAuthorization({
					networkId: hash(networkPassphrase),
					nonce: creds.nonce(),
					signatureExpirationLedger: validUntil,
					invocation: entry.rootInvocation(),
				}),
			).toXDR(),
		)
		const assertion = await signWithPasskey(
			session.passkey,
			await authDigest(session.account, signaturePayload, ruleIds, scheme),
		)
		creds.signature(
			authPayload(
				ruleIds,
				passkeySigners(ruleIds, rules, session.passkey),
				webAuthnSigData(assertion),
			),
		)
		auth.push(entry)
	}

	const signed = new TransactionBuilder(new Account(SIMULATION_SOURCE, "0"), {
		fee: "100",
		networkPassphrase,
	})
		.addOperation(Operation.invokeHostFunction({ func: op.func, auth }))
		.setTimeout(60)
		.build()
	const enforced = await server.simulateTransaction(
		signed,
		undefined,
		"enforce",
	)
	if (!rpc.Api.isSimulationSuccess(enforced))
		throw new Error(explainRefusal(enforced.error))
	const txHash = await relay(relayer, op.func, auth)
	const done = await server.pollTransaction(txHash, { attempts: 30 })
	if (done.status !== rpc.Api.GetTransactionStatus.SUCCESS)
		throw new Error(`Transaction ${txHash} ${done.status.toLowerCase()}`)
	if (!done.returnValue)
		throw new Error(`Transaction ${txHash} has no return value`)
	return { result: tx.options.parseResultXdr(done.returnValue), hash: txHash }
}
