#!/usr/bin/env bash
#
# Diagnose WHY Liberty Wine Merchants fails in CI: is it the egress IP's
# reputation, or something reproducible from any client (headers / TLS fingerprint)?
#
# Run it from anywhere and compare by egress IP:
#   - your machine / a clean residential IP  -> expect HTTP 200 "OK"
#   - a GitHub Actions runner (Azure)        -> expect "CHALLENGED (Cloudflare)"
#
# It probes the same two URLs the scraper touches, via curl (default UA, browser
# UA, full Chrome headers) AND via Node global fetch (the scraper's real client,
# which has a different TLS/JA3 fingerprint than curl). If curl passes but Node
# fetch is challenged from the SAME IP, the block has a TLS-fingerprint component,
# not just IP reputation.
set -uo pipefail

HOST="www.libertywinemerchants.com"
PAGE_URL="https://${HOST}/product-category/whisky/"
# The WooCommerce Store API endpoint the liberty adapter actually hits (cat 1075 = whisky).
API_URL="https://${HOST}/wp-json/wc/store/v1/products?per_page=5&category=1075&stock_status=instock"
UA_CHROME='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36'

echo "=== Liberty block diagnostic ==="
echo "egress IP : $(curl -fsS --max-time 8 https://api.ipify.org 2>/dev/null || echo unknown)"
echo "timestamp : $(date -u +%FT%TZ)"
echo "node      : $(command -v node >/dev/null && node -v || echo 'not found')"
echo

# Classify a curl response: print URL label, HTTP code, and whether the body is a
# Cloudflare challenge ("Just a moment") vs real content.
classify_curl() {
  local label="$1"; shift
  local out code body
  out="$(curl -sS --max-time 25 -w $'\n__CODE__%{http_code}' "$@" 2>/dev/null)"
  code="${out##*__CODE__}"
  body="${out%__CODE__*}"
  local verdict="OTHER"
  if grep -qiE 'just a moment|challenge-platform|cf-mitigated|attention required|enable javascript' <<<"$body"; then
    verdict="CHALLENGED (Cloudflare)"
  elif [[ "$code" == 2* ]]; then
    verdict="OK ($(wc -c <<<"$body" | tr -d ' ') bytes)"
  fi
  printf '  %-26s HTTP %-3s  %s\n' "$label" "$code" "$verdict"
}

echo "== curl: category page =="
classify_curl "default UA"          "$PAGE_URL"
classify_curl "browser UA"          -H "user-agent: $UA_CHROME" "$PAGE_URL"
classify_curl "full Chrome headers" \
  -H "user-agent: $UA_CHROME" \
  -H 'accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8' \
  -H 'accept-language: en-US,en;q=0.9' \
  -H 'sec-ch-ua: "Chromium";v="121", "Google Chrome";v="121", "Not A(Brand";v="99"' \
  -H 'sec-ch-ua-mobile: ?0' -H 'sec-ch-ua-platform: "Linux"' \
  -H 'sec-fetch-dest: document' -H 'sec-fetch-mode: navigate' \
  -H 'sec-fetch-site: none' -H 'upgrade-insecure-requests: 1' \
  "$PAGE_URL"

echo "== curl: store API (endpoint the scraper uses) =="
classify_curl "default UA"          "$API_URL"
classify_curl "browser UA"          -H "user-agent: $UA_CHROME" "$API_URL"

# Node global fetch with the tracker's exact header set — same client/TLS the
# scraper uses. If this is CHALLENGED while curl above was OK (same IP), the block
# is (also) TLS/JA3-fingerprint based, which an IP change alone won't fix.
if command -v node >/dev/null; then
  echo "== node fetch (scraper's real client) =="
  UA="$UA_CHROME" PAGE="$PAGE_URL" API="$API_URL" node - <<'NODE'
const UA = process.env.UA, targets = [["category page", process.env.PAGE], ["store API", process.env.API]];
const hdr = {
  "user-agent": UA, "accept-language": "en-US,en;q=0.9",
  "sec-ch-ua": '"Chromium";v="121", "Google Chrome";v="121", "Not A(Brand";v="99"',
  "sec-ch-ua-mobile": "?0", "sec-ch-ua-platform": '"Linux"',
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "sec-fetch-dest": "document", "sec-fetch-mode": "navigate", "sec-fetch-site": "none",
  "upgrade-insecure-requests": "1",
};
(async () => {
  for (const [label, url] of targets) {
    try {
      const r = await fetch(url, { headers: hdr, redirect: "follow" });
      const body = await r.text();
      const challenged = /just a moment|challenge-platform|cf-mitigated|enable javascript/i.test(body);
      const verdict = challenged ? "CHALLENGED (Cloudflare)" : (r.ok ? `OK (${body.length} bytes)` : "OTHER");
      console.log(`  ${label.padEnd(26)} HTTP ${String(r.status).padEnd(3)}  ${verdict}`);
    } catch (e) {
      console.log(`  ${label.padEnd(26)} ERR  ${e?.message || e}`);
    }
  }
})();
NODE
fi

echo
echo "Interpretation:"
echo "  All OK from this IP  -> block is IP-reputation; fix = clean (non-datacenter) egress IP."
echo "  node CHALLENGED but curl OK (same IP) -> TLS/JA3 component too; IP change alone won't fix."
echo "  All CHALLENGED here  -> this IP is flagged like the runner; not a clean test source."
