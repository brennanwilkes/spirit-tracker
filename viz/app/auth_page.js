import { esc } from "./dom.js";
import { login, signup, getAuthStatus } from "./cloud.js";

function hashQuery() {
	const h = String(location.hash || "");
	const i = h.indexOf("?");
	return new URLSearchParams(i >= 0 ? h.slice(i + 1) : "");
}

function getNextHash() {
	const next = hashQuery().get("next") || "#/";
	// allow internal hash routes only
	return next.startsWith("#/") ? next : "#/";
}

function setText(id, text) {
	const el = document.getElementById(id);
	if (el) el.textContent = String(text || "");
}

function setBusy(isBusy) {
	for (const el of Array.from(document.querySelectorAll("input,button"))) {
		if (el.id === "backBtn") continue;
		el.disabled = !!isBusy;
	}
}

function renderShell($app, title, bodyHtml) {
	$app.innerHTML = `
		<div class="container">
			<div class="topbar">
				<a id="backBtn" class="btn" href="#/" style="text-decoration:none;">← Back</a>
				<span class="badge mono">${esc(title)}</span>
			</div>

			<div class="card">
				<div class="h1" style="margin-bottom:6px;">${esc(title)}</div>
				<div class="small" id="status" style="margin-bottom:12px;"></div>

				${bodyHtml}
			</div>
		</div>
	`;
}

export function renderLogin($app) {
	const s = getAuthStatus();

	renderShell(
		$app,
		"Login",
		`
		<div style="display:flex; flex-direction:column; gap:10px; max-width:420px;">
			<input id="email" class="input" type="email" autocomplete="email" placeholder="Email" />
			<input id="password" class="input" type="password" autocomplete="current-password" placeholder="Password" />

			<div style="display:flex; gap:10px; flex-wrap:wrap; align-items:center;">
				<button id="submit" class="btn btnWide" type="button">Login</button>
				<a class="btn btnWide" href="#/signup?next=${encodeURIComponent(getNextHash())}" style="text-decoration:none;">Create account</a>
			</div>

			<div class="small">Token is stored locally in your browser after login.</div>
		</div>
	`,
	);

	if (s.ok) {
		setText("status", "You’re already logged in. You can re-login to refresh your token.");
	} else {
		setText("status", "Enter your credentials.");
	}

	const $email = document.getElementById("email");
	const $password = document.getElementById("password");
	const $submit = document.getElementById("submit");

	$submit.addEventListener("click", async () => {
		setText("status", "Logging in…");
		setBusy(true);
		try {
			await login($email.value, $password.value);
			location.hash = getNextHash();
		} catch (e) {
			setText("status", String(e?.message || e));
		} finally {
			setBusy(false);
		}
	});

	$email.focus();
}

export function renderSignup($app) {
	const s = getAuthStatus();

	renderShell(
		$app,
		"Sign up",
		`
		<div style="display:flex; flex-direction:column; gap:10px; max-width:420px;">
			<input id="email" class="input" type="email" autocomplete="email" placeholder="Email" />
			<input id="password" class="input" type="password" autocomplete="new-password" placeholder="Password (min 8 chars)" />
			<input id="password2" class="input" type="password" autocomplete="new-password" placeholder="Confirm password" />

			<div style="display:flex; gap:10px; flex-wrap:wrap; align-items:center;">
				<button id="submit" class="btn btnWide" type="button">Create account</button>
				<a class="btn btnWide" href="#/login?next=${encodeURIComponent(getNextHash())}" style="text-decoration:none;">Have an account?</a>
			</div>

			<div class="small">Your account is created on the cloud backend; your token is saved locally.</div>
		</div>
	`,
	);

	if (s.ok) setText("status", "You’re already logged in. You can still create another account if you want.");
	else setText("status", "Create an account.");

	const $email = document.getElementById("email");
	const $password = document.getElementById("password");
	const $password2 = document.getElementById("password2");
	const $submit = document.getElementById("submit");

	$submit.addEventListener("click", async () => {
		const p1 = String($password.value || "");
		const p2 = String($password2.value || "");
		if (p1 !== p2) {
			setText("status", "Passwords do not match.");
			return;
		}

		setText("status", "Creating account…");
		setBusy(true);
		try {
			await signup($email.value, p1);
			location.hash = getNextHash();
		} catch (e) {
			setText("status", String(e?.message || e));
		} finally {
			setBusy(false);
		}
	});

	$email.focus();
}
