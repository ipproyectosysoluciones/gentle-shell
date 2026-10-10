// The bundled Gentle Shell install (S2, S3, S6, S7): one private prefix with our
// own pinned Node and pnpm (and Go only when asked), every pnpm folder inside it,
// one frozen install per version, an atomic `current`, a launcher and one PATH
// entry. The user's node, npm, pnpm and go are never run, read or changed.
// Shared by the web installer and `gentle-shell upgrade`; every effect outside
// plain path arithmetic goes through an injectable adapter for tests.
import { randomBytes } from "node:crypto";
import { accessSync, chmodSync, closeSync, constants, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync,
	rmSync, symlinkSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { posix, win32 } from "node:path";
import { spawn } from "node:child_process";
import { crc32, gunzipSync, inflateRawSync } from "node:zlib";
import { acquireGo, artifactFor, verifiedDownload } from "./installer-downloads.mjs";
import { ensureWindowsPrivateFolder, readWindowsPnpmArchive, verifyWindowsStorage } from "./installer-windows.mjs";

// The acquisition pins already verified for the installer; never a second copy.
const pins = Object.freeze({ node: artifactFor("node", "linux", "x64").version, pnpm: artifactFor("pnpm").version });
const RUNTIME_MARKER = ".gentle-shell-runtime";
const VERSION_MARKER = ".gentle-shell-version";
const WINDOWS_MARKER = Object.freeze({ marker: ".gentle-shell-bundle", text: "gentle-shell bundled install" });
const LAUNCHER_MARK = "gentle-shell bundled launcher (generated; do not edit)";
const LAUNCHER_MISSING = "gentle-shell: no active Gentle Shell version; run the Gentle Shell installer again.";
const PROFILE_MARK = "# gentle-shell bundled install";
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const VERSION_ID = /^[0-9A-Za-z][0-9A-Za-z.-]*$/;
const MAX_EXPANDED = 512 * 1024 * 1024;
const INSTALL_TIMEOUT = 15 * 60 * 1000;

const pathFor = (platform) => (platform === "win32" ? win32 : posix);
function stat(path) {
	try { return lstatSync(path); }
	catch (error) { if (error.code === "ENOENT" || error.code === "ENOTDIR") return null; throw error; }
}
const regular = (path) => stat(path)?.isFile() === true;
const read = (path) => (regular(path) ? readFileSync(path, "utf8") : null);
/** A value from a Windows environment, whose names are case-insensitive. */
function envValue(env, name, platform) {
	const key = platform === "win32" ? Object.keys(env).find((candidate) => candidate.toUpperCase() === name) : name;
	return key === undefined ? undefined : env[key];
}
/** %LOCALAPPDATA%\gentle-shell, then %USERPROFILE%\.gentle-shell-bundle, as the bootstrap claims its tools. */
function windowsCandidates(env) {
	const usable = (value) => typeof value === "string" && win32.isAbsolute(value) && !value.startsWith("\\\\");
	const local = envValue(env, "LOCALAPPDATA", "win32");
	const profile = envValue(env, "USERPROFILE", "win32");
	return [usable(local) ? win32.join(local, "gentle-shell") : null, usable(profile) ? win32.join(profile, ".gentle-shell-bundle") : null].filter(Boolean);
}

/** Every bundled path, from plain path arithmetic only. POSIX: `~/.gentle-shell`.
 * Windows: `root` as claimPrefix chose it, otherwise the %LOCALAPPDATA% candidate.
 * The agent home stays `<home>/.gentle-shell/agent` on every platform.
 */
export function prefixLayout({ platform, env = {}, home, root }) {
	const path = pathFor(platform);
	if (typeof home !== "string" || !path.isAbsolute(home)) throw new Error("The bundled install needs an absolute home directory");
	const windows = platform === "win32";
	const base = root ?? (windows ? windowsCandidates(env)[0] : path.join(home, ".gentle-shell"));
	if (typeof base !== "string" || !path.isAbsolute(base)) throw new Error("The bundled install has no private folder");
	const runtime = path.join(base, "runtime");
	const nodeDir = path.join(runtime, `node-${pins.node}`);
	const pnpmDir = path.join(runtime, `pnpm-${pins.pnpm}`);
	const pnpmHome = path.join(base, "pnpm");
	const bin = path.join(base, "bin");
	return Object.freeze({
		platform, root: base, agent: path.join(home, ".gentle-shell", "agent"), runtime,
		nodeDir, node: windows ? path.join(nodeDir, "node.exe") : path.join(nodeDir, "bin", "node"),
		pnpmDir, pnpm: path.join(pnpmDir, "package", "bin", "pnpm.mjs"),
		// acquireGo publishes `<goRoot>/<version>/go`.
		goRoot: path.join(runtime, "go"),
		pnpmHome, store: path.join(pnpmHome, "store"), cache: path.join(pnpmHome, "cache"), state: path.join(pnpmHome, "state"),
		config: path.join(pnpmHome, "config"), npmrc: path.join(pnpmHome, "config", "npmrc"), tmp: path.join(base, "tmp"),
		versions: path.join(base, "versions"), history: path.join(base, "versions.history"),
		current: path.join(base, "current"), currentKind: windows ? "pointer" : "symlink",
		bin, launcher: path.join(bin, windows ? "gentle-shell.cmd" : "gentle-shell"),
	});
}

/** POSIX: a real directory owned by this user that no one else can write. */
function privateDirectory(path) {
	const info = stat(path);
	if (!info?.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o022)) throw new Error(`Unsafe bundled prefix: ${path}`);
}
function ensureDirectory(path, platform) {
	try { mkdirSync(path, { mode: 0o700 }); }
	catch (error) { if (error.code !== "EEXIST") throw error; }
	if (platform !== "win32") privateDirectory(path);
}
/** The prefix folders and the empty npmrc pnpm reads instead of ~/.npmrc. */
function prepareFolders(layout) {
	for (const path of [layout.runtime, layout.pnpmHome, layout.store, layout.cache, layout.state, layout.config, layout.versions, layout.bin, layout.tmp]) {
		ensureDirectory(path, layout.platform);
	}
	if (!stat(layout.npmrc)) writeFileSync(layout.npmrc, "", { flag: "wx", mode: 0o600 });
	if (!regular(layout.npmrc)) throw new Error(`Unsafe bundled prefix: ${layout.npmrc}`);
}

/** Claims the prefix and returns its layout. POSIX: `~/.gentle-shell` is created
 * 0700, or kept when it is a real directory of this user that no one else can
 * write (the agent home lives there). Windows: each candidate's nearest existing
 * folder is walked like the bootstrap's tools (owner, ACL, reparse); only an
 * untrusted owner or ACL on %LOCALAPPDATA% moves to the profile candidate. The
 * chosen folder is claimed with the bootstrap's protected DACL and marked
 * (ensureWindowsPrivateFolder); a non-empty unmarked folder is never adopted.
 */
export function claimPrefix({ platform, env = {}, home, adapters = {} }) {
	if (platform !== "win32") {
		const layout = prefixLayout({ platform, env, home });
		if (realpathSync(home) !== posix.resolve(home)) throw new Error(`Unsafe bundled prefix: ${home}`);
		const info = lstatSync(home);
		if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o022)) throw new Error(`Unsafe bundled prefix: ${home}`);
		ensureDirectory(layout.root, platform);
		(adapters.prepare ?? prepareFolders)(layout);
		return layout;
	}
	const exists = adapters.exists ?? ((path) => stat(path) !== null);
	const storage = adapters.storage ?? verifyWindowsStorage;
	const claim = adapters.claim ?? ((folder) => ensureWindowsPrivateFolder(folder, env, { ...WINDOWS_MARKER, storage }));
	const candidates = windowsCandidates(env);
	if (candidates.length === 0) throw new Error("The bundled install has no private folder");
	for (const [index, candidate] of candidates.entries()) {
		let target = candidate;
		while (!exists(target) && win32.dirname(target) !== target) target = win32.dirname(target);
		try {
			storage(target, env);
		} catch (error) {
			if (index + 1 < candidates.length && /^(?:target|parent|ancestor)-(?:owner|acl-mask)$/.test(error?.check ?? "")) continue;
			throw error;
		}
		claim(candidate);
		const layout = prefixLayout({ platform, env, home, root: candidate });
		(adapters.prepare ?? prepareFolders)(layout);
		return layout;
	}
}

/** The one executable a verified Node archive must contain: `<stem>/bin/node`
 * from the POSIX `.tar.gz` or `<stem>/node.exe` from the Windows `.zip`, a
 * regular file found exactly once. Every other member, links included, is
 * skipped and never written: pnpm runs on node alone, so npm is not needed.
 */
export function nodeExecutable(bytes, descriptor) {
	const file = String(descriptor?.url ?? "").split("/").pop();
	const stem = file.replace(/\.(?:tar\.gz|zip)$/, "");
	if (stem === file || !/^node-v\d+\.\d+\.\d+-[a-z0-9]+-[a-z0-9]+$/.test(stem)) throw new Error("Node archive rejected");
	return file.endsWith(".zip") ? zipMember(bytes, `${stem}/node.exe`) : tarMember(bytes, `${stem}/bin/node`);
}
function tarMember(bytes, wanted) {
	let found = null;
	for (const member of tarMembers(bytes, "Node archive rejected")) {
		if (member.name !== wanted) continue;
		if ((member.type !== "0" && member.type !== "\0") || found) throw new Error("Node archive rejected");
		found = Buffer.from(member.data);
	}
	if (!found?.length) throw new Error("Node archive rejected");
	return found;
}
/** Every member of a `.tar.gz`: { name, type, mode, data }. Headers are
 * checksummed; anything malformed throws `message`.
 */
function* tarMembers(bytes, message) {
	const fail = () => { throw new Error(message); };
	const tar = gunzipSync(bytes, { maxOutputLength: MAX_EXPANDED });
	const text = (block, start, length) => block.subarray(start, start + length).toString("utf8").replace(/\0[^]*$/, "");
	const number = (block, start, length) => {
		const value = text(block, start, length).trim();
		if (!/^[0-7]{1,12}$/.test(value)) fail();
		return parseInt(value, 8);
	};
	let renamed = null;
	for (let offset = 0; ;) {
		if (offset + 512 > tar.length) fail();
		const block = tar.subarray(offset, offset + 512);
		if (block.every((byte) => byte === 0)) return;
		let checksum = 0;
		for (let index = 0; index < 512; index += 1) checksum += index >= 148 && index < 156 ? 0x20 : block[index];
		if (checksum !== number(block, 148, 8) || block.subarray(257, 262).toString("latin1") !== "ustar") fail();
		const size = number(block, 124, 12);
		const type = String.fromCharCode(block[156]);
		const start = offset + 512;
		if (start + size > tar.length) fail();
		offset = start + Math.ceil(size / 512) * 512;
		const data = tar.subarray(start, start + size);
		// PAX `path=` records and GNU long names rename the next member only.
		if (type === "x") { renamed = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString("utf8"))?.[1] ?? renamed; continue; }
		if (type === "L") { renamed = data.toString("utf8").replace(/\0[^]*$/, ""); continue; }
		if (type === "g" || type === "K") continue;
		// Only the POSIX ustar format has a name prefix; old GNU keeps times there.
		const prefix = block.subarray(257, 263).toString("latin1") === "ustar\0" ? text(block, 345, 155) : "";
		const name = renamed ?? (prefix ? `${prefix}/${text(block, 0, 100)}` : text(block, 0, 100));
		renamed = null;
		yield { name, type, mode: number(block, 100, 8), data };
	}
}
function zipMember(bytes, wanted) {
	const fail = () => { throw new Error("Node archive rejected"); };
	let end = -1;
	for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at -= 1) {
		if (bytes.readUInt32LE(at) === 0x06054b50 && at + 22 + bytes.readUInt16LE(at + 20) === bytes.length) { end = at; break; }
	}
	if (end < 0) fail();
	const count = bytes.readUInt16LE(end + 10);
	const directory = bytes.readUInt32LE(end + 16);
	if (count === 0xffff || directory === 0xffffffff || directory + bytes.readUInt32LE(end + 12) > end) fail();
	let found = null;
	for (let at = directory, index = 0; index < count; index += 1) {
		if (at + 46 > end || bytes.readUInt32LE(at) !== 0x02014b50) fail();
		const [flags, method, crc, compressed, size] = [bytes.readUInt16LE(at + 8), bytes.readUInt16LE(at + 10), bytes.readUInt32LE(at + 16),
			bytes.readUInt32LE(at + 20), bytes.readUInt32LE(at + 24)];
		const nameLength = bytes.readUInt16LE(at + 28);
		const mode = bytes.readUInt32LE(at + 38) >>> 16;
		const unix = bytes[at + 5] === 3;
		const local = bytes.readUInt32LE(at + 42);
		const name = bytes.subarray(at + 46, at + 46 + nameLength).toString("utf8");
		at += 46 + nameLength + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
		if (name !== wanted) continue;
		if (found || (flags & 0x41) || (method !== 0 && method !== 8) || compressed === 0xffffffff || size === 0xffffffff) fail();
		if (unix && (mode & 0o170000) !== 0o100000) fail();
		if (local + 30 > directory || bytes.readUInt32LE(local) !== 0x04034b50) fail();
		const localName = bytes.readUInt16LE(local + 26);
		const data = local + 30 + localName + bytes.readUInt16LE(local + 28);
		if (bytes.subarray(local + 30, local + 30 + localName).toString("utf8") !== name || data + compressed > directory) fail();
		const raw = bytes.subarray(data, data + compressed);
		const content = method === 0 ? Buffer.from(raw) : inflateRawSync(raw, { maxOutputLength: Math.max(size, 1) });
		if (content.length !== size || crc32(content) !== crc) fail();
		found = content;
	}
	if (!found?.length) fail();
	return found;
}

/** Runs a command without a shell; resolves { status, stdout, stderr }. */
function runCommand(command, args, { cwd, env, timeout = 15000 }) {
	return new Promise((resolve) => {
		const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		const output = { stdout: "", stderr: "" };
		for (const stream of ["stdout", "stderr"]) child[stream].on("data", (chunk) => { output[stream] = (output[stream] + chunk).slice(-1024 * 1024); });
		const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
		child.once("error", () => { clearTimeout(timer); resolve({ status: null, ...output }); });
		child.once("close", (status) => { clearTimeout(timer); resolve({ status, ...output }); });
	});
}
const ownedRuntime = (directory, url, entry) => read(pathFor(process.platform).join(directory, RUNTIME_MARKER)) === `${url}\n` && regular(entry);

/** Publishes one verified runtime as `directory`: an existing one marked with the
 * same pinned URL is reused, an unmarked one is never replaced. `fill` writes and
 * checks the staging folder; one rename publishes it. Renaming is safe here,
 * unlike after a pnpm install: the extracted trees hold regular files and
 * folders only (both archive readers reject links), so nothing points at the
 * staging path.
 */
async function publishRuntime(layout, name, directory, entry, { platform, arch, adapters }, fill) {
	const descriptor = (adapters.artifact ?? artifactFor)(name, platform, arch);
	if (ownedRuntime(directory, descriptor.url, entry)) return false;
	if (stat(directory)) throw new Error(`Conflicting runtime destination: ${directory}`);
	const bytes = await verifiedDownload(name, adapters, platform, arch);
	ensureDirectory(layout.runtime, layout.platform);
	let stage = mkdtempSync(pathFor(process.platform).join(layout.runtime, ".stage-"));
	try {
		await fill(stage, bytes, descriptor);
		writeFileSync(pathFor(process.platform).join(stage, RUNTIME_MARKER), `${descriptor.url}\n`, { flag: "wx", mode: 0o600 });
		if (stat(directory)) throw new Error(`Conflicting runtime destination: ${directory}`);
		renameSync(stage, directory);
		stage = null;
		return true;
	} finally {
		if (stage) rmSync(stage, { recursive: true, force: true });
	}
}

/** Our pinned Node and pnpm in runtime/ (and the pinned Go only when `go`),
 * each downloaded through verifiedDownload, checked by running it from its
 * staging folder, marked, then published. Returns the paths and what was acquired.
 */
export async function ensureRuntime({ layout, platform, arch, go = false, env = {}, adapters = {} }) {
	const run = adapters.run ?? runCommand;
	const path = pathFor(process.platform);
	const childEnv = pnpmEnvironment(layout, { platform: layout.platform, env });
	const acquired = [];
	const node = await publishRuntime(layout, "node", layout.nodeDir, layout.node, { platform, arch, adapters }, async (stage, bytes, descriptor) => {
		const binary = path.join(stage, path.relative(layout.nodeDir, layout.node));
		mkdirSync(path.dirname(binary), { recursive: true, mode: 0o700 });
		writeFileSync(binary, nodeExecutable(bytes, descriptor), { flag: "wx", mode: 0o700 });
		const result = await run(binary, ["--version"], { cwd: layout.runtime, env: childEnv });
		if (result.status !== 0 || String(result.stdout).trim() !== `v${descriptor.version}`) throw new Error("Bundled Node verification failed");
	});
	if (node) acquired.push("node");
	const pnpm = await publishRuntime(layout, "pnpm", layout.pnpmDir, layout.pnpm, { platform, arch, adapters }, async (stage, bytes, descriptor) => {
		// The tarball's executable bits are kept (bin/pnpm.mjs, dist/node-gyp-bin), for the owner only.
		const modes = new Map([...tarMembers(bytes, "pnpm archive rejected")].map((member) => [member.name, member.mode]));
		for (const entry of readWindowsPnpmArchive(bytes)) {
			const target = path.join(stage, ...entry.name.replace(/\/$/, "").split("/"));
			if (entry.directory) mkdirSync(target, { recursive: true, mode: 0o700 });
			else {
				mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
				writeFileSync(target, entry.bytes, { flag: "wx", mode: (modes.get(entry.name) ?? 0) & 0o100 ? 0o700 : 0o600 });
			}
		}
		const metadata = JSON.parse(readFileSync(path.join(stage, "package", "package.json"), "utf8"));
		const entry = path.join(stage, "package", "bin", "pnpm.mjs");
		if (metadata.name !== "pnpm" || metadata.version !== descriptor.version || metadata.bin?.pnpm !== "bin/pnpm.mjs" || !regular(entry)) {
			throw new Error("Bundled pnpm metadata rejected");
		}
		const result = await run(layout.node, [entry, "--version"], { cwd: layout.runtime, env: childEnv });
		if (result.status !== 0 || String(result.stdout).trim() !== descriptor.version) throw new Error("Bundled pnpm verification failed");
	});
	if (pnpm) acquired.push("pnpm");
	let goPath = null;
	if (go) {
		const result = await (adapters.acquireGo ?? acquireGo)({ root: layout.goRoot, platform, arch, adapters });
		goPath = result.goPath;
		if (result.acquired) acquired.push("go");
	}
	return { node: layout.node, pnpm: layout.pnpm, go: goPath, acquired };
}

/** The environment for our pnpm and the scripts it runs: our Node (then our Go,
 * when given) first on PATH; PNPM_HOME, store, cache, state and config inside the
 * prefix through the variables pnpm 11 reads (`pnpm_config_*`, XDG_*); an empty
 * npmrc in place of ~/.npmrc; no switching to the pnpm a package.json above the
 * folder names (pm-on-fail otherwise defaults to "download") or to a Node runtime
 * a root manifest asks to download (runtime-on-fail), and no update check; on
 * Windows TEMP/TMP in the private folder. Every inherited npm/pnpm/Corepack
 * setting, NODE_OPTIONS and NODE_PATH is dropped; the rest (HOME, proxies,
 * SystemRoot) is kept.
 */
export function pnpmEnvironment(layout, { platform = layout.platform, env = {}, go = null } = {}) {
	const windows = platform === "win32";
	const path = pathFor(platform);
	const dropped = new RegExp(`^(?:npm_.*|pnpm_.*|corepack_.*|node_options|node_path|xdg_(?:config|cache|state|data)_home|path${windows ? "|temp|tmp" : ""})$`, "i");
	const kept = Object.fromEntries(Object.entries(env).filter(([key]) => !dropped.test(key)));
	const rest = String(envValue(env, "PATH", platform) ?? "").split(path.delimiter).filter((entry) => entry.length > 0);
	const first = [path.dirname(layout.node), ...(go ? [path.dirname(go)] : [])];
	return {
		...kept,
		[windows ? "Path" : "PATH"]: [...first, ...rest].join(path.delimiter),
		PNPM_HOME: layout.pnpmHome,
		XDG_CONFIG_HOME: layout.config, XDG_CACHE_HOME: layout.cache, XDG_STATE_HOME: layout.state,
		pnpm_config_store_dir: layout.store, pnpm_config_cache_dir: layout.cache, pnpm_config_state_dir: layout.state,
		pnpm_config_npmrc_auth_file: layout.npmrc,
		pnpm_config_pm_on_fail: "ignore", pnpm_config_runtime_on_fail: "ignore", pnpm_config_update_notifier: "false",
		...(windows ? { TEMP: layout.tmp, TMP: layout.tmp } : {}),
	};
}

function versionsOf(manifest) {
	const { shell, pi } = manifest ?? {};
	if (!SEMVER.test(shell ?? "") || !SEMVER.test(pi ?? "")) throw new Error("Distribution manifest version rejected");
	return { shell, pi, id: `${shell}-${pi}` };
}
/** The exact project the release lockfile is built from and installed with:
 * gentle-pi and Pi pinned exactly, and only gentle-pi's build scripts allowed,
 * as the global install allows it. Other dependencies' build scripts are
 * skipped, not fatal (pnpm 11 fails on them by default).
 */
export function distributionFiles(manifest) {
	const { shell, pi } = versionsOf(manifest);
	const project = { name: "gentle-shell-distribution", version: shell, private: true, dependencies: { "gentle-pi": shell, "@earendil-works/pi-coding-agent": pi } };
	return { "package.json": `${JSON.stringify(project, null, "\t")}\n`, "pnpm-workspace.yaml": "allowBuilds:\n  gentle-pi: true\nstrictDepBuilds: false\n" };
}
function versionDirectory(layout, id) {
	if (typeof id !== "string" || !VERSION_ID.test(id) || id.includes("..")) throw new Error("Unsafe version id");
	return pathFor(process.platform).join(layout.versions, id);
}
/** A published version: a real directory whose marker names it. While pnpm
 * runs, the marker reads `installing <id> <pid>` instead.
 */
function installedVersion(layout, id) {
	const directory = versionDirectory(layout, id);
	return stat(directory)?.isDirectory() === true && read(pathFor(process.platform).join(directory, VERSION_MARKER)) === `${id}\n`;
}
function installedPackage(stage, name, expected, label) {
	const path = pathFor(process.platform);
	const directory = realpathSync(path.join(stage, "node_modules", ...name.split("/")));
	if (!directory.startsWith(`${realpathSync(stage)}${path.sep}`)) throw new Error(`Installed ${label} is outside the version folder`);
	const metadata = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8"));
	if (metadata.name !== name || metadata.version !== expected) throw new Error(`Installed ${label} version mismatch: expected ${expected}, found ${metadata.version}`);
	return directory;
}

function processAlive(pid) {
	try { process.kill(pid, 0); return true; }
	catch (error) { return error.code === "EPERM"; }
}
/** The pinned Go acquireGo published under runtime/go: a regular file there. */
function pinnedGo(layout, go) {
	const path = pathFor(layout.platform);
	if (typeof go !== "string" || !path.isAbsolute(go)) return false;
	const relative = path.relative(layout.goRoot, go);
	return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative) && regular(go);
}

/** Installs `<shell>-<pi>` into versions/<shell>-<pi>/ in place: that folder
 * is claimed and marked `installing <id> <pid>` first, the distribution files
 * and the release lockfile are written, our pnpm runs `install --frozen-lockfile`
 * there, the installed gentle-pi and Pi versions are checked exactly, and only
 * then the marker is replaced by `<id>`. The folder is never renamed after pnpm
 * ran: on Windows pnpm links packages with absolute junctions when symlinks are
 * not allowed. An installed version is reused; a folder left by an interrupted
 * install of this id (its process gone) is removed and installed again; any
 * other folder is never replaced. On Windows the pinned Go is required, so
 * gentle-pi's postinstall never builds with the user's go.exe. Adapters (run,
 * and distribution for local fixture packages in place of the registry) are
 * trusted local test code only.
 */
export async function installVersion({ layout, manifest, lockfile, platform = layout.platform, env = {}, go = null, adapters = {} }) {
	const files = (adapters.distribution ?? distributionFiles)(manifest);
	const { shell, pi, id } = versionsOf(manifest);
	const destination = versionDirectory(layout, id);
	const path = pathFor(process.platform);
	const marker = path.join(destination, VERSION_MARKER);
	if (installedVersion(layout, id)) return { id, path: destination, installed: false };
	if (platform === "win32" && !pinnedGo(layout, go)) throw new Error("A Windows version install needs the pinned Go from ensureRuntime({ go: true })");
	if (typeof lockfile !== "string" || lockfile.length === 0) throw new Error("Release lockfile missing");
	const existing = stat(destination);
	if (existing) {
		const pending = existing.isDirectory() ? /^installing (\S+) ([1-9]\d*)\n$/.exec(read(marker) ?? "") : null;
		if (pending?.[1] !== id) throw new Error(`Conflicting version destination: ${destination}`);
		if (processAlive(Number(pending[2]))) throw new Error(`An installation of ${id} is in progress (process ${pending[2]})`);
		rmSync(destination, { recursive: true });
	}
	ensureDirectory(layout.versions, layout.platform);
	// mkdir is the atomic claim: a folder created meanwhile by anyone else fails here.
	mkdirSync(destination, { mode: 0o700 });
	try {
		writeFileSync(marker, `installing ${id} ${process.pid}\n`, { flag: "wx", mode: 0o600 });
		for (const [name, text] of Object.entries({ ...files, "pnpm-lock.yaml": lockfile })) writeFileSync(path.join(destination, name), text, { flag: "wx", mode: 0o600 });
		const result = await (adapters.run ?? runCommand)(layout.node, [layout.pnpm, "install", "--frozen-lockfile"],
			{ cwd: destination, env: pnpmEnvironment(layout, { platform, env, go }), timeout: INSTALL_TIMEOUT });
		if (result.status !== 0) throw Object.assign(new Error("pnpm install failed"), { stderr: String(result.stderr ?? "").slice(-4000) });
		const shellDirectory = installedPackage(destination, "gentle-pi", shell, "gentle-pi");
		installedPackage(destination, "@earendil-works/pi-coding-agent", pi, "Pi");
		if (!regular(path.join(shellDirectory, "bin", "gentle-shell.mjs"))) throw new Error("Installed gentle-pi has no launcher entry");
		replaceAtomically(marker, (temp) => writeFileSync(temp, `${id}\n`, { flag: "wx", mode: 0o600 }));
		return { id, path: destination, installed: true };
	} catch (error) {
		// The folder is this call's own claim: nothing else was ever in it.
		rmSync(destination, { recursive: true, force: true });
		throw error;
	}
}

/** The active version id, or null when `current` is absent. A `current` this
 * module did not write (not our symlink or pointer file) throws.
 */
export function activeVersion(layout) {
	const info = stat(layout.current);
	if (!info) return null;
	const id = layout.currentKind === "symlink"
		? (info.isSymbolicLink() ? /^versions\/([^/]+)$/.exec(readlinkSync(layout.current))?.[1] : undefined)
		: (info.isFile() ? /^([^\r\n]+)\n$/.exec(readFileSync(layout.current, "utf8"))?.[1] : undefined);
	if (id === undefined || !VERSION_ID.test(id)) throw new Error(`Conflicting current: ${layout.current}`);
	return id;
}
function readHistory(layout) {
	return (read(layout.history) ?? "").split("\n").filter((id) => VERSION_ID.test(id) && !id.includes(".."));
}
/** Replaces `path` by one rename of a freshly written sibling. */
function replaceAtomically(path, write) {
	const temp = pathFor(process.platform).join(pathFor(process.platform).dirname(path), `.${pathFor(process.platform).basename(path)}-${randomBytes(6).toString("hex")}`);
	try {
		write(temp);
		renameSync(temp, path);
	} catch (error) {
		if (stat(temp)) unlinkSync(temp);
		throw error;
	}
}

/** Switches `current` to an installed version with one rename (a relative
 * symlink on POSIX, a pointer file on Windows) and records it first in the
 * activation history. Returns { id, previous }.
 */
export function activateVersion(layout, id) {
	versionDirectory(layout, id);
	if (!installedVersion(layout, id)) throw new Error(`${id} is not an installed version`);
	const previous = activeVersion(layout);
	replaceAtomically(layout.current, (temp) => {
		if (layout.currentKind === "symlink") symlinkSync(`versions/${id}`, temp);
		else writeFileSync(temp, `${id}\n`, { flag: "wx", mode: 0o600 });
	});
	const history = [...new Set([id, ...(previous ? [previous] : []), ...readHistory(layout)])];
	replaceAtomically(layout.history, (temp) => writeFileSync(temp, `${history.join("\n")}\n`, { flag: "wx", mode: 0o600 }));
	return { id, previous };
}

/** Deletes installed versions beyond the active one and the most recently
 * activated others, `keep` in all. Nothing is deleted unless `current` names an
 * installed version; the active one, unfinished installs and any folder
 * without our marker are never deleted. Returns the deleted ids.
 */
export function pruneVersions(layout, keep = 2) {
	const active = activeVersion(layout);
	if (!active || !installedVersion(layout, active)) return [];
	const kept = new Set([active]);
	for (const id of readHistory(layout)) if (kept.size < Math.max(keep, 1) && installedVersion(layout, id)) kept.add(id);
	const removed = [];
	for (const name of readdirSync(layout.versions).sort()) {
		if (name.startsWith(".") || kept.has(name) || !VERSION_ID.test(name) || !installedVersion(layout, name)) continue;
		rmSync(versionDirectory(layout, name), { recursive: true });
		removed.push(name);
	}
	if (removed.length > 0) replaceAtomically(layout.history, (temp) => writeFileSync(temp, `${readHistory(layout).filter((id) => !removed.includes(id)).join("\n")}\n`, { flag: "wx", mode: 0o600 }));
	return removed;
}

/** The launcher text: our Node running the current gentle-pi's
 * bin/gentle-shell.mjs, passing every argument and the exit code. Without an
 * active version it says so and exits 1. The Windows one reads the pointer file
 * with delayed expansion off, so `!`, `%`, `^` or `&` in the prefix path stay
 * literal inside its quotes.
 */
export function launcherText(layout) {
	if (layout.platform === "win32") {
		const node = win32.relative(layout.root, layout.node);
		const entry = "%~dp0..\\versions\\%GENTLE_SHELL_CURRENT%\\node_modules\\gentle-pi\\bin\\gentle-shell.mjs";
		return ["@echo off", `rem ${LAUNCHER_MARK}`, "setlocal DisableDelayedExpansion", 'set "GENTLE_SHELL_CURRENT="',
			'if exist "%~dp0..\\current" set /p GENTLE_SHELL_CURRENT=<"%~dp0..\\current"', "if not defined GENTLE_SHELL_CURRENT goto missing",
			`if not exist "${entry}" goto missing`, `"%~dp0..\\${node}" "${entry}" %*`, "exit /b %errorlevel%", ":missing",
			`>&2 echo ${LAUNCHER_MISSING}`, "exit /b 1", ""].join("\r\n");
	}
	const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
	const entry = posix.join(layout.current, "node_modules/gentle-pi/bin/gentle-shell.mjs");
	return ["#!/bin/sh", `# ${LAUNCHER_MARK}`, `if [ ! -f ${quote(entry)} ]; then`, `\techo '${LAUNCHER_MISSING}' >&2`, "\texit 1", "fi",
		`exec ${quote(layout.node)} ${quote(entry)} "$@"`, ""].join("\n");
}
/** Writes bin/gentle-shell (bin/gentle-shell.cmd on Windows). A launcher this
 * module wrote is refreshed; any other file there is never replaced.
 */
export function ensureLauncher(layout) {
	const text = launcherText(layout);
	const existing = stat(layout.launcher);
	if (existing && (!existing.isFile() || !readFileSync(layout.launcher, "utf8").split(/\r?\n/)[1]?.endsWith(LAUNCHER_MARK))) {
		throw new Error(`Conflicting launcher: ${layout.launcher}`);
	}
	if (existing && readFileSync(layout.launcher, "utf8") === text) return { written: false };
	ensureDirectory(layout.bin, layout.platform);
	replaceAtomically(layout.launcher, (temp) => {
		writeFileSync(temp, text, { flag: "wx", mode: 0o755 });
		if (layout.platform !== "win32") chmodSync(temp, 0o755);
	});
	return { written: true };
}

/** The startup file that shell reads for the terminals users open:
 * - zsh: $ZDOTDIR/.zshrc (interactive shells);
 * - bash on macOS, where terminals start login shells: the first of
 *   ~/.bash_profile, ~/.bash_login and ~/.profile that exists, as login bash
 *   reads exactly one of them ("INVOCATION" in bash(1)); ~/.bash_profile only
 *   when none exists, since creating it would hide the user's ~/.profile;
 * - bash elsewhere: ~/.bashrc, what an interactive non-login bash (a Linux
 *   terminal) reads; distributions' ~/.profile sources it for login shells;
 * - fish: our own conf.d file; anything else: ~/.profile.
 */
function profileFor(platform, env, home) {
	const shell = posix.basename(String(env.SHELL ?? ""));
	if (shell === "zsh") return posix.join(posix.isAbsolute(env.ZDOTDIR ?? "") ? env.ZDOTDIR : home, ".zshrc");
	if (shell === "bash" && platform === "darwin") {
		const login = [".bash_profile", ".bash_login", ".profile"].map((name) => posix.join(home, name));
		return login.find((path) => stat(path)) ?? login[0];
	}
	if (shell === "bash") return posix.join(home, ".bashrc");
	if (shell === "fish") return posix.join(posix.isAbsolute(env.XDG_CONFIG_HOME ?? "") ? env.XDG_CONFIG_HOME : posix.join(home, ".config"), "fish", "conf.d", "gentle-shell.fish");
	return posix.join(home, ".profile");
}
/** Whether the installer may edit `path`: "file" (a regular file this user can
 * write, in real folders) or "absent" (creatable inside real, writable folders);
 * otherwise why not: "symlink" (the file or a folder above it under home is a
 * link, as stow, chezmoi and home-manager lay them out), "not-a-file" or
 * "not-writable".
 */
function profileState(path, home) {
	const realHome = realpathSync(home);
	const realFolder = (folder) => {
		const relative = posix.relative(home, folder);
		return relative.startsWith("..") || posix.isAbsolute(relative) || realpathSync(folder) === posix.join(realHome, relative);
	};
	const writable = (target) => {
		try { accessSync(target, constants.W_OK); return true; }
		catch { return false; }
	};
	const info = stat(path);
	if (info) {
		if (info.isSymbolicLink()) return "symlink";
		if (!info.isFile()) return "not-a-file";
		if (!realFolder(posix.dirname(path))) return "symlink";
		return writable(path) ? "file" : "not-writable";
	}
	let folder = posix.dirname(path);
	while (!stat(folder)) {
		if (posix.dirname(folder) === folder) return "not-a-file";
		folder = posix.dirname(folder);
	}
	const existing = stat(folder);
	if (existing.isSymbolicLink()) return "symlink";
	if (!existing.isDirectory()) return "not-a-file";
	if (!realFolder(folder)) return "symlink";
	return writable(folder) ? "absent" : "not-writable";
}
/** Whether `path`, followed through links, already holds `line`. */
function holdsLine(path, line) {
	try { return readFileSync(path, "utf8").split("\n").includes(line); }
	catch { return false; }
}
/** The single PATH change, planned and not applied:
 * - { kind: "none" } when bin/ or our ~/.local/bin link is already on PATH, or
 *   the profile (even through a link) already holds our line;
 * - POSIX { kind: "symlink", path, target }: ~/.local/bin/gentle-shell when
 *   ~/.local/bin is on PATH and that name is free;
 * - POSIX { kind: "profile", path, line, create }: otherwise one marked line in
 *   the shell's startup file (profileFor), only when profileState allows it;
 * - POSIX { kind: "manual", path, line, reason }: that file may not be edited;
 *   the user adds `line` and nothing is written;
 * - Windows { kind: "registry", key, name, entry }: bin/ in the HKCU user Path.
 */
export function pathEntryPlan(layout, { platform = layout.platform, env = {}, home }) {
	if (platform === "win32") {
		const normal = (value) => win32.normalize(value).replace(/(.)\\+$/, "$1").toLowerCase();
		const entries = String(envValue(env, "PATH", platform) ?? "").split(";").filter(Boolean).map(normal);
		if (entries.includes(normal(layout.bin))) return { kind: "none" };
		return { kind: "registry", key: "HKCU\\Environment", name: "Path", entry: layout.bin };
	}
	const entries = String(env.PATH ?? "").split(":").filter(Boolean).map((entry) => posix.normalize(entry).replace(/(.)\/+$/, "$1"));
	if (entries.includes(layout.bin)) return { kind: "none" };
	const localBin = posix.join(home, ".local", "bin");
	if (entries.includes(localBin) && stat(localBin)?.isDirectory()) {
		const link = posix.join(localBin, "gentle-shell");
		const existing = stat(link);
		if (!existing) return { kind: "symlink", path: link, target: layout.launcher };
		if (existing.isSymbolicLink() && readlinkSync(link) === layout.launcher) return { kind: "none" };
	}
	const profile = profileFor(platform, env, home);
	const fish = profile.endsWith(".fish");
	if (fish ? /['\\\n]/.test(layout.bin) : /["\\$`\n]/.test(layout.bin)) throw new Error(`Unsafe bundled bin path for a shell profile: ${layout.bin}`);
	const line = fish ? `set -gx PATH '${layout.bin}' $PATH ${PROFILE_MARK}` : `export PATH="${layout.bin}:$PATH" ${PROFILE_MARK}`;
	if (holdsLine(profile, line)) return { kind: "none" };
	const state = profileState(profile, home);
	if (state === "file" || state === "absent") return { kind: "profile", path: profile, line, create: state === "absent" };
	return { kind: "manual", path: profile, line, reason: state };
}

/** Applies a pathEntryPlan and returns its receipt ({ ...plan, applied }, plus
 * `separator` for a profile line), which removePathEntry needs to revert it
 * exactly. Nothing existing is replaced and nothing is written for "none" or
 * "manual". A profile that changed since the plan (now a link, or created
 * meanwhile) throws. Windows needs an injected `registry` adapter
 * ({ add(entry), remove(entry) }).
 */
export function applyPathEntry(plan, { registry } = {}) {
	if (plan.kind === "symlink") symlinkSync(plan.target, plan.path);
	else if (plan.kind === "profile") {
		const changed = () => new Error(`The shell profile changed since the PATH plan: ${plan.path}`);
		if (plan.create) {
			let folder = posix.dirname(plan.path);
			while (!stat(folder)) folder = posix.dirname(folder);
			if (!stat(folder).isDirectory()) throw changed();
			mkdirSync(posix.dirname(plan.path), { recursive: true });
			// wx: never through a file or link created meanwhile.
			try { writeFileSync(plan.path, `${plan.line}\n`, { flag: "wx", mode: 0o644 }); }
			catch (error) { if (error.code === "EEXIST") throw changed(); throw error; }
			return { ...plan, applied: true, separator: false };
		}
		if (!stat(plan.path)?.isFile()) throw changed();
		const text = readFileSync(plan.path, "utf8");
		if (text.split("\n").includes(plan.line)) return { ...plan, applied: false };
		const separator = text.length > 0 && !text.endsWith("\n");
		// O_NOFOLLOW: a link swapped in after the check above is refused, not followed.
		const fd = openSync(plan.path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
		try { writeSync(fd, `${separator ? "\n" : ""}${plan.line}\n`); }
		finally { closeSync(fd); }
		return { ...plan, applied: true, separator };
	} else if (plan.kind === "registry") {
		if (typeof registry?.add !== "function") throw new Error("The Windows PATH change needs a registry adapter");
		registry.add(plan.entry);
	} else return { ...plan, applied: false };
	return { ...plan, applied: true };
}
/** Reverts an applied receipt: only our symlink, only our exact marked line
 * (with the newline added before it, so the file reads as before), or only our
 * registry entry is removed. A profile applyPathEntry created is deleted when
 * nothing else is left in it. A profile that is no longer a regular file is
 * left alone.
 */
export function removePathEntry(plan, { registry } = {}) {
	if (plan.kind === "symlink") {
		if (stat(plan.path)?.isSymbolicLink() && readlinkSync(plan.path) === plan.target) unlinkSync(plan.path);
	} else if (plan.kind === "profile") {
		const info = stat(plan.path);
		if (!info?.isFile() || !plan.line.endsWith(PROFILE_MARK)) return;
		const lines = readFileSync(plan.path, "utf8").split("\n");
		const index = lines.indexOf(plan.line);
		if (index < 0) return;
		lines.splice(index, 1);
		let text = lines.join("\n");
		if (plan.separator && index === lines.length - 1 && text.endsWith("\n")) text = text.slice(0, -1);
		if (plan.create && text === "") {
			unlinkSync(plan.path);
			return;
		}
		const mode = info.mode & 0o777;
		replaceAtomically(plan.path, (temp) => {
			writeFileSync(temp, text, { flag: "wx", mode });
			chmodSync(temp, mode);
		});
	} else if (plan.kind === "registry") {
		if (typeof registry?.remove !== "function") throw new Error("The Windows PATH change needs a registry adapter");
		registry.remove(plan.entry);
	}
}
