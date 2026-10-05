#!/usr/bin/env bash
# Bring up the ProtonVPN WireGuard tunnel on a GitHub runner and route ALL egress through it.
#
# Best-effort by design: on any failure the tunnel is torn down and the caller continues on the
# runner's direct IP. The cron's one-shot retry then flips egress for the stores that failed, so
# a dead tunnel costs a retry, never data. Never use `set -e` here.
#
# In:  WG_CONF (the PROTONVPN_WG_CONF secret), PROBE_URL (a Cloudflare-fronted store API that
#      returns a JSON array when the egress is not challenged; recorded, never gating).
# Out: VPN_DIAG_FILE lines ("vpn: …") that run_daily.sh copies into the commit message, and
#      GITHUB_OUTPUT keys vpn_diag_file / vpn_ok / vpn_egress_ip.
#
# Manual bring-up (wg setconf + ip rule/route) instead of wg-quick: wg-quick's resolvconf and
# nft steps are what hung on GH runners in 2026-07. Every blocking command has a timeout.

set -uo pipefail

VPN_DIAG_FILE="$(mktemp)"
echo "vpn_diag_file=$VPN_DIAG_FILE" >> "${GITHUB_OUTPUT:-/dev/null}"
diag() { echo "$1" | tee -a "$VPN_DIAG_FILE"; }
teardown() { sudo ip link del wg0 2>/dev/null || true; }

if [[ -z "${WG_CONF:-}" ]]; then
	echo "::warning::PROTONVPN_WG_CONF secret not set; running direct"
	diag "vpn: off (secret not set)"
	exit 0
fi

DIRECT_IP="$(timeout 12 curl -fsS --max-time 8 https://api.ipify.org 2>/dev/null || echo "")"

if ! command -v wg >/dev/null 2>&1; then
	export DEBIAN_FRONTEND=noninteractive
	sudo -E timeout 120 apt-get update -qq >/dev/null 2>&1
	sudo -E timeout 180 apt-get install -y -qq wireguard-tools >/dev/null 2>&1
	if ! command -v wg >/dev/null 2>&1; then
		echo "::warning::wireguard-tools install failed; running direct"
		diag "vpn: off (wireguard-tools install failed)"
		exit 0
	fi
fi

umask 077
CONF=/tmp/wg0.conf
SETCONF=/tmp/wg0.setconf.conf
printf '%s\n' "$WG_CONF" > "$CONF"
# wg setconf only understands the [Interface]/[Peer] crypto keys; the wg-quick keys are applied by hand below.
awk '/^(Address|DNS|MTU|Table|PreUp|PostUp|PreDown|PostDown|SaveConfig)[[:space:]]*=/ {next} {print}' "$CONF" > "$SETCONF"
ADDR="$(grep -i '^Address' "$CONF" | head -1 | sed 's/^[^=]*=[[:space:]]*//' | cut -d, -f1)"
ENDPOINT="$(grep -i '^Endpoint' "$CONF" | head -1 | sed 's/^[^=]*=[[:space:]]*//')"

sudo timeout 15 ip link add dev wg0 type wireguard
if ! sudo timeout 15 wg setconf wg0 "$SETCONF"; then
	teardown
	echo "::warning::wg setconf failed; running direct"
	diag "vpn: off (wg setconf failed, endpoint $ENDPOINT)"
	exit 0
fi
[[ -n "$ADDR" ]] && sudo timeout 15 ip address add "$ADDR" dev wg0
sudo timeout 15 ip link set up dev wg0

# A handshake usually lands in 1-2 s; checking once immediately reads 0 and wrongly gives up.
hs=0
for i in $(seq 1 20); do
	hs="$(timeout 5 sudo wg show wg0 latest-handshakes 2>/dev/null | awk '{print $2}')"
	[[ -n "$hs" && "$hs" != "0" ]] && break
	sleep 1
done
if [[ -z "$hs" || "$hs" == "0" ]]; then
	teardown
	echo "::warning::no WireGuard handshake after 20 s; running direct"
	diag "vpn: off (no handshake after 20s, endpoint $ENDPOINT)"
	exit 0
fi

sudo wg set wg0 fwmark 51820
sudo ip -4 rule add not fwmark 51820 table 51820
sudo ip -4 rule add table main suppress_prefixlength 0
sudo ip -4 route add 0.0.0.0/0 dev wg0 table 51820
printf 'nameserver 1.1.1.1\nnameserver 8.8.8.8\n' | sudo tee /etc/resolv.conf >/dev/null

EGRESS_IP="$(timeout 12 curl -fsS --max-time 8 https://api.ipify.org 2>/dev/null || echo "")"
if [[ -z "$EGRESS_IP" || "$EGRESS_IP" == "$DIRECT_IP" ]]; then
	sudo ip -4 rule del not fwmark 51820 table 51820 2>/dev/null
	sudo ip -4 rule del table main suppress_prefixlength 0 2>/dev/null
	teardown
	echo "::warning::tunnel up but egress unusable (direct=$DIRECT_IP tunnel=${EGRESS_IP:-none}); running direct"
	diag "vpn: off (egress unusable: direct=$DIRECT_IP tunnel=${EGRESS_IP:-none})"
	exit 0
fi

probe="not run"
if [[ -n "${PROBE_URL:-}" ]]; then
	UA="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36"
	out="$(timeout 25 curl -sS --max-time 20 -w $'\n__CODE__%{http_code}' -H "user-agent: $UA" "$PROBE_URL" 2>/dev/null || echo $'\n__CODE__ERR')"
	code="${out##*__CODE__}"
	body="${out%$'\n'__CODE__*}"
	if [[ "${body:0:1}" == "[" ]]; then
		probe="JSON HTTP $code"
	elif grep -qiE 'just a moment|challenge-platform|cf-mitigated' <<< "$body"; then
		probe="CF-challenged HTTP $code"
	else
		probe="not JSON HTTP $code"
	fi
fi

diag "vpn: ok (egress $EGRESS_IP via $ENDPOINT, direct $DIRECT_IP, probe $probe)"
echo "vpn_ok=true" >> "${GITHUB_OUTPUT:-/dev/null}"
echo "vpn_egress_ip=$EGRESS_IP" >> "${GITHUB_OUTPUT:-/dev/null}"
