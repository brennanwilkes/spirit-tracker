// viz/app/auth_page.js
import { esc } from "./dom.js";
import {
	login,
	signup,
	startOauthGoogle,
	startOauthGithub,
	consumeOauthCallbackHash,
	isOauthCallbackHash,
	getAuthStatus,
	clearAuth,
	AuthError,
	ApiError,
} from "./cloud.js";

function safeMsg(e) {
	const msg = String(e?.message || "Something went wrong").trim();
	// keep it short + safe
	return msg.length > 220 ? msg.slice(0, 220) + "…" : msg;
}

function setStatus($el, text, kind = "neutral") {
	if (!$el) return;
	const cls = kind === "good" ? "badge badgeGood" : kind === "bad" ? "badge badgeBad" : "badge badgeNeutral";
	$el.innerHTML = text ? `<span class="${cls}">${esc(text)}</span>` : "";
}

function spinnerHtml(label = "Working…") {
	return `
    <span style="display:inline-flex; gap:10px; align-items:center;">
      <span style="
        width:16px;height:16px;border-radius:999px;
        border:2px solid var(--border);
        border-top-color:#37566b;
        animation: stSpin 0.8s linear infinite;
        display:inline-block;
      "></span>
      <span class="small" style="color:var(--muted)">${esc(label)}</span>
    </span>
  `;
}

function ensureSpinCss() {
	if (document.getElementById("stSpinCss")) return;
	const css = document.createElement("style");
	css.id = "stSpinCss";
	css.textContent = `@keyframes stSpin { to { transform: rotate(360deg); } }`;
	document.head.appendChild(css);
}

function goAfterLogin() {
	const last = sessionStorage.getItem("viz:lastRoute") || "#/";
	location.hash = last;
}

function renderHeaderButtons(isAuthed) {
	if (!isAuthed) {
		return `
      <a class="btn btnWide" href="#/" style="text-decoration:none;">Continue as guest</a>
    `;
	}
	return `
    <a class="btn btnWide" href="#/" style="text-decoration:none;">Search</a>
    <button id="logoutBtn" class="btn btnWide" type="button">Log out</button>
  `;
}

function renderAuthShell($app, { mode }) {
	ensureSpinCss();

	const isLogin = mode === "login";
	const title = isLogin ? "Log in" : "Create account";
	const sub = isLogin ? "Email + password or OAuth" : "Email + password or OAuth";

	$app.innerHTML = `
    <div class="container">
      <div class="header">
        <div class="headerRow1">
          <div class="headerLeft">
            <h1 class="h1">Brennan's Spirit Tracker</h1>
            <div class="small">${esc(title)} · ${esc(sub)}</div>
          </div>

          <div class="headerRight headerButtons" id="hdrBtns">
            ${renderHeaderButtons(false)}
          </div>
        </div>

        <div class="headerRow2">
          <div class="links">
            <a class="btn btnSm" href="#/">← Back to search</a>
            ${
							isLogin
								? `<a class="btn btnSm" href="#/signup" style="text-decoration:none;">Need an account?</a>`
								: `<a class="btn btnSm" href="#/login" style="text-decoration:none;">Have an account?</a>`
						}
          </div>
        </div>
      </div>

      <div class="card" style="max-width: 520px; margin: 0 auto;">
        <div id="statusRow" style="margin-bottom: 10px;"></div>

        <div style="display:flex; gap:10px; flex-direction:column;">
          <div>
            <div class="small" style="margin: 0 0 6px;">Email</div>
            <input id="email" class="input" type="email" autocomplete="email" placeholder="you@example.com" />
          </div>

          <div>
            <div class="small" style="margin: 0 0 6px;">Password</div>
            <input id="pw" class="input" type="password" autocomplete="${
							isLogin ? "current-password" : "new-password"
						}" placeholder="Minimum 8 characters" />
          </div>

          <button id="submitBtn" class="btn btnWide" type="button" style="
            width: 100%;
            padding-top: 13px;
            padding-bottom: 13px;
            border-radius: 12px;
            font-weight: 700;
            letter-spacing: 0.2px;
          ">
            ${esc(title)}
          </button>

          <div style="display:flex; gap:10px; align-items:center;">
            <div style="flex:1; height:1px; background: var(--border);"></div>
            <div class="small">or</div>
            <div style="flex:1; height:1px; background: var(--border);"></div>
          </div>

          <div style="display:flex; gap:10px; flex-wrap:wrap;">
            <button id="googleBtn" class="btn btnWide" type="button" style="flex:1;">
              Continue with Google
            </button>
            <button id="githubBtn" class="btn btnWide" type="button" style="flex:1;">
              Continue with GitHub
            </button>
          </div>

          <div class="small" style="margin-top: 2px;">
            OAuth opens a new login flow and returns you to <span class="mono">#/oauth</span>.
          </div>
        </div>
      </div>
    </div>
  `;

	const $statusRow = document.getElementById("statusRow");
	const $email = document.getElementById("email");
	const $pw = document.getElementById("pw");
	const $submit = document.getElementById("submitBtn");
	const $google = document.getElementById("googleBtn");
	const $github = document.getElementById("githubBtn");
	const $hdrBtns = document.getElementById("hdrBtns");

	function refreshHeader() {
		const s = getAuthStatus();
		$hdrBtns.innerHTML = renderHeaderButtons(s.ok);
		const $logout = document.getElementById("logoutBtn");
		if ($logout) {
			$logout.addEventListener("click", () => {
				clearAuth();
				setStatus($statusRow, "Logged out", "neutral");
				refreshHeader();
			});
		}
	}

	function setBusy(busy, label) {
		$submit.disabled = busy;
		$google.disabled = busy;
		$github.disabled = busy;
		$email.disabled = busy;
		$pw.disabled = busy;

		$submit.innerHTML = busy ? spinnerHtml(label || "Working…") : esc(title);
	}

	async function doEmailPw() {
		const email = String($email.value || "").trim();
		const pw = String($pw.value || "");

		setStatus($statusRow, "");
		setBusy(true, isLogin ? "Logging in…" : "Creating account…");

		try {
			if (isLogin) await login(email, pw);
			else await signup(email, pw);

			setStatus($statusRow, "Success. Redirecting…", "good");
			sessionStorage.setItem("viz:lastRoute", sessionStorage.getItem("viz:lastRoute") || "#/");
			goAfterLogin();
		} catch (e) {
			const kind = e instanceof AuthError ? "bad" : e instanceof ApiError ? "bad" : "bad";
			setStatus($statusRow, safeMsg(e), kind);
		} finally {
			setBusy(false);
		}
	}

	// enter to submit
	$pw.addEventListener("keydown", (ev) => {
		if (ev.key === "Enter") doEmailPw();
	});

	$submit.addEventListener("click", doEmailPw);

	$google.addEventListener("click", () => {
		setStatus($statusRow, "Redirecting to Google…", "neutral");
		startOauthGoogle();
	});

	$github.addEventListener("click", () => {
		setStatus($statusRow, "Redirecting to GitHub…", "neutral");
		startOauthGithub();
	});

	refreshHeader();

	// focus
	setTimeout(() => ($email.value ? $pw.focus() : $email.focus()), 0);
}

/**
 * Route: #/oauth
 * Consumes token from location.hash (fragment) and redirects back.
 */
export function renderOauth($app) {
	ensureSpinCss();

	$app.innerHTML = `
    <div class="container">
      <div class="header">
        <div class="headerRow1">
          <div class="headerLeft">
            <h1 class="h1">Brennan's Spirit Tracker</h1>
            <div class="small">Finishing sign-in…</div>
          </div>
          <div class="headerRight headerButtons">
            <a class="btn btnWide" href="#/" style="text-decoration:none;">Back to search</a>
          </div>
        </div>
      </div>

      <div class="card" style="max-width: 520px; margin: 0 auto;">
        <div id="oauthStatus" style="margin-bottom:10px;"></div>
        <div id="oauthSpinner" style="padding: 6px 0;">${spinnerHtml("Completing OAuth…")}</div>
        <div class="small" style="margin-top: 10px; color: var(--muted);">
          If this doesn’t finish, go back and try again.
        </div>
      </div>
    </div>
  `;

	const $status = document.getElementById("oauthStatus");

	try {
		if (!isOauthCallbackHash(window.location.hash)) {
			setStatus($status, "No OAuth token found in URL.", "bad");
			return;
		}

		const consumed = consumeOauthCallbackHash({ clearHash: true });
		if (!consumed?.token) {
			setStatus($status, "OAuth callback did not include a token.", "bad");
			return;
		}

		setStatus($status, "Signed in. Redirecting…", "good");
		goAfterLogin();
	} catch (e) {
		setStatus($status, safeMsg(e), "bad");
	}
}

export function renderLogin($app) {
	return renderAuthShell($app, { mode: "login" });
}

export function renderSignup($app) {
	return renderAuthShell($app, { mode: "signup" });
}
