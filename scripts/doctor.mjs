// `npm run doctor`: check everything this app needs, before it fails halfway
// through a build. Reads only; it changes nothing and spends nothing.
//
//   npm run doctor             # a table, with the fix for each problem
//   npm run doctor -- --json   # machine-readable, for agents and CI
//
// Exits 1 when a check fails; warnings don't fail.
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { createServer } from "node:net"
import { join } from "node:path"
import { parse } from "yaml"
import {
	SCAFFOLD_MIN,
	configHome,
	older,
	root,
	toolEnv,
	toolsBin,
	versionOf,
} from "./tools.mjs"

const RPC = "https://soroban-testnet.stellar.org"
const HORIZON = "https://horizon-testnet.stellar.org"
const json = process.argv.includes("--json")
const checks = []
const check = (id, status, detail, fix) =>
	checks.push({ id, status, detail, ...(fix ? { fix } : {}) })
const read = (file) =>
	existsSync(join(root, file)) ? readFileSync(join(root, file), "utf8") : ""
const run = (command, args) => {
	try {
		return execFileSync(command, args, {
			cwd: root,
			encoding: "utf8",
			env: toolEnv(),
			stdio: ["ignore", "pipe", "ignore"],
		}).trim()
	} catch {
		return undefined
	}
}
const get = async (url, init) => {
	try {
		return await fetch(url, { ...init, signal: AbortSignal.timeout(8000) })
	} catch {
		return undefined
	}
}

// --- Tools -------------------------------------------------------------------

const [major, minor] = process.versions.node.split(".").map(Number)
if (major > 22 || (major === 22 && minor >= 12))
	check("node", "ok", `Node ${process.versions.node}`)
else
	check(
		"node",
		"fail",
		`Node ${process.versions.node}; 22.12 or newer needed`,
		"Install Node 22 LTS or newer",
	)

if (existsSync(join(root, "node_modules", ".package-lock.json")))
	check("npm-install", "ok", "dependencies installed")
else
	check(
		"npm-install",
		"fail",
		"node_modules is missing",
		"npm ci (npm 11 prints allow-scripts warnings; they are harmless)",
	)

const rustc = run("rustc", ["--version"])
const targets = run("rustup", ["target", "list", "--installed"]) ?? ""
if (!rustc)
	check("rust", "fail", "rustc not found", "Install Rust: https://rustup.rs")
else if (!targets.split("\n").includes("wasm32v1-none"))
	check(
		"rust",
		"fail",
		`${rustc}, without the wasm32v1-none target`,
		"rustup target add wasm32v1-none",
	)
else check("rust", "ok", `${rustc} with wasm32v1-none`)

const stellar = versionOf("stellar")
if (stellar) check("stellar-cli", "ok", `stellar ${stellar}`)
else
	check(
		"stellar-cli",
		"fail",
		"the stellar CLI is not installed",
		"https://developers.stellar.org/docs/tools/cli/install-cli",
	)

const scaffold = versionOf("stellar-scaffold")
const local = existsSync(join(toolsBin, "stellar-scaffold"))
if (scaffold && !older(scaffold, SCAFFOLD_MIN))
	check(
		"stellar-scaffold",
		"ok",
		`stellar-scaffold ${scaffold}${local ? " (project-local, .tools/bin)" : " (global)"}`,
	)
else
	check(
		"stellar-scaffold",
		"fail",
		scaffold
			? `stellar-scaffold ${scaffold} is too old: before ${SCAFFOLD_MIN} it ignores scaffold.yml v2 and writes no clients`
			: "stellar-scaffold is not installed",
		"npm run tools:scaffold (downloads the tested release into .tools/, seconds)",
	)

// --- Configuration -----------------------------------------------------------

const env = Object.fromEntries(
	read(".env")
		.split("\n")
		.map((line) => /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line))
		.filter(Boolean)
		.map(([, k, v]) => [k, v]),
)
const network = process.env.STELLAR_NETWORK ?? env.STELLAR_NETWORK
if (!read(".env"))
	check("env", "fail", ".env is missing", "cp .env.example .env")
else if (network !== "testnet")
	check(
		"env",
		"warn",
		`STELLAR_NETWORK=${network ?? "(unset)"}; hosted Nido and this guide use testnet`,
		"Set STELLAR_NETWORK=testnet in .env",
	)
else check("env", "ok", "STELLAR_NETWORK=testnet")

let config = {}
try {
	config = parse(read("scaffold.yml")) ?? {}
} catch (error) {
	check("scaffold-yml", "fail", `scaffold.yml: ${error.message}`)
}
const contracts = Object.entries(config.contracts ?? {})
const unpinned = contracts
	.filter(([, c]) => c.networks?.["testnet-dev"] && !c.networks?.testnet)
	.map(([name]) => name)
if (unpinned.length)
	check(
		"pins",
		"warn",
		`not on testnet yet: ${unpinned.join(", ")} (npm run dev would leave ${unpinned.length === 1 ? "it" : "them"} out of the clients)`,
		"npm run deploy:testnet (deploys, then pins the IDs under testnet: in scaffold.yml)",
	)
else {
	const pinned = contracts.filter(([, c]) => c.networks?.testnet)
	check(
		"pins",
		pinned.length ? "ok" : "warn",
		pinned.length
			? `testnet IDs pinned for ${pinned.map(([name]) => name).join(", ")}`
			: "scaffold.yml lists no contract for testnet",
	)
}

const clients = read("app-lib/clients/index.ts")
const missing = contracts
	.filter(([, c]) => c.networks?.testnet)
	.map(([name]) => name.replace(/-(\w)/g, (_, c) => c.toUpperCase()))
	.filter((name) => !clients.includes(`export const ${name} =`))
if (!clients)
	check(
		"clients",
		"warn",
		"no generated contract clients yet",
		unpinned.length ? "npm run deploy:testnet" : "npm run clients:testnet",
	)
else if (clients.startsWith("// LOCAL PROTOTYPE"))
	check(
		"clients",
		"warn",
		"offline prototype clients (placeholder contract IDs): fine for tests, not for signing",
		"npm run clients:testnet",
	)
else if (missing.length)
	check(
		"clients",
		"warn",
		`clients missing for ${missing.join(", ")}`,
		"npm run clients:testnet",
	)
else check("clients", "ok", "clients generated for the pinned contracts")

const deployer = config.networks?.testnet?.accounts?.[0]
const identity = deployer && join(configHome, "identity", `${deployer}.toml`)
let deployerAddress
if (!deployer)
	check("deployer", "warn", "scaffold.yml names no testnet account")
else if (!existsSync(identity))
	check(
		"deployer",
		"ok",
		`${deployer}: created and funded by Friendbot on the first clients:testnet or deploy:testnet`,
	)
else {
	deployerAddress = run("stellar", ["keys", "address", deployer])
	if (deployerAddress)
		check(
			"deployer",
			"ok",
			`${deployer} = ${deployerAddress} (in .stellar-config)`,
		)
	else check("deployer", "fail", `${deployer} exists but can't be read`)
}

// --- Network -----------------------------------------------------------------

const health = await get(RPC, {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
})
const healthy = health?.ok ? (await health.json()).result : undefined
if (healthy?.status === "healthy")
	check("testnet-rpc", "ok", `${RPC} healthy, ledger ${healthy.latestLedger}`)
else
	check(
		"testnet-rpc",
		"fail",
		`${RPC} unreachable or unhealthy`,
		"Check your connection; https://status.stellar.org",
	)

if (deployerAddress) {
	const account = await get(`${HORIZON}/accounts/${deployerAddress}`)
	if (account?.ok) {
		const xlm = (await account.json()).balances?.find(
			(b) => b.asset_type === "native",
		)?.balance
		check("deployer-funds", "ok", `${deployer} holds ${Number(xlm)} test XLM`)
	} else if (account?.status === 404)
		check(
			"deployer-funds",
			"warn",
			`${deployer} has no account on testnet (a testnet reset?)`,
			`npm run stellar -- keys fund ${deployer} --network testnet`,
		)
}

const nidoBase = "https://test.nido.fyi"
const nido = await get(`${nidoBase}/`)
check(
	"nido",
	nido?.ok ? "ok" : "warn",
	`${nidoBase} ${nido?.ok ? "reachable" : "unreachable"}`,
)

// --- Dev server ----------------------------------------------------------------

const port = Number(process.env.PORT ?? env.PORT) || 5173
const free = await new Promise((resolve) => {
	const server = createServer()
		.once("error", () => resolve(false))
		.once("listening", () => server.close(() => resolve(true)))
		.listen(port, "localhost")
})
check(
	"port",
	free ? "ok" : "warn",
	free
		? `port ${port} is free for npm run dev`
		: `port ${port} is in use (your dev server, or another app)`,
	free
		? undefined
		: "If it isn't this app: set another PORT in .env. Sessions are per origin, so approve again on the new port.",
)

// --- Report --------------------------------------------------------------------

const ok = checks.every((c) => c.status !== "fail")
if (json) console.log(JSON.stringify({ ok, checks }, null, 2))
else {
	const mark = { ok: "✔", warn: "!", fail: "✘" }
	for (const c of checks) {
		console.log(`${mark[c.status]} ${c.id.padEnd(17)} ${c.detail}`)
		if (c.fix) console.log(`  ${" ".repeat(17)} → ${c.fix}`)
	}
	console.log(ok ? "\nReady." : "\nFix the ✘ lines first.")
}
process.exit(ok ? 0 : 1)
