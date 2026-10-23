import {
	checkAppSession,
	createAppPasskey,
	describe,
	forgetSession,
	requestAppSession,
	type Grant,
	type ResumeResult,
} from "@stellar-scaffold/app-lib"
import { useState, type ReactNode } from "react"
import { useNotification } from "../hooks/useNotification"
import { useSessionStatus } from "../hooks/useSessionStatus"
import { useWallet } from "../hooks/useWallet"

const rules = (n: number) => `${n} ${n === 1 ? "rule" : "rules"}`

/**
 * A Nido account approves an app once, as a session: rules in the account's
 * own policy that let this app's passkey make the listed calls until they
 * expire (see app-lib/session.ts). Shows `children` for classic wallets and
 * once the account's approvals cover `grants`; until then it explains what
 * will be asked, makes the app's passkey on first use, and asks Nido, in one
 * popup and one confirmation, for the grants still missing, expired, or
 * waiting for an answer. With `actionsOnly`, `children` stay visible and only
 * their buttons and inputs are disabled.
 */
export const SessionGate = ({
	grants,
	explain,
	actionsOnly = false,
	children,
}: {
	grants: Grant[]
	explain: ReactNode
	actionsOnly?: boolean
	children: ReactNode
}) => {
	const { address } = useWallet()
	const { addNotification } = useNotification()
	const status = useSessionStatus(address, grants)
	const [busy, setBusy] = useState<string>()
	if (!address || !status || status.state === "ready") return children

	const fail = (error: unknown) => {
		setBusy(undefined)
		addNotification(describe(error), "error")
	}
	const answered = (answer: ResumeResult) => {
		setBusy(undefined)
		if (answer.outcome === "approved")
			addNotification("Nido approved this app's passkey. Ready.", "success")
		if (answer.outcome === "cancelled")
			addNotification("The session request was cancelled", "warning")
		if (answer.outcome === "refused")
			addNotification(answer.message ?? "Nido refused", "error")
		if (answer.outcome === "closed")
			addNotification(
				"Nido's window closed before it answered. Check again to see whether the approval landed.",
				"warning",
			)
	}
	const makePasskey = async () => {
		setBusy("Follow your device's prompt to make a passkey for this app…")
		try {
			await createAppPasskey(address)
			setBusy(undefined)
		} catch (error) {
			fail(error)
		}
	}
	// No await before requestAppSession: the popup needs the click's gesture
	const ask = (toAsk: Grant[]) => {
		try {
			const answer = requestAppSession(address, toAsk)
			setBusy("Approve in the Nido window…")
			void answer.then(answered, fail)
		} catch (error) {
			fail(error)
		}
	}
	const check = async () => {
		setBusy("Checking your account on chain…")
		try {
			const { waiting } = await checkAppSession(address)
			setBusy(undefined)
			if (waiting)
				addNotification(
					"Nothing was applied yet, so it is safe to ask Nido again.",
					"warning",
				)
			else addNotification("Your account has the rules. Ready.", "success")
		} catch (error) {
			fail(error)
		}
	}

	let card: ReactNode
	if (status.state === "waiting") {
		const { waiting, session } = status
		card = (
			<>
				<p>
					Nido has not confirmed{" "}
					{waiting.map((g) => (
						<code key={g.label}>{g.label}</code>
					))}{" "}
					yet. If its window closed or reported an error, check your account
					first: an approval can land even when the page says it couldn&apos;t
					confirm.
				</p>
				{session.refused && <p role="alert">{describe(session.refused)}</p>}
				<div className="session-actions">
					<button type="button" onClick={() => void check()}>
						Check again
					</button>
					<button type="button" onClick={() => ask(waiting)}>
						Ask Nido again ({rules(waiting.length)})
					</button>
					<button type="button" onClick={() => forgetSession(address)}>
						Start over
					</button>
				</div>
			</>
		)
	} else if (!status.passkey)
		card = (
			<>
				{explain}
				<p>
					First your device makes a passkey that only this app uses. Nido then
					asks you to approve what it may do.
				</p>
				<button type="button" onClick={() => void makePasskey()}>
					Make a passkey for this app
				</button>
			</>
		)
	else
		card = (
			<>
				{status.reason === "expired" && (
					<p>This app&apos;s approval expired.</p>
				)}
				{status.reason === "changed" && (
					<p>This needs more than you approved for this app so far.</p>
				)}
				{explain}
				<button type="button" onClick={() => ask(status.ask)}>
					{status.reason === "expired" ? "Renew" : "Approve"} with Nido (
					{rules(status.ask.length)}, one confirmation)
				</button>
			</>
		)

	return (
		<>
			<div className="card session-gate" aria-busy={Boolean(busy)}>
				{busy ? <p role="status">{busy}</p> : card}
			</div>
			{actionsOnly && (
				<fieldset className="session-gated" disabled>
					{children}
				</fieldset>
			)}
		</>
	)
}
