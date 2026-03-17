"use strict";

const { execFileSync } = require("child_process");

function runGit(args) {
	return execFileSync("git", args, { encoding: "utf8" }).trimEnd();
}

function gitShowJson(sha, filePath) {
	try {
		const txt = execFileSync("git", ["show", `${sha}:${filePath}`], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return JSON.parse(txt);
	} catch {
		return null;
	}
}

function gitFileExistsAtSha(sha, filePath) {
	if (!sha) return false;
	try {
		execFileSync("git", ["cat-file", "-e", `${sha}:${filePath}`], {
			stdio: ["ignore", "ignore", "ignore"],
		});
		return true;
	} catch {
		return false;
	}
}

function gitListTreeFiles(sha, dirRel) {
	try {
		const out = runGit(["ls-tree", "-r", "--name-only", sha, dirRel]);
		return out
			.split(/\r?\n/)
			.map((s) => s.trim())
			.filter(Boolean);
	} catch {
		return [];
	}
}

function getFirstParentSha(headSha) {
	try {
		const out = runGit(["rev-list", "--parents", "-n", "1", headSha]);
		const parts = out.split(/\s+/).filter(Boolean);
		return parts.length >= 2 ? parts[1] : "";
	} catch {
		return "";
	}
}

function listChangedDbFiles(fromSha, toSha) {
	try {
		const out = runGit(["diff", "--name-only", fromSha, toSha, "--", "data/db"]);
		return out
			.split(/\r?\n/)
			.map((s) => s.trim())
			.filter((s) => s && s.endsWith(".json"));
	} catch {
		return [];
	}
}

module.exports = {
	runGit,
	gitShowJson,
	gitFileExistsAtSha,
	gitListTreeFiles,
	getFirstParentSha,
	listChangedDbFiles,
};
