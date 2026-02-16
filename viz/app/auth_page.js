// viz/app/auth_page.js
import { esc } from "./dom.js";
import {
	login,
	signup,
	startOauthGoogle,
	startOauthGithub,
	consumeOauthCallbackHash,
	isOauthCallbackHash,
	clearAuth,
	AuthError,
	ApiError,
} from "./cloud.js";

function safeMsg(e) {
	const msg = String(e?.message || "Something went wrong").trim();
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

function ensureCssOnce() {
	if (document.getElementById("stAuthCss")) return;
	const css = document.createElement("style");
	css.id = "stAuthCss";
	css.textContent = `
@keyframes stSpin { to { transform: rotate(360deg); } }

.authWrap{
  min-height: 100vh;
  display:flex;
  align-items:center;
  justify-content:center;
  padding: 18px;
}

.authCard{
  width: 100%;
  max-width: 520px;
  padding: 18px;
  border-radius: 14px;
}

.brandMark{
  width: 44px;
  height: 44px;
  border-radius: 14px;
  border: 1px solid rgba(125, 211, 252, 0.35);
  background:
    radial-gradient(60% 60% at 30% 30%, rgba(125,211,252,0.22), rgba(0,0,0,0)),
    linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.00));
  box-shadow: 0 0 0 1px rgba(125, 211, 252, 0.10) inset;
}

.authTitle{
  font-size: 18px;
  font-weight: 800;
  margin: 0;
}

.authSub{
  margin-top: 6px;
  color: var(--muted);
  font-size: 12px;
}

.primaryBtn{
  width: 100%;
  padding: 14px 12px;
  border-radius: 12px;
  font-weight: 800;
  letter-spacing: 0.2px;
  border-color: rgba(125, 211, 252, 0.28);
  box-shadow: 0 0 0 1px rgba(125, 211, 252, 0.10) inset;
}

.secondaryBtn{
  width: 100%;
  padding: 14px 12px;
  border-radius: 12px;
  font-weight: 800;
  letter-spacing: 0.2px;
}

.oauthBtn{
  width: 100%;
  display:flex;
  align-items:center;
  justify-content:center;
  gap:10px;
  padding: 12px 12px;
  border-radius: 12px;
  font-weight: 700;
  letter-spacing: 0.2px;
}

.oauthIcon{
  width: 18px;
  height: 18px;
  display:inline-flex;
  align-items:center;
  justify-content:center;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: rgba(255,255,255,0.03);
}

.oauthGoogle{
  border-color: rgba(125, 211, 252, 0.35);
  box-shadow: 0 0 0 1px rgba(125, 211, 252, 0.12) inset;
}
.oauthGoogle:hover{ border-color: rgba(125, 211, 252, 0.55); }

.oauthGithub{
  border-color: rgba(231, 237, 243, 0.22);
  box-shadow: 0 0 0 1px rgba(231, 237, 243, 0.08) inset;
}
.oauthGithub:hover{ border-color: rgba(231, 237, 243, 0.35); }

.miniLinkRow{
  display:flex;
  justify-content: space-between;
  align-items:center;
  gap: 10px;
  margin-top: 10px;
}
`;
	document.head.appendChild(css);
}

function goAfterLogin() {
	const last = sessionStorage.getItem("viz:lastRoute") || "#/";
	location.hash = last;
}

function renderAuth($app, { mode }) {
	ensureCssOnce();

	const isLogin = mode === "login";
	const title = isLogin ? "Log in" : "Create account";

	$app.innerHTML = `
    <div class="authWrap">
      <div class="card authCard">
        <div style="display:flex; align-items:center; gap:12px; margin-bottom: 12px;">
          <div class="brandMark" aria-hidden="true"></div>
          <div style="min-width:0;">
            <h1 class="authTitle">Brennan’s Spirit Tracker</h1>
            <div class="authSub">Sign in to save favourites, sampling, and scores.</div>
          </div>
        </div>

        <div id="statusRow" style="margin-bottom: 10px;"></div>

        <div style="display:flex; flex-direction:column; gap:10px;">
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

          <!-- stacked primary actions -->
          <button id="loginBtn" class="btn btnWide primaryBtn" type="button">Log in</button>
          <button id="signupBtn" class="btn btnWide secondaryBtn" type="button">Sign up</button>

          <div style="display:flex; gap:10px; align-items:center; margin: 6px 0 2px;">
            <div style="flex:1; height:1px; background: var(--border);"></div>
            <div class="small">or</div>
            <div style="flex:1; height:1px; background: var(--border);"></div>
          </div>

          <button id="googleBtn" class="btn oauthBtn oauthGoogle" type="button">
            <span class="oauthIcon" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                <path d="M44.5 24.5c0-1.6-.1-2.8-.4-4.1H24v7.7h11.6c-.2 1.9-1.6 4.8-4.6 6.7l-.1.5 6.3 4.9.4.1c3.7-3.4 6-8.4 6-14.5Z" fill="#7DD3FC"/>
                <path d="M24 45c5.8 0 10.6-1.9 14.1-5.2l-6.7-5.2c-1.8 1.2-4.2 2.1-7.4 2.1-5.7 0-10.6-3.7-12.3-8.9l-.5.1-6.8 5.2-.2.5C7.7 40.4 15.3 45 24 45Z" fill="#E7EDF3" opacity="0.9"/>
                <path d="M11.7 27.8c-.4-1.2-.7-2.5-.7-3.8s.3-2.6.6-3.8l0-.5-7-5.3-.2.1C3.5 16.5 2.9 20.2 2.9 24s.6 7.5 1.5 10.5l7.3-5.7Z" fill="#9AA6B2"/>
                <path d="M24 11.5c4 0 6.6 1.7 8.1 3.2l5.9-5.8C34.6 5.9 29.8 3.9 24 3.9c-8.7 0-16.3 4.6-20.5 11.5l7.2 5.3c1.8-5.2 6.6-9.2 13.3-9.2Z" fill="#E7EDF3" opacity="0.9"/>
              </svg>
            </span>
            Continue with Google
          </button>

          <button id="githubBtn" class="btn oauthBtn oauthGithub" type="button">
            <span class="oauthIcon" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                <path d="M8 0C3.58 0 0 3.73 0 8.33c0 3.68 2.29 6.8 5.47 7.9.4.08.55-.18.55-.4 0-.2-.01-.86-.01-1.56-2.01.45-2.53-.51-2.69-.98-.09-.24-.48-.98-.82-1.18-.28-.16-.68-.56-.01-.58.63-.02 1.08.6 1.23.85.72 1.27 1.87.91 2.33.7.07-.54.28-.91.51-1.12-1.78-.21-3.64-.92-3.64-4.1 0-.9.31-1.63.82-2.2-.08-.21-.36-1.06.08-2.2 0 0 .67-.22 2.2.84.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.06 2.2-.84 2.2-.84.44 1.14.16 1.99.08 2.2.51.57.82 1.3.82 2.2 0 3.19-1.87 3.89-3.65 4.1.29.26.54.78.54 1.57 0 1.13-.01 2.04-.01 2.33 0 .22.15.49.55.4C13.71 15.13 16 12 16 8.33 16 3.73 12.42 0 8 0Z"/>
              </svg>
            </span>
            Continue with GitHub
          </button>

          <div class="miniLinkRow">
            <a href="#/" class="small" style="color:var(--muted);">Back to search</a>
            <button id="logoutBtn" class="btn btnSm" type="button" style="display:none;">Log out</button>
          </div>
        </div>
      </div>
    </div>
  `;

	const $statusRow = document.getElementById("statusRow");
	const $email = document.getElementById("email");
	const $pw = document.getElementById("pw");
	const $loginBtn = document.getElementById("loginBtn");
	const $signupBtn = document.getElementById("signupBtn");
	const $google = document.getElementById("googleBtn");
	const $github = document.getElementById("githubBtn");
	const $logout = document.getElementById("logoutBtn");

	function setBusy(busy, label) {
		$loginBtn.disabled = busy;
		$signupBtn.disabled = busy;
		$google.disabled = busy;
		$github.disabled = busy;
		$email.disabled = busy;
		$pw.disabled = busy;

		$loginBtn.innerHTML = busy && label ? spinnerHtml(label) : "Log in";
		$signupBtn.textContent = "Sign up";
	}

	async function doLogin() {
		setStatus($statusRow, "");
		setBusy(true, "Logging in…");
		try {
			await login(String($email.value || "").trim(), String($pw.value || ""));
			setStatus($statusRow, "Success. Redirecting…", "good");
			goAfterLogin();
		} catch (e) {
			setStatus($statusRow, safeMsg(e), "bad");
		} finally {
			setBusy(false);
		}
	}

	async function doSignup() {
		setStatus($statusRow, "");
		setBusy(true, "Creating account…");
		try {
			await signup(String($email.value || "").trim(), String($pw.value || ""));
			setStatus($statusRow, "Success. Redirecting…", "good");
			goAfterLogin();
		} catch (e) {
			setStatus($statusRow, safeMsg(e), "bad");
		} finally {
			setBusy(false);
		}
	}

	$pw.addEventListener("keydown", (ev) => {
		if (ev.key === "Enter") {
			// enter submits the current mode's primary
			if (isLogin) doLogin();
			else doSignup();
		}
	});

	$loginBtn.addEventListener("click", doLogin);
	$signupBtn.addEventListener("click", doSignup);

	$google.addEventListener("click", () => {
		setStatus($statusRow, "Redirecting…", "neutral");
		startOauthGoogle();
	});

	$github.addEventListener("click", () => {
		setStatus($statusRow, "Redirecting…", "neutral");
		startOauthGithub();
	});

	// show logout only if already authed
	try {
		const hasToken = !!localStorage.getItem("st:cloud:v1:token");
		if (hasToken) {
			$logout.style.display = "";
			$logout.addEventListener("click", () => {
				clearAuth();
				setStatus($statusRow, "Logged out", "neutral");
				$logout.style.display = "none";
			});
		}
	} catch {}

	// subtle emphasis: highlight current mode
	if (isLogin) {
		$loginBtn.style.borderColor = "rgba(125, 211, 252, 0.38)";
	} else {
		$signupBtn.style.borderColor = "rgba(125, 211, 252, 0.38)";
		$signupBtn.style.boxShadow = "0 0 0 1px rgba(125, 211, 252, 0.10) inset";
	}

	setTimeout(() => ($email.value ? $pw.focus() : $email.focus()), 0);
}

export function renderOauth($app) {
	ensureCssOnce();

	$app.innerHTML = `
    <div class="authWrap">
      <div class="card authCard">
        <div style="display:flex; align-items:center; gap:12px; margin-bottom: 12px;">
          <div class="brandMark" aria-hidden="true"></div>
          <div style="min-width:0;">
            <h1 class="authTitle">Brennan’s Spirit Tracker</h1>
            <div class="authSub">Finishing sign-in…</div>
          </div>
        </div>

        <div id="oauthStatus" style="margin-bottom:10px;"></div>
        <div style="padding: 6px 0;">${spinnerHtml("Just a moment…")}</div>
        <div class="small" style="margin-top: 10px; color: var(--muted);">
          You’ll be redirected automatically.
        </div>
      </div>
    </div>
  `;

	const $status = document.getElementById("oauthStatus");

	try {
		if (!isOauthCallbackHash(window.location.hash)) {
			setStatus($status, "Sign-in link is missing. Please try again.", "bad");
			return;
		}

		const consumed = consumeOauthCallbackHash({ clearHash: true });
		if (!consumed?.token) {
			setStatus($status, "Couldn’t complete sign-in. Please try again.", "bad");
			return;
		}

		setStatus($status, "Signed in. Redirecting…", "good");
		goAfterLogin();
	} catch (e) {
		setStatus($status, safeMsg(e), "bad");
	}
}

export function renderLogin($app) {
	return renderAuth($app, { mode: "login" });
}

export function renderSignup($app) {
	return renderAuth($app, { mode: "signup" });
}
