import {
	CapReachedError,
	capReachedUntil,
	describe,
	isOverCap,
	submitCall,
	xlmTokenId,
	type Grant,
	type SubmitStage,
} from "@stellar-scaffold/app-lib"
import { guessTheNumber } from "@stellar-scaffold/app-lib/clients"
import { useState, type FormEvent } from "react"
import { useSessionClock } from "../hooks/useSessionStatus"
import { useWallet } from "../hooks/useWallet"
import { Pending, stageText } from "./Pending"
import { SessionGate } from "./SessionGate"

// A wrong guess calls `guess` and moves 1 XLM from the guesser, so a Nido
// account approves one rule for each contract the call touches, both in one
// confirmation. The XLM rule caps spending at 2 XLM a day: two wrong guesses
// go through, one passkey prompt each, and the account refuses the third. The
// cap's day matches the session's 24 hours, so it is also the most one
// approval can ever spend.
const dailyCap = 2
const grants: Grant[] = [
	{
		target: guessTheNumber.options.contractId,
		functions: ["guess"],
		duration: "24h",
		label: "guess",
	},
	{
		target: xlmTokenId,
		functions: ["transfer"],
		duration: "24h",
		limit: { amount: String(dailyCap), period: "day" },
		label: "guess-xlm",
	},
]

const time = new Intl.DateTimeFormat(undefined, {
	weekday: "short",
	hour: "numeric",
	minute: "2-digit",
})

export const GuessTheNumber = () => {
	const { address, updateBalances } = useWallet()
	// When the account last refused a guess for the cap, until it frees up:
	// say so and keep Submit off, rather than asking the device again
	const now = useSessionClock()
	const capUntil = address ? capReachedUntil(address, grants, now) : undefined
	const [error, setError] = useState<string>()
	const [hash, setHash] = useState<string>()
	const [result, setResult] = useState<"idle" | "success" | "failure">("idle")
	// What a guess under way waits for; undefined when none is
	const [stage, setStage] = useState<SubmitStage>()

	// A submit handler, not a form action: React holds a form action's state
	// updates until it ends, so the progress below would never show.
	const submitGuess = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault()
		const guess = new FormData(event.currentTarget).get("guess")
		if (!address || typeof guess != "string" || !guess) {
			setResult("failure")
			return
		}
		setResult("idle")
		setError(undefined)
		setHash(undefined)
		try {
			// No await before submitCall: Nido's popup needs the click's gesture
			const { result, hash } = await submitCall(
				address,
				(publicKey) =>
					guessTheNumber.guess(
						{ a_number: BigInt(guess), guesser: address },
						{ publicKey },
					),
				{ onStage: setStage },
			)
			setHash(hash)
			if (result.isErr()) {
				setError(result.unwrapErr().message)
				setResult("failure")
			} else {
				setResult(result.unwrap() ? "success" : "failure")
				await updateBalances()
			}
		} catch (e) {
			console.error(e)
			setError(
				e instanceof CapReachedError
					? `That's the ${dailyCap} XLM a day you let this game spend, so the guess stopped before your device was asked or anything was sent. It cost nothing.`
					: isOverCap(e)
						? `That's the ${dailyCap} XLM a day you let this game spend, so your account stopped this guess before anything was sent. It cost nothing. Come back tomorrow for more guesses.`
						: describe(e),
			)
			setResult("failure")
		} finally {
			setStage(undefined)
		}
	}

	const reset = () => {
		setResult("idle")
		setError(undefined)
		setHash(undefined)
	}

	return (
		<div className="guess-the-number">
			<SessionGate
				grants={grants}
				explain={
					<p>
						Each wrong guess costs 1 XLM. Approve this game once and, for 24
						hours, its own passkey can make guesses from your account: your
						device asks for it on each guess, and it can spend at most{" "}
						{dailyCap} XLM a day, so after {dailyCap} wrong guesses your account
						says no. Nido shows you both rules, <code>guess</code> on the game
						and the capped XLM, and you confirm them once.
					</p>
				}
			>
				<form onSubmit={(event) => void submitGuess(event)} aria-busy={!!stage}>
					<input
						placeholder="Guess a number from 1 to 10!"
						id="guess"
						name="guess"
						type="number"
						min="1"
						max="10"
						onChange={reset}
						readOnly={!!stage}
					/>
					<button type="submit" disabled={!!stage || !!capUntil}>
						{stage ? (
							<>
								<span className="spinner" aria-hidden="true" />
								Guessing…
							</>
						) : (
							"Submit"
						)}
					</button>
				</form>
				{stage && <Pending>{stageText[stage]}</Pending>}
				{capUntil && !stage && (
					<p className="session-note" role="status">
						Cap reached
						{capUntil < Number.MAX_SAFE_INTEGER &&
							` until ≈ ${time.format(capUntil)}`}
						: your account lets this game spend {dailyCap} XLM in any 24 hours.
					</p>
				)}

				{/* Inside the gate, so an expired or changed session hides the
				    last result along with the form */}
				{result === "success" && (
					<div className="card guess-result guess-result--success">
						<p>
							You got it! Play again by calling <code>reset</code> in the
							Contract Explorer.
						</p>
					</div>
				)}
				{result === "failure" && (
					<div className="card guess-result guess-result--failure">
						{error ? (
							<p role="alert">{error}</p>
						) : !address ? (
							<p>Connect to your wallet in order to guess.</p>
						) : (
							<p>Incorrect guess: that cost 1 XLM. Try again!</p>
						)}
					</div>
				)}
				{hash && !stage && (
					<p className="session-note">
						Transaction <code>{hash}</code>
					</p>
				)}
			</SessionGate>
		</div>
	)
}
