import { expect, test, type Page } from "@playwright/test"
import { createHash, createPublicKey, verify } from "node:crypto"
import {
	Address,
	Asset,
	Networks,
	nativeToScVal,
	scValToNative,
	xdr,
} from "@stellar/stellar-sdk"
import {
	account,
	accountAuth,
	connect,
	invocation,
	mockServices,
	verifier,
	virtualAuthenticator,
	type GrantAnswer,
} from "./mocks"

// The Guess the Number sample: a Nido account approves the game's own
// passkey once, then each guess asks the device and nothing else.
// `npm run new-app -- --blank` removes this file with the sample.

const sac = Asset.native().contractId(Networks.TESTNET)
const makePasskey = "Make a passkey for this app"
const approve = "Approve with Nido (2 rules, one confirmation)"

/** The account's auth for a losing guess: `guess`, then 1 XLM to the game. */
const guessAuth = (method: string, game: string) => {
	if (method !== "guess") return []
	const me = new Address(account).toScVal()
	return [
		accountAuth(
			invocation(
				game,
				"guess",
				[nativeToScVal(3, { type: "u64" }), me],
				[
					invocation(sac, "transfer", [
						me,
						new Address(game).toScVal(),
						nativeToScVal(10_000_000n, { type: "i128" }),
					]),
				],
			),
		),
	]
}

/** Count the app's requests for a passkey signature. */
const countPrompts = (page: Page) =>
	page.addInitScript(() => {
		const w = window as unknown as { prompts: number }
		w.prompts = 0
		const get = navigator.credentials.get.bind(navigator.credentials)
		navigator.credentials.get = (options) => {
			w.prompts++
			return get(options)
		}
	})
const prompts = (page: Page) =>
	page.evaluate(() => (window as unknown as { prompts: number }).prompts)

/** Guess `n`; a number other than the last one clears the last result. */
async function guess(page: Page, n: number, expected = "You got it!") {
	await page.getByPlaceholder("Guess a number from 1 to 10!").fill(String(n))
	await page.getByRole("button", { name: "Submit", exact: true }).click()
	await expect(page.locator(".guess-result")).toContainText(expected)
}

/** Make the game's passkey and approve it in Nido's popup. */
async function approveOnce(page: Page) {
	await page.getByRole("button", { name: makePasskey }).click()
	const popup = page.waitForEvent("popup")
	await page.getByRole("button", { name: approve }).click()
	await popup
	await expect(page.getByText("This app's passkey may act")).toBeVisible()
}

test("the guess form is on the home page", async ({ page }) => {
	await page.goto("/")
	await expect(
		page.getByPlaceholder("Guess a number from 1 to 10!"),
	).toBeVisible()
	await expect(page.getByRole("button", { name: "Submit" })).toBeVisible()
})

test("a Nido account approves the game's passkey once, then each guess asks only the device", async ({
	page,
	context,
}) => {
	const { requests, relayed, sent } = await mockServices(context, {
		auth: guessAuth,
	})
	const credentials = await virtualAuthenticator(page)
	await countPrompts(page)
	await connect(page)
	await expect(
		page.getByPlaceholder("Guess a number from 1 to 10!"),
	).toHaveCount(0)
	await approveOnce(page)
	expect(page.url()).not.toContain("delegation")

	// One request, one rule per contract a losing guess touches, both for the
	// passkey the device just made; only the XLM rule is capped
	expect(requests).toHaveLength(1)
	const [game, xlm] = requests[0]!
	const [credential] = await credentials()
	const publicKey = createPublicKey({
		key: Buffer.from(credential!.privateKey, "base64"),
		format: "der",
		type: "pkcs8",
	})
	const pubkey = publicKey
		.export({ format: "der", type: "spki" })
		.subarray(-65)
		.toString("hex")
	expect(game).toEqual({
		pubkey,
		duration: "24h",
		label: "guess",
		target: expect.stringMatching(/^C/),
		functions: "guess",
		limit: "none",
	})
	expect(xlm).toEqual({
		pubkey,
		duration: "24h",
		label: "guess-xlm",
		target: sac,
		functions: "transfer",
		limit: "2",
		limit_period: "day",
	})
	// Nothing secret in the browser: the passkey's public half only
	const stored = await page.evaluate(
		(a) => localStorage.getItem(`scaffold:nido-session:${a}`),
		account,
	)
	expect(stored).toContain(pubkey)
	expect(stored).not.toMatch(/secret|"S[A-Z2-7]{55}"/)

	let popups = 0
	page.on("popup", () => popups++)
	await guess(page, 3)
	expect(await prompts(page)).toBe(1)
	expect(popups).toBe(0)
	await expect(page.getByText(/^Transaction [0-9a-f]{64}$/)).toBeVisible()

	// Nido's relayer submits; the app sends no transaction of its own
	expect(relayed).toHaveLength(1)
	expect(sent).toHaveLength(0)
	const [entry] = relayed[0]!.auth.map((a) =>
		xdr.SorobanAuthorizationEntry.fromXDR(a, "base64"),
	)
	const creds = entry!.credentials().address()
	const [ids, signers] = creds.signature().map()!
	// The approved rule for each authorized contract, in tree order
	expect(
		ids!
			.val()
			.vec()!
			.map((id) => id.u32()),
	).toEqual([2, 3])
	const [signer] = signers!.val().map()!
	const [tag, by, key] = signer!.key().vec()!
	expect(tag!.sym().toString()).toBe("External")
	expect(Address.fromScVal(by!).toString()).toBe(verifier)
	expect(key!.bytes().toString("hex")).toBe(pubkey)
	// The browser's own WebAuthn assertion, which the verifier checks
	const sig = scValToNative(xdr.ScVal.fromXDR(signer!.val().bytes())) as Record<
		string,
		Buffer
	>
	const client = JSON.parse(sig.client_data!.toString()) as Record<
		string,
		string
	>
	expect(client).toMatchObject({
		type: "webauthn.get",
		origin: new URL(page.url()).origin,
	})
	expect(sig.authenticator_data![32]! & 0x05).toBe(0x05) // present, verified
	expect(
		verify(
			"sha256",
			Buffer.concat([
				sig.authenticator_data!,
				createHash("sha256").update(sig.client_data!).digest(),
			]),
			{ key: publicKey, dsaEncoding: "ieee-p1363" },
			sig.signature!,
		),
	).toBe(true)

	await guess(page, 5)
	expect(await prompts(page)).toBe(2)
	expect(popups).toBe(0)
	await page.screenshot({
		path: "../screenshots/nido-session.png",
		fullPage: true,
	})
})

test("over the 2 XLM cap, the account refuses, nothing is sent, and the player is told why", async ({
	page,
	context,
}) => {
	let overCap = false
	const { relayed } = await mockServices(context, {
		auth: guessAuth,
		refuse: () => (overCap ? "HostError: Error(Contract, #3221)" : undefined),
	})
	await virtualAuthenticator(page)
	await connect(page)
	await approveOnce(page)
	await guess(page, 3)
	await guess(page, 5)
	expect(relayed).toHaveLength(2)

	overCap = true
	await guess(page, 7, "the 2 XLM a day you let this game spend")
	await expect(page.getByRole("alert")).toContainText("It cost nothing")
	expect(relayed).toHaveLength(2)
})

test("a cancelled approval keeps the game's passkey for the next try", async ({
	page,
	context,
}) => {
	let cancel = true
	const { requests } = await mockServices(context, {
		grantAnswer: () =>
			cancel
				? { answer: "?delegation=cancelled", landed: false }
				: { answer: "?delegation=ok", landed: true },
	})
	const credentials = await virtualAuthenticator(page)
	await connect(page)
	await page.getByRole("button", { name: makePasskey }).click()
	await page.getByRole("button", { name: approve }).click()
	await expect(
		page.getByText("The session request was cancelled"),
	).toBeVisible()
	cancel = false
	await page.getByRole("button", { name: approve }).click()
	await expect(page.getByText("This app's passkey may act")).toBeVisible()
	// One passkey, named by both requests
	expect(await credentials()).toHaveLength(1)
	expect(new Set(requests.flat().map((g) => g.pubkey)).size).toBe(1)
})

test("when Nido's relayer refuses, the app says so and can check the chain", async ({
	page,
	context,
}) => {
	// Nido's page fails to confirm, but the rules landed (a gateway timeout
	// after submission)
	const grantAnswer: GrantAnswer = () => ({
		answer: "?delegation=error&code=FEE_LIMIT_EXCEEDED",
		landed: true,
	})
	await mockServices(context, { grantAnswer })
	await virtualAuthenticator(page)
	await connect(page)
	await page.getByRole("button", { name: makePasskey }).click()
	await page.getByRole("button", { name: approve }).click()
	await expect(page.getByRole("alert").first()).toContainText(
		"budget is used up",
	)
	await expect(page.getByText(/Nido has not confirmed/)).toContainText(
		"guess-xlm",
	)
	await page.getByRole("button", { name: "Check again" }).click()
	await expect(page.getByText("This app's passkey may act")).toBeVisible()
	await expect(
		page.getByPlaceholder("Guess a number from 1 to 10!"),
	).toBeVisible()
})
