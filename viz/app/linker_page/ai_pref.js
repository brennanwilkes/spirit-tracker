// viz/app/linker_page/ai_pref.js
//
// User preference for the AI embedding blend on the linker pages. Default OFF: the live
// linker uses the original deterministic scorer (sharp separation) unless the user opts in.
// Turning it on enables the fine-tuned embedding re-rank (and the contribution indicator).

const KEY = "stviz:linker_ai_embeddings";

export function aiEnabled() {
	try {
		return localStorage.getItem(KEY) === "1";
	} catch {
		return false;
	}
}

export function setAiEnabled(on) {
	try {
		localStorage.setItem(KEY, on ? "1" : "0");
	} catch {}
}
