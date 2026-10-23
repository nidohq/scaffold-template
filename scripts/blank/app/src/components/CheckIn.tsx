import { describe, submitCall, type Grant } from "@stellar-scaffold/app-lib"
import { checkIn } from "@stellar-scaffold/app-lib/clients"
import { useEffect, useState } from "react"
import { useWallet } from "../hooks/useWallet"
import { SessionGate } from "./SessionGate"

// `check_in` touches only this contract and moves no money, so a Nido account
// approves one rule, without a spending cap.
const grants: Grant[] = [
	{
		target: checkIn.options.contractId,
		functions: ["check_in"],
		duration: "24h",
		label: "check-in",
	},
]

export const CheckIn = () => {
	const { address } = useWallet()
	const [count, setCount] = useState<number>()
	const [message, setMessage] = useState<string>()
	const [busy, setBusy] = useState(false)

	// Reads simulate and need no signature
	useEffect(() => {
		setCount(undefined)
		if (address)
			void checkIn.count({ who: address }).then(
				(tx) => setCount(tx.result),
				() => setCount(undefined),
			)
	}, [address])

	const onCheckIn = async () => {
		if (!address) return
		setBusy(true)
		setMessage(undefined)
		try {
			// No await before submitCall: Nido's popup needs the click's gesture
			const { result, hash } = await submitCall(address, (publicKey) =>
				checkIn.check_in({ who: address }, { publicKey }),
			)
			setCount(result)
			setMessage(`Checked in. Transaction ${hash}`)
		} catch (error) {
			setMessage(describe(error))
		} finally {
			setBusy(false)
		}
	}

	return (
		<div className="card">
			<h2>Check in</h2>
			<p>
				{!address
					? "Connect a wallet to check in."
					: count === undefined
						? "Reading your check-ins…"
						: `You have checked in ${count} ${count === 1 ? "time" : "times"}.`}
			</p>
			<SessionGate
				grants={grants}
				actionsOnly
				explain={
					<p>
						Nido accounts approve this app once: for 24 hours its own passkey
						may call <code>check_in</code> on this contract, and your device
						asks for it on each check-in. It moves no money, so the rule has no
						spending cap.
					</p>
				}
			>
				<button
					type="button"
					disabled={!address || busy}
					onClick={() => void onCheckIn()}
				>
					Check in
				</button>
			</SessionGate>
			{message && <p role="status">{message}</p>}
		</div>
	)
}
