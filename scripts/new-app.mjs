// Start a new app from this template checkout:
//
//   npm run new-app -- ../my-app [--name my-app] [--blank] [--port 5310]
//
// `stellar scaffold init --template nidohq/scaffold-template` starts one from
// GitHub; a locally modified checkout of the template needs this instead.
// It copies the template's own files, leaving out installs, build output,
// generated clients, keys, secrets and test artifacts, and makes the copy its
// own, so apps on one machine don't collide: the package name and page title,
// a deployer identity named `<name>-deployer`, and a dev-server port of its
// own (sessions live in the origin's storage, so the port must not
// drift). `--blank` swaps the Guess the Number sample for a one-function
// starter contract, `check-in`, and the matching screen.
import {
	cpSync,
	existsSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path"
import { parseArgs } from "node:util"
import { root as template } from "./tools.mjs"

const usage =
	"usage: npm run new-app -- <directory> [--name <name>] [--blank] [--port <n>]"
let parsed
try {
	parsed = parseArgs({
		allowPositionals: true,
		options: {
			name: { type: "string" },
			blank: { type: "boolean", default: false },
			port: { type: "string" },
		},
	})
} catch (error) {
	fail(`${error.message}\n${usage}`)
}
const { positionals, values } = parsed
if (positionals.length !== 1) fail(usage)
const target = resolve(positionals[0])
const inside = relative(template, target)
if (!inside.startsWith("..") && !isAbsolute(inside))
	fail(`${target} is inside the template; pick a directory outside it.`)
if (existsSync(target) && readdirSync(target).length)
	fail(`${target} is not empty; pick a new or empty directory.`)

const name = values.name ?? basename(target)
if (!/^[a-z][a-z0-9-]{0,39}$/.test(name))
	fail(
		`"${name}" can't name the app: use lowercase letters, digits and dashes, starting with a letter (pass --name).`,
	)
const port = values.port ? Number(values.port) : portFor(name)
if (!Number.isInteger(port) || port < 1024 || port > 65535)
	fail(`--port must be a number from 1024 to 65535`)

const SKIP = new Set([
	".git",
	"node_modules",
	"target",
	"dist",
	".scaffold",
	".stellar-config",
	".tools",
	".env",
	"test-results",
	"playwright-report",
	"screenshots",
])
// Template-only files: the copy is an app, not another template.
const TEMPLATE_ONLY = [
	"CHANGELOG.md",
	"CONTRIBUTING.md",
	join("scripts", "new-app.mjs"),
	join("scripts", "new-app.test.ts"),
	join("scripts", "blank"),
]
cpSync(template, target, {
	recursive: true,
	filter: (src) => {
		const rel = relative(template, src)
		if (!rel) return true
		const parts = rel.split(sep)
		if (SKIP.has(parts[0]) || parts.includes("node_modules")) return false
		if (TEMPLATE_ONLY.some((t) => rel === t || rel.startsWith(t + sep)))
			return false
		// Generated clients belong to whoever builds the new app.
		if (rel.startsWith(join("app-lib", "clients", "")))
			return rel.endsWith(".gitkeep")
		return !rel.endsWith(".tsbuildinfo")
	},
})

const at = (file) => join(target, file)
const edit = (file, change) =>
	writeFileSync(at(file), change(readFileSync(at(file), "utf8")))
const editJson = (file, change) =>
	edit(file, (text) => {
		const json = JSON.parse(text)
		change(json)
		return `${JSON.stringify(json, null, 2)}\n`
	})

editJson("package.json", (manifest) => {
	manifest.name = name
	delete manifest.scripts["new-app"]
})
editJson("package-lock.json", (lock) => {
	lock.name = name
	lock.packages[""].name = name
})
edit("scaffold.yml", (yml) =>
	yml.replaceAll("testnet-user", `${name}-deployer`),
)
edit("app/index.html", (html) =>
	html.replace(/<title>.*<\/title>/, `<title>${name}</title>`),
)
edit(".env.example", (env) => env.replace(/^PORT=.*$/m, `PORT=${port}`))
writeFileSync(at(".env"), readFileSync(at(".env.example")))

if (values.blank) blank()

const where = relative(process.cwd(), target) || "."
console.log(`Created ${target} (app "${name}", dev server on port ${port})

Next:
  cd ${where}
  npm run tools:scaffold     # project-local stellar-scaffold, seconds
  npm ci
  npm run doctor             # checks tools, testnet, keys and clients
${
	values.blank
		? "  npm run deploy:testnet     # deploys contracts/check-in, pins its ID, writes the client"
		: "  npm run clients:testnet    # client for the shared Guess the Number deployment"
}
  npm run dev                # http://localhost:${port}

NIDO.md is the guide: the call pattern, your own contract in five steps, and
what to do when Nido's relayer says no. AGENTS.md is the same for coding agents.`)

/** Swap the Guess the Number sample for the check-in starter. */
function blank() {
	const from = (file) => join(template, "scripts", "blank", file)
	for (const dir of [
		"guess-the-number",
		"fungible-allowlist",
		"nft-enumerable",
	])
		rmSync(at(`contracts/${dir}`), { recursive: true, force: true })
	cpSync(from("contracts/check-in"), at("contracts/check-in"), {
		recursive: true,
	})
	rmSync(at("app/src/components/GuessTheNumber.tsx"))
	rmSync(at("e2e/tests/guess.spec.ts"))
	cpSync(
		from("app/src/components/CheckIn.tsx"),
		at("app/src/components/CheckIn.tsx"),
	)
	writeFileSync(
		at("app/src/pages/Home.tsx"),
		readFileSync(from("app/src/pages/Home.tsx"), "utf8").replace(
			"__APP_NAME__",
			name,
		),
	)
	edit("scaffold.yml", (yml) => {
		const start = yml.search(/^(# .*\n)*contracts:/m)
		return `${yml.slice(0, start)}${readFileSync(from("contracts.yml"), "utf8")}`
	})
	edit(".github/workflows/contract-release.yml", (yml) =>
		yml.replaceAll("guess-the-number", "check-in"),
	)
	editJson("package-lock.json", (lock) => {
		delete lock.packages["app-lib/clients/guess-the-number"]
		delete lock.packages["node_modules/guess-the-number"]
	})
	// Cargo.lock still lists the samples' crates; cargo prunes them on the
	// first build.
}

/** A stable port per app name, so two apps on one machine rarely meet. */
function portFor(text) {
	let hash = 2166136261
	for (const c of text) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619)
	return 5200 + ((hash >>> 0) % 700)
}

function fail(message) {
	console.error(message)
	process.exit(1)
}
