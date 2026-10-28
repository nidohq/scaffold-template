import {
	activeSession,
	forgetSession,
	isSmartAccount,
} from "@stellar-scaffold/app-lib"
import { useSessionClock } from "../hooks/useSessionStatus"
import { useWallet } from "../hooks/useWallet"

const time = new Intl.DateTimeFormat(undefined, {
	weekday: "short",
	hour: "numeric",
	minute: "2-digit",
})

/** One line, once per page, while this app's passkey holds an approved
 * session for the connected Nido account. */
export const SessionNote = () => {
	const { address } = useWallet()
	const now = useSessionClock()
	const session =
		address && isSmartAccount(address) ? activeSession(address, now) : undefined
	if (!address || !session) return null
	const until = Math.min(
		...session.grants.flatMap((g) =>
			g.expiresAt && g.expiresAt > now ? [g.expiresAt] : [],
		),
	)
	return (
		<p className="session-note">
			This app&apos;s passkey may act for your account
			{until < Number.MAX_SAFE_INTEGER &&
				`, approved until ${time.format(until)}`}
			, asking your device each time.{" "}
			<button
				type="button"
				title="This browser forgets the app's passkey; your device may still list it. The rules stay on your account until they expire; approving again with a new passkey replaces them."
				onClick={() => forgetSession(address)}
			>
				Forget it
			</button>
		</p>
	)
}
