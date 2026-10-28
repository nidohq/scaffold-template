import { type SubmitStage } from "@stellar-scaffold/app-lib"
import { type ReactNode } from "react"

/** What a submission is waiting for, in the words a person reads. */
export const stageText: Record<SubmitStage, string> = {
	preparing: "Preparing…",
	passkey: "Waiting for your passkey…",
	wallet: "Waiting for your wallet…",
	sending: "Sending…",
	confirming: "Confirming on Stellar…",
}

/** A spinner and what the app is waiting for, announced to screen readers
 * as it changes. Render it only while something is under way. */
export const Pending = ({ children }: { children: ReactNode }) => (
	<p className="pending" role="status" aria-live="polite">
		<span className="spinner" aria-hidden="true" />
		{children}
	</p>
)
