// @stellar-scaffold/app-lib — shared, framework-agnostic layer for the UI monorepo.
// One authored copy, imported by every template (and by the generated Contract
// Clients in app-lib/clients/index.ts). Framework-specific code (providers,
// stores, UI components) stays in each template.

export * from "./env" // rpcUrl, networkPassphrase, allowHttp, stellarNetwork, network, labPrefix
export * from "./format" // shortAddress, formatNetworkName, networkStatus, NetworkState
export * from "./friendbot" // getFriendbotUrl
export * from "./subscription" // subscribeToEvents
export * from "./wallet" // connectWallet, submitCall, submitContract, createAppPasskey, requestAppSession, resumeAppSession, checkAppSession, xlmTokenId, fetchBalances, …
export { isSmartAccount, transactionSource } from "./nido"
export * from "./session" // sessionStatus, sessionCovers, forgetSession, onSessionChange, describe, Grant, Session, …
