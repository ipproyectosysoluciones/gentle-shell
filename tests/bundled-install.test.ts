import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import test, { type TestContext } from "node:test";
import { crc32, gzipSync } from "node:zlib";
import { activateVersion, activeVersion, applyPathEntry, claimPrefix, distributionFiles, ensureLauncher, ensureRuntime, installVersion, nodeExecutable,
	pathEntryPlan, pnpmEnvironment, prefixLayout, pruneVersions, removePathEntry } from "../scripts/bundled-install.mjs";

// Real directories, modes, symlinks and uids need a POSIX host.
const posixHost = process.platform === "win32" ? "POSIX filesystem fixtures need a POSIX host" : false;
const posixTest = (name: string, fn: (t: TestContext) => void | Promise<void>) => test(name, { skip: posixHost }, fn);
const NODE = "24.21.0";
const PNPM = "11.1.1";

function home() {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "bundled-install-"));
	const dir = join(root, "home ü");
	mkdirSync(dir, { mode: 0o700 });
	return dir;
}
function claimed(platform = "darwin") {
	const user = home();
	return { home: user, layout: claimPrefix({ platform, env: { HOME: user }, home: user }) };
}

// A ustar member, as the Node and pnpm tarballs carry them.
function tarEntry(name: string, { type = "0", data = Buffer.alloc(0), link = "" } = {}) {
	const header = Buffer.alloc(512);
	header.write(name, 0, 100, "utf8");
	header.write("0000755\0", 100);
	header.write("0000000\0", 108);
	header.write("0000000\0", 116);
	header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
	header.write("00000000000\0", 136);
	header.write("        ", 148);
	header.write(type, 156);
	header.write(link, 157, 100);
	header.write("ustar\u000000", 257);
	let sum = 0;
	for (const byte of header) sum += byte;
	header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
	return Buffer.concat([header, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}
const tarGz = (entries: Buffer[]) => gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
// A stored (uncompressed) zip, as small as the Windows Node archive's shape allows.
function zip(files: [string, Buffer][]) {
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;
	for (const [name, data] of files) {
		const bytes = Buffer.from(name);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc32(data), 14);
		local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(bytes.length, 26);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc32(data), 16);
		central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(bytes.length, 28); central.writeUInt32LE(offset, 42);
		locals.push(local, bytes, data);
		centrals.push(central, bytes);
		offset += 30 + bytes.length + data.length;
	}
	const directory = Buffer.concat(centrals);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
	end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, directory, end]);
}

const nodeStem = `node-v${NODE}-darwin-arm64`;
const nodeBytes = Buffer.from("#!/bin/sh\necho fixture node\n");
const nodeArchive = tarGz([
	tarEntry(`${nodeStem}/`, { type: "5" }),
	tarEntry(`${nodeStem}/bin/`, { type: "5" }),
	tarEntry(`${nodeStem}/bin/node`, { data: nodeBytes }),
	// Links and every other member are skipped, never written.
	tarEntry(`${nodeStem}/bin/npm`, { type: "2", link: "../lib/node_modules/npm/bin/npm-cli.js" }),
	tarEntry(`${nodeStem}/lib/node_modules/npm/package.json`, { data: Buffer.from("{}") }),
]);
const pnpmArchive = tarGz([
	tarEntry("package/package.json", { data: Buffer.from(JSON.stringify({ name: "pnpm", version: PNPM, engines: { node: ">=22.13" }, bin: { pnpm: "bin/pnpm.mjs" } })) }),
	tarEntry("package/bin/pnpm.mjs", { data: Buffer.from("// fixture pnpm\n") }),
]);
const archives: Record<string, Buffer> = { node: nodeArchive, pnpm: pnpmArchive };
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function adapters(overrides: Record<string, unknown> = {}) {
	const calls: { downloads: string[]; runs: { command: string; args: string[]; cwd: string; env: Record<string, string> }[] } = { downloads: [], runs: [] };
	return {
		calls,
		adapters: {
			artifact: (name: string) => ({ name, version: name === "node" ? NODE : PNPM, maxBytes: 1 << 20, integrity: `sha256-${sha256(archives[name])}`,
				url: name === "node" ? `https://nodejs.org/dist/v${NODE}/${nodeStem}.tar.gz` : `https://registry.npmjs.org/pnpm/-/pnpm-${PNPM}.tgz` }),
			download: async (descriptor: { name: string }) => { calls.downloads.push(descriptor.name); return archives[descriptor.name]; },
			run: (command: string, args: string[], options: { cwd: string; env: Record<string, string> }) => {
				calls.runs.push({ command, args, ...options });
				if (args.length === 1 && args[0] === "--version") return { status: 0, stdout: `v${NODE}\n`, stderr: "" };
				if (args[1] === "--version") return { status: 0, stdout: `${PNPM}\n`, stderr: "" };
				return { status: 1, stdout: "", stderr: "unexpected" };
			},
			...overrides,
		},
	};
}

// Rule 1: one prefix with every folder inside it.
test("prefixLayout puts every bundled folder under ~/.gentle-shell on POSIX", () => {
	const layout = prefixLayout({ platform: "linux", env: {}, home: "/home/me" });
	const root = "/home/me/.gentle-shell";
	assert.equal(layout.root, root);
	assert.equal(layout.agent, `${root}/agent`);
	assert.equal(layout.node, `${root}/runtime/node-${NODE}/bin/node`);
	assert.equal(layout.pnpm, `${root}/runtime/pnpm-${PNPM}/package/bin/pnpm.mjs`);
	assert.equal(layout.goRoot, `${root}/runtime/go`);
	assert.deepEqual([layout.pnpmHome, layout.store, layout.cache, layout.state, layout.config],
		["pnpm", "pnpm/store", "pnpm/cache", "pnpm/state", "pnpm/config"].map((folder) => `${root}/${folder}`));
	assert.equal(layout.versions, `${root}/versions`);
	assert.equal(layout.current, `${root}/current`);
	assert.equal(layout.currentKind, "symlink");
	assert.equal(layout.launcher, `${root}/bin/gentle-shell`);
	assert.throws(() => prefixLayout({ platform: "linux", env: {}, home: "relative" }), /home/i);
});

test("prefixLayout uses the Windows private folder and a pointer file for current", () => {
	const env = { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local", USERPROFILE: "C:\\Users\\me" };
	const layout = prefixLayout({ platform: "win32", env, home: "C:\\Users\\me" });
	const root = "C:\\Users\\me\\AppData\\Local\\gentle-shell";
	assert.equal(layout.root, root);
	assert.equal(layout.agent, "C:\\Users\\me\\.gentle-shell\\agent");
	assert.equal(layout.node, `${root}\\runtime\\node-${NODE}\\node.exe`);
	assert.equal(layout.currentKind, "pointer");
	assert.equal(layout.launcher, `${root}\\bin\\gentle-shell.cmd`);
	assert.equal(layout.tmp, `${root}\\tmp`);
	const fallback = prefixLayout({ platform: "win32", env, home: "C:\\Users\\me", root: "C:\\Users\\me\\.gentle-shell-bundle" });
	assert.equal(fallback.versions, "C:\\Users\\me\\.gentle-shell-bundle\\versions");
});

posixTest("claimPrefix creates a private root and refuses one another account can change", () => {
	const user = home();
	const layout = claimPrefix({ platform: "darwin", env: { HOME: user }, home: user });
	const info = lstatSync(layout.root);
	assert.ok(info.isDirectory());
	assert.equal(info.mode & 0o777, 0o700);
	// An existing root (the agent home lives there) is kept as it is.
	writeFileSync(join(layout.root, "config.json"), "{}");
	assert.equal(claimPrefix({ platform: "darwin", env: { HOME: user }, home: user }).root, layout.root);
	assert.equal(readFileSync(join(layout.root, "config.json"), "utf8"), "{}");
	const linked = home();
	symlinkSync(layout.root, join(linked, ".gentle-shell"));
	assert.throws(() => claimPrefix({ platform: "darwin", env: { HOME: linked }, home: linked }), /Unsafe bundled prefix/);
	const shared = home();
	mkdirSync(join(shared, ".gentle-shell"));
	chmodSync(join(shared, ".gentle-shell"), 0o777);
	assert.throws(() => claimPrefix({ platform: "darwin", env: { HOME: shared }, home: shared }), /Unsafe bundled prefix/);
});

test("claimPrefix on Windows walks then claims %LOCALAPPDATA%, falling back to the profile only on an untrusted owner or ACL", () => {
	const env = { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local", USERPROFILE: "C:\\Users\\me" };
	const primary = "C:\\Users\\me\\AppData\\Local\\gentle-shell";
	const fallback = "C:\\Users\\me\\.gentle-shell-bundle";
	const run = (failing: Record<string, string>) => {
		const walked: string[] = []; const claims: string[] = [];
		const layout = claimPrefix({ platform: "win32", env, home: "C:\\Users\\me", adapters: {
			// Only the candidates themselves are absent: each walk starts at its parent.
			exists: (path: string) => path !== primary && path !== fallback,
			prepare: () => {},
			storage: (path: string) => {
				walked.push(path);
				const check = Object.entries(failing).find(([prefix]) => path.startsWith(prefix))?.[1];
				if (check) throw Object.assign(new Error("Windows ACL evidence rejected"), { check });
			},
			claim: (path: string) => { claims.push(path); return "claimed"; },
		} });
		return { layout, walked, claims };
	};
	const trusted = run({});
	assert.equal(trusted.layout.root, primary);
	assert.deepEqual(trusted.claims, [primary]);
	const moved = run({ [primary]: "ancestor-acl-mask", "C:\\Users\\me\\AppData": "parent-acl-mask" });
	assert.equal(moved.layout.root, fallback);
	assert.deepEqual(moved.claims, [fallback]);
	assert.throws(() => run({ "C:\\Users\\me\\AppData": "parent-reparse" }), /ACL evidence/);
	assert.throws(() => run({ "C:\\": "ancestor-acl-mask" }), /ACL evidence/);
});

test("ensureWindowsPrivateFolder runs the PNPM_HOME claim with only the folder and its marker as data", async () => {
	const windows = await import("../scripts/installer-windows.mjs");
	const source = readFileSync(new URL("../scripts/installer-windows.mjs", import.meta.url), "utf8");
	const pnpmHomeClaim = source.split("const pnpmHomeClaim = String.raw`")[1].split("`;")[0];
	const expected = pnpmHomeClaim.replaceAll("$env:GENTLE_WINDOWS_PNPM_HOME", "$env:GENTLE_WINDOWS_PRIVATE_FOLDER")
		.replaceAll("'.gentle-shell-pnpm-home'", "$env:GENTLE_WINDOWS_PRIVATE_MARKER").replaceAll("'gentle-pi private pnpm home'", "$env:GENTLE_WINDOWS_PRIVATE_TEXT");
	const folder = "C:\\L\\gentle-shell";
	const options = (output: string, walked: string[] = []) => ({ marker: ".gentle-shell-bundle", text: "gentle-shell bundled install", platform: "win32",
		processAdapter: (_command: string, args: string[], env: Record<string, string>) => {
			assert.equal(args[4], expected);
			assert.deepEqual([env.GENTLE_WINDOWS_PRIVATE_FOLDER, env.GENTLE_WINDOWS_PRIVATE_MARKER, env.GENTLE_WINDOWS_PRIVATE_TEXT], [folder, ".gentle-shell-bundle", "gentle-shell bundled install"]);
			return output;
		},
		storage: (path: string) => { walked.push(path); } });
	const walked: string[] = [];
	assert.equal(windows.ensureWindowsPrivateFolder(folder, { SystemRoot: "C:\\Windows" }, options("claimed", walked)), "claimed");
	assert.deepEqual(walked, [folder, `${folder}\\tmp`]);
	assert.throws(() => windows.ensureWindowsPrivateFolder(folder, { SystemRoot: "C:\\Windows" }, options("unsafe:foreign")), (error: { check?: string }) => error.check === "foreign");
	assert.throws(() => windows.ensureWindowsPrivateFolder(folder, {}, { ...options("claimed"), marker: "..\\x" }), /marker/);
	assert.throws(() => windows.ensureWindowsPrivateFolder(folder, {}, { ...options("claimed"), platform: "darwin" }), /Native Windows/);
});

// Rule 2: the pinned runtime, verified, published once and reused.
posixTest("ensureRuntime installs the verified Node and pnpm into runtime/ and reuses them", async () => {
	const { layout } = claimed();
	const { calls, adapters: fixture } = adapters();
	const first = await ensureRuntime({ layout, platform: "darwin", arch: "arm64", adapters: fixture });
	assert.deepEqual(first, { node: layout.node, pnpm: layout.pnpm, go: null, acquired: ["node", "pnpm"] });
	assert.deepEqual(readFileSync(layout.node), nodeBytes);
	assert.equal(lstatSync(layout.node).mode & 0o777, 0o700);
	assert.equal(readFileSync(layout.pnpm, "utf8"), "// fixture pnpm\n");
	// Only the Node executable is published: no npm, no links.
	assert.deepEqual(readdirSync(join(layout.runtime, `node-${NODE}`)).sort(), [".gentle-shell-runtime", "bin"]);
	assert.deepEqual(readdirSync(join(layout.runtime, `node-${NODE}`, "bin")), ["node"]);
	// Each is checked in its staging folder, before it is published.
	const [nodeCheck, pnpmCheck] = calls.runs;
	assert.equal(calls.runs.length, 2);
	assert.deepEqual(nodeCheck.args, ["--version"]);
	assert.match(nodeCheck.command, /\/runtime\/\.stage-[^/]+\/bin\/node$/);
	assert.equal(pnpmCheck.command, layout.node);
	assert.match(pnpmCheck.args[0], /\/runtime\/\.stage-[^/]+\/package\/bin\/pnpm\.mjs$/);
	assert.equal(pnpmCheck.args[1], "--version");
	assert.equal(pnpmCheck.env.pnpm_config_store_dir, layout.store);
	const again = await ensureRuntime({ layout, platform: "darwin", arch: "arm64", adapters: fixture });
	assert.deepEqual(again.acquired, []);
	assert.deepEqual(calls.downloads, ["node", "pnpm"]);
});

posixTest("ensureRuntime never replaces an unmarked runtime folder and publishes nothing on a failed check", async () => {
	const { layout } = claimed();
	mkdirSync(join(layout.runtime, `node-${NODE}`, "bin"), { recursive: true });
	writeFileSync(join(layout.runtime, `node-${NODE}`, "bin", "node"), "user");
	await assert.rejects(ensureRuntime({ layout, platform: "darwin", arch: "arm64", adapters: adapters().adapters }), /Conflicting runtime/);
	assert.equal(readFileSync(join(layout.runtime, `node-${NODE}`, "bin", "node"), "utf8"), "user");
	const other = claimed().layout;
	const wrong = adapters({ run: () => ({ status: 0, stdout: "v20.0.0\n", stderr: "" }) }).adapters;
	await assert.rejects(ensureRuntime({ layout: other, platform: "darwin", arch: "arm64", adapters: wrong }), /Node/);
	assert.deepEqual(readdirSync(other.runtime), []);
	const tampered = adapters({ download: async () => Buffer.from("not the pinned bytes") }).adapters;
	await assert.rejects(ensureRuntime({ layout: other, platform: "darwin", arch: "arm64", adapters: tampered }), /integrity|size/);
	assert.deepEqual(readdirSync(other.runtime), []);
});

posixTest("ensureRuntime acquires the pinned Go only when asked", async () => {
	const { layout } = claimed();
	const asked: unknown[] = [];
	const fixture = adapters({ acquireGo: async (options: unknown) => { asked.push(options); return { goPath: "/go/bin/go", version: "1.25.14", acquired: true }; } }).adapters;
	assert.equal((await ensureRuntime({ layout, platform: "darwin", arch: "arm64", adapters: fixture })).go, null);
	assert.equal(asked.length, 0);
	const result = await ensureRuntime({ layout, platform: "darwin", arch: "arm64", go: true, adapters: fixture });
	assert.equal(result.go, "/go/bin/go");
	assert.equal((asked[0] as { root: string }).root, layout.goRoot);
});

test("nodeExecutable takes only node.exe from the Windows zip and only bin/node from the tarball", () => {
	const stem = `node-v${NODE}-win-x64`;
	const exe = Buffer.from("MZ fixture");
	const descriptor = { url: `https://nodejs.org/dist/v${NODE}/${stem}.zip` };
	const archive = zip([[`${stem}/npm.cmd`, Buffer.from("npm")], [`${stem}/node.exe`, exe]]);
	assert.deepEqual(nodeExecutable(archive, descriptor), exe);
	assert.throws(() => nodeExecutable(zip([[`${stem}/npm.cmd`, Buffer.from("npm")]]), descriptor), /Node archive/);
	assert.throws(() => nodeExecutable(zip([[`${stem}/node.exe`, exe], [`${stem}/node.exe`, exe]]), descriptor), /Node archive/);
	const tarball = { url: `https://nodejs.org/dist/v${NODE}/${nodeStem}.tar.gz` };
	assert.deepEqual(nodeExecutable(nodeArchive, tarball), nodeBytes);
	assert.throws(() => nodeExecutable(tarGz([tarEntry(`${nodeStem}/bin/node`, { type: "2", link: "/bin/sh" })]), tarball), /Node archive/);
});

// Rule 3: pnpm's whole world inside the prefix.
test("pnpmEnvironment keeps pnpm's home, store, cache, state and config inside the prefix", () => {
	const layout = prefixLayout({ platform: "linux", env: {}, home: "/home/me" });
	const env = pnpmEnvironment(layout, { platform: "linux", env: {
		HOME: "/home/me", PATH: "/usr/local/bin:/usr/bin", PNPM_HOME: "/home/me/.local/share/pnpm", npm_config_registry: "https://user.example",
		NPM_CONFIG_USERCONFIG: "/home/me/.npmrc", pnpm_config_store_dir: "/elsewhere", XDG_CONFIG_HOME: "/home/me/.config", NODE_OPTIONS: "--require /x.js",
		npm_lifecycle_event: "postinstall", COREPACK_ENABLE_STRICT: "1", HTTPS_PROXY: "http://proxy:3128" } });
	const root = "/home/me/.gentle-shell";
	assert.equal(env.PATH, `${root}/runtime/node-${NODE}/bin:/usr/local/bin:/usr/bin`);
	assert.equal(env.PNPM_HOME, `${root}/pnpm`);
	assert.equal(env.pnpm_config_store_dir, `${root}/pnpm/store`);
	assert.equal(env.pnpm_config_cache_dir, `${root}/pnpm/cache`);
	assert.equal(env.pnpm_config_state_dir, `${root}/pnpm/state`);
	assert.equal(env.pnpm_config_npmrc_auth_file, `${root}/pnpm/config/npmrc`);
	assert.equal(env.XDG_CONFIG_HOME, `${root}/pnpm/config`);
	assert.equal(env.XDG_CACHE_HOME, `${root}/pnpm/cache`);
	assert.equal(env.XDG_STATE_HOME, `${root}/pnpm/state`);
	assert.equal(env.pnpm_config_manage_package_manager_versions, "false");
	assert.equal(env.pnpm_config_update_notifier, "false");
	for (const key of ["npm_config_registry", "NPM_CONFIG_USERCONFIG", "NODE_OPTIONS", "npm_lifecycle_event", "COREPACK_ENABLE_STRICT"]) assert.equal(env[key], undefined, key);
	assert.equal(env.HTTPS_PROXY, "http://proxy:3128");
	assert.equal(env.HOME, "/home/me");
	const withGo = pnpmEnvironment(layout, { platform: "linux", env: { PATH: "/usr/bin" }, go: "/opt/go/bin/go" });
	assert.equal(withGo.PATH, `${root}/runtime/node-${NODE}/bin:/opt/go/bin:/usr/bin`);
});

test("pnpmEnvironment on Windows replaces every Path spelling and moves TEMP into the prefix", () => {
	const layout = prefixLayout({ platform: "win32", env: { LOCALAPPDATA: "C:\\L", USERPROFILE: "C:\\U" }, home: "C:\\U" });
	const env = pnpmEnvironment(layout, { platform: "win32", env: { Path: "C:\\Windows\\System32", TEMP: "C:\\T", tmp: "C:\\T", Pnpm_Home: "C:\\U\\pnpm", SystemRoot: "C:\\Windows" } });
	assert.equal(env.Path, `C:\\L\\gentle-shell\\runtime\\node-${NODE};C:\\Windows\\System32`);
	assert.equal(Object.keys(env).filter((key) => key.toUpperCase() === "PATH").length, 1);
	assert.equal(Object.keys(env).filter((key) => key.toUpperCase() === "PNPM_HOME").length, 1);
	assert.equal(env.PNPM_HOME, "C:\\L\\gentle-shell\\pnpm");
	assert.equal(env.TEMP, "C:\\L\\gentle-shell\\tmp");
	assert.equal(env.TMP, "C:\\L\\gentle-shell\\tmp");
	assert.equal(env.tmp, undefined);
	assert.equal(env.SystemRoot, "C:\\Windows");
});

// Rule 4: one frozen install per version, verified, never replacing a folder.
const manifest = { shell: "4.1.0", pi: "1.0.2" };
function fakePnpm(versions = manifest) {
	const runs: { command: string; args: string[]; cwd: string; env: Record<string, string> }[] = [];
	const run = (command: string, args: string[], options: { cwd: string; env: Record<string, string> }) => {
		runs.push({ command, args, ...options });
		const modules = join(options.cwd, "node_modules");
		mkdirSync(join(modules, "gentle-pi", "bin"), { recursive: true });
		mkdirSync(join(modules, "@earendil-works", "pi-coding-agent"), { recursive: true });
		writeFileSync(join(modules, "gentle-pi", "package.json"), JSON.stringify({ name: "gentle-pi", version: versions.shell }));
		writeFileSync(join(modules, "gentle-pi", "bin", "gentle-shell.mjs"), "");
		writeFileSync(join(modules, "@earendil-works", "pi-coding-agent", "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: versions.pi }));
		return { status: 0, stdout: "", stderr: "" };
	};
	return { runs, run };
}

posixTest("installVersion runs our pnpm frozen in a staging folder and publishes versions/<shell>-<pi>", async () => {
	const { layout } = claimed();
	const pnpm = fakePnpm();
	const result = await installVersion({ layout, manifest, lockfile: "lockfileVersion: '9.0'\n", platform: "darwin", env: { PATH: "/usr/bin" }, adapters: { run: pnpm.run } });
	assert.deepEqual(result, { id: "4.1.0-1.0.2", path: join(layout.versions, "4.1.0-1.0.2"), installed: true });
	assert.equal(pnpm.runs.length, 1);
	const [install] = pnpm.runs;
	assert.equal(install.command, layout.node);
	assert.deepEqual(install.args, [layout.pnpm, "install", "--frozen-lockfile"]);
	assert.equal(posix.dirname(install.cwd), layout.versions);
	assert.match(posix.basename(install.cwd), /^\.stage-/);
	assert.equal(install.env.pnpm_config_store_dir, layout.store);
	const files = distributionFiles(manifest);
	assert.deepEqual(JSON.parse(files["package.json"]).dependencies, { "gentle-pi": "4.1.0", "@earendil-works/pi-coding-agent": "1.0.2" });
	assert.match(files["pnpm-workspace.yaml"], /^allowBuilds:\n {2}gentle-pi: true\nstrictDepBuilds: false\n$/);
	for (const [name, text] of Object.entries({ ...files, "pnpm-lock.yaml": "lockfileVersion: '9.0'\n" })) assert.equal(readFileSync(join(result.path, name), "utf8"), text, name);
	assert.deepEqual(readdirSync(layout.versions), ["4.1.0-1.0.2"]);
	const again = await installVersion({ layout, manifest, lockfile: "lockfileVersion: '9.0'\n", platform: "darwin", env: {}, adapters: { run: pnpm.run } });
	assert.equal(again.installed, false);
	assert.equal(pnpm.runs.length, 1);
});

posixTest("installVersion rejects a wrong installed version, a foreign folder and an unsafe id, publishing nothing", async () => {
	const { layout } = claimed();
	await assert.rejects(installVersion({ layout, manifest, lockfile: "x", platform: "darwin", env: {}, adapters: { run: fakePnpm({ shell: "4.1.0", pi: "1.0.3" }).run } }), /Pi version/);
	assert.deepEqual(readdirSync(layout.versions), []);
	await assert.rejects(installVersion({ layout, manifest, lockfile: "x", platform: "darwin", env: {}, adapters: { run: () => ({ status: 1, stdout: "", stderr: "ERR_PNPM" }) } }), /pnpm install failed/);
	assert.deepEqual(readdirSync(layout.versions), []);
	mkdirSync(join(layout.versions, "4.1.0-1.0.2"));
	writeFileSync(join(layout.versions, "4.1.0-1.0.2", "user.txt"), "keep");
	await assert.rejects(installVersion({ layout, manifest, lockfile: "x", platform: "darwin", env: {}, adapters: { run: fakePnpm().run } }), /Conflicting version/);
	assert.equal(readFileSync(join(layout.versions, "4.1.0-1.0.2", "user.txt"), "utf8"), "keep");
	await assert.rejects(installVersion({ layout, manifest: { shell: "../x", pi: "1.0.2" }, lockfile: "x", platform: "darwin", env: {}, adapters: { run: fakePnpm().run } }), /version/i);
});

// Rule 5: atomic switch, keep two.
async function installed(layout: ReturnType<typeof prefixLayout>, ids: [string, string][]) {
	for (const [shell, pi] of ids) await installVersion({ layout, manifest: { shell, pi }, lockfile: "x", platform: "darwin", env: {}, adapters: { run: fakePnpm({ shell, pi }).run } });
}
posixTest("activateVersion swaps the current symlink atomically and pruneVersions keeps the active and the previous one", async () => {
	const { layout } = claimed();
	await installed(layout, [["4.0.0", "1.0.0"], ["4.1.0", "1.0.1"], ["4.2.0", "1.0.2"]]);
	assert.equal(activeVersion(layout), null);
	for (const id of ["4.0.0-1.0.0", "4.1.0-1.0.1", "4.2.0-1.0.2"]) activateVersion(layout, id);
	assert.equal(readlinkSync(layout.current), "versions/4.2.0-1.0.2");
	assert.equal(activeVersion(layout), "4.2.0-1.0.2");
	mkdirSync(join(layout.versions, "user-folder"));
	assert.deepEqual(pruneVersions(layout), ["4.0.0-1.0.0"]);
	assert.deepEqual(readdirSync(layout.versions).sort(), ["4.1.0-1.0.1", "4.2.0-1.0.2", "user-folder"]);
	// Rolling back keeps both.
	activateVersion(layout, "4.1.0-1.0.1");
	assert.deepEqual(pruneVersions(layout), []);
	assert.throws(() => activateVersion(layout, "user-folder"), /not an installed version/);
	assert.throws(() => activateVersion(layout, "../x"), /version/i);
});

posixTest("activateVersion never replaces a current that is not ours and writes a pointer file on Windows layouts", async () => {
	const { layout } = claimed();
	await installed(layout, [["4.0.0", "1.0.0"]]);
	mkdirSync(layout.current);
	assert.throws(() => activateVersion(layout, "4.0.0-1.0.0"), /Conflicting current/);
	const other = claimed().layout;
	const pointer = { ...other, currentKind: "pointer" };
	await installed(pointer, [["4.0.0", "1.0.0"], ["4.1.0", "1.0.0"]]);
	activateVersion(pointer, "4.0.0-1.0.0");
	activateVersion(pointer, "4.1.0-1.0.0");
	assert.equal(readFileSync(pointer.current, "utf8"), "4.1.0-1.0.0\n");
	assert.equal(activeVersion(pointer), "4.1.0-1.0.0");
	assert.deepEqual(readdirSync(other.root).filter((name) => name.startsWith("current")), ["current"]);
});

// Rule 6: the launcher and the single PATH change.
posixTest("ensureLauncher writes bin/gentle-shell that execs our Node with the current gentle-pi", () => {
	const { layout } = claimed();
	ensureLauncher(layout);
	const text = readFileSync(layout.launcher, "utf8");
	const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
	assert.equal(text, `#!/bin/sh\n# gentle-shell bundled launcher (generated; do not edit)\nexec ${quote(layout.node)} ${quote(join(layout.current, "node_modules/gentle-pi/bin/gentle-shell.mjs"))} "$@"\n`);
	assert.equal(lstatSync(layout.launcher).mode & 0o777, 0o755);
	ensureLauncher(layout);
	writeFileSync(layout.launcher, "#!/bin/sh\necho user\n");
	assert.throws(() => ensureLauncher(layout), /Conflicting launcher/);
});

test("ensureLauncher text for Windows reads the current pointer file", async () => {
	const { launcherText } = await import("../scripts/bundled-install.mjs");
	const layout = prefixLayout({ platform: "win32", env: { LOCALAPPDATA: "C:\\L", USERPROFILE: "C:\\U" }, home: "C:\\U" });
	assert.equal(launcherText(layout), ["@echo off", "rem gentle-shell bundled launcher (generated; do not edit)", "setlocal",
		'set /p GENTLE_SHELL_CURRENT=<"%~dp0..\\current"',
		`"%~dp0..\\runtime\\node-${NODE}\\node.exe" "%~dp0..\\versions\\%GENTLE_SHELL_CURRENT%\\node_modules\\gentle-pi\\bin\\gentle-shell.mjs" %*`,
		"exit /b %errorlevel%", ""].join("\r\n"));
});

posixTest("pathEntryPlan links into ~/.local/bin on PATH, otherwise plans one marked profile line, and both are reversible", () => {
	const { home: user, layout } = claimed();
	ensureLauncher(layout);
	const localBin = join(user, ".local", "bin");
	mkdirSync(localBin, { recursive: true });
	const onPath = pathEntryPlan(layout, { platform: "darwin", env: { PATH: `/usr/bin:${localBin}`, SHELL: "/bin/zsh" }, home: user });
	assert.deepEqual(onPath, { kind: "symlink", path: join(localBin, "gentle-shell"), target: layout.launcher });
	applyPathEntry(onPath);
	assert.equal(readlinkSync(join(localBin, "gentle-shell")), layout.launcher);
	assert.deepEqual(pathEntryPlan(layout, { platform: "darwin", env: { PATH: localBin }, home: user }), { kind: "none" });
	removePathEntry(onPath);
	assert.equal(existsSync(join(localBin, "gentle-shell")), false);

	const zshrc = join(user, ".zshrc");
	writeFileSync(zshrc, "alias ll='ls -l'\n");
	const profile = pathEntryPlan(layout, { platform: "darwin", env: { PATH: "/usr/bin", SHELL: "/bin/zsh" }, home: user });
	assert.deepEqual(profile, { kind: "profile", path: zshrc, line: `export PATH="${layout.bin}:$PATH" # gentle-shell bundled install` });
	applyPathEntry(profile);
	assert.equal(readFileSync(zshrc, "utf8"), `alias ll='ls -l'\n${profile.line}\n`);
	assert.deepEqual(pathEntryPlan(layout, { platform: "darwin", env: { PATH: "/usr/bin", SHELL: "/bin/zsh" }, home: user }), { kind: "none" });
	removePathEntry(profile);
	assert.equal(readFileSync(zshrc, "utf8"), "alias ll='ls -l'\n");
	assert.equal(pathEntryPlan(layout, { platform: "linux", env: { PATH: "/usr/bin", SHELL: "/bin/bash" }, home: user }).path, join(user, ".bashrc"));
	assert.equal(pathEntryPlan(layout, { platform: "linux", env: { PATH: "/usr/bin" }, home: user }).path, join(user, ".profile"));
	assert.deepEqual(pathEntryPlan(layout, { platform: "linux", env: { PATH: `/usr/bin:${layout.bin}` }, home: user }), { kind: "none" });
	// Someone else's gentle-shell in ~/.local/bin is never replaced.
	writeFileSync(join(localBin, "gentle-shell"), "user");
	assert.equal(pathEntryPlan(layout, { platform: "linux", env: { PATH: localBin, SHELL: "/bin/bash" }, home: user }).kind, "profile");
});

test("pathEntryPlan on Windows plans one HKCU Path entry applied through an injected adapter", () => {
	const layout = prefixLayout({ platform: "win32", env: { LOCALAPPDATA: "C:\\L", USERPROFILE: "C:\\U" }, home: "C:\\U" });
	const plan = pathEntryPlan(layout, { platform: "win32", env: { Path: "C:\\Windows" }, home: "C:\\U" });
	assert.deepEqual(plan, { kind: "registry", key: "HKCU\\Environment", name: "Path", entry: "C:\\L\\gentle-shell\\bin" });
	assert.deepEqual(pathEntryPlan(layout, { platform: "win32", env: { PATH: "C:\\Windows;c:\\l\\gentle-shell\\bin\\" }, home: "C:\\U" }), { kind: "none" });
	const registry: string[] = [];
	applyPathEntry(plan, { registry: { add: (entry: string) => registry.push(`+${entry}`), remove: (entry: string) => registry.push(`-${entry}`) } });
	removePathEntry(plan, { registry: { add: () => {}, remove: (entry: string) => registry.push(`-${entry}`) } });
	assert.deepEqual(registry, ["+C:\\L\\gentle-shell\\bin", "-C:\\L\\gentle-shell\\bin"]);
	assert.throws(() => applyPathEntry(plan), /registry adapter/);
});
