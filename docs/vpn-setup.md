# VPN / IP Blocking on GitHub Actions

## The Problem

GitHub Actions runners use Azure datacenter IPs. Several liquor store websites
(liberty, highlander, coop, colordevino, maltsandgrains) are behind Cloudflare
and block datacenter IPs with JavaScript challenges or 403s.

## What We Tried

### WireGuard (ProtonVPN) — RE-ENABLED 2026-10-05

Set up a ProtonVPN WireGuard tunnel in `cron_tracker.yaml`. Manual bring-up
(`wg setconf` + `ip/route`) to avoid `wg-quick` hang issues on GH runners.

**Status (corrected 2026-10-05): this diagnosis was wrong — see CLAUDE.md §"Datacenter-IP Blocking". The tunnel works; it is re-enabled via `scripts/vpn_up.sh`.**

- UDP endpoint is reachable (`nc -u` succeeds)
- `wg setconf` succeeds
- `wg show latest-handshakes` stays 0 forever
- Likely cause: Azure platform-level filtering of WireGuard protocol packets
  above the VM iptables level (Hyper-V virtual switch inspects packet structure)
- The diagnostic workflow (`vpn_diag.yaml`) worked on a different runner —
  suggesting this is a per-VM or per-pool issue

The full WireGuard config and manual bring-up code is commented out in
`cron_tracker.yaml`. To re-enable: uncomment the step and set
`PROTONVPN_WG_CONF` secret.

### Diagnostic Workflow (`vpn_diag.yaml`)

Proved WireGuard CAN work on some GH runners. Key findings:
- Manual path (`wg setconf` + `ip link/route`) is more reliable than `wg-quick`
- `wg-quick` hangs on some runners due to `resolvconf` dependency
- `apt-get` hangs without `DEBIAN_FRONTEND=noninteractive`
- `sleep` itself hangs on some Azure VMs (CPU contention)

## Alternatives (Not Yet Tried)

### 1. Tailscale (GitHub's Recommended)

GitHub's official docs call Tailscale "the quickest option" — built-in NAT
traversal, no port forwarding needed.

```yaml
- uses: tailscale/github-action@v2
  with:
    oauth-client-id: ${{ secrets.TS_OAUTH_CLIENT_ID }}
    oauth-secret: ${{ secrets.TS_OAUTH_SECRET }}
    tags: tag:ci
```

ProtonVPN does not offer Tailscale integration, but you can run your own
Tailscale coordination server or use a VPS as an exit node.

### 2. Residential HTTP Proxy

For scraping, a residential proxy is simpler than a full VPN tunnel. The
tracker's HTTP client just reads `HTTP_PROXY` from env.

```yaml
env:
  HTTP_PROXY: "http://user:pass@proxy.example.com:8080"
```

Services: Oxylabs, BrightData, ScrapingAnt. Cost varies ($50-200/mo for
residential IPs).

### 3. Cloudflare IP Whitelisting

Marketplace action `bypass-cloudflare-for-github-action` whitelists the
runner's IP in Cloudflare via API. No VPN needed — just API access to the
Cloudflare account. Won't work for stores we don't control.

### 4. OpenVPN over TCP/443

Wrap OpenVPN in TCP on port 443 to disguise as HTTPS. Slower than WireGuard
but more likely to pass Azure's packet filtering since it's standard TCP.

### 5. udp2raw

Wrap WireGuard in raw TCP to defeat deep packet inspection. Similar idea to
OpenVPN-over-TCP but keeps WireGuard's crypto.

```bash
udp2raw -C 8888 -s -l 0.0.0.0:4096 -r <server-ip>:443 --raw-mode faketcp
```

### 6. Conntrack NOTRACK Rules

Before WireGuard bring-up, add:
```bash
sudo iptables -t raw -A PREROUTING -p udp --dport 51820 -j NOTRACK
sudo iptables -t raw -A OUTPUT -p udp --sport 51820 -j NOTRACK
```
This skips conntrack for WireGuard packets. Might help if the kernel's
conntrack is interfering with handshake timing.

## Real-World Implementations

### GitHub Official Docs
- https://docs.github.com/en/actions/using-github-hosted-runners/connecting-to-a-private-network
- Uses raw `wg` commands (no marketplace action)
- Recommends Tailscale as alternative

### Lullabot (Production Guide)
- https://www.lullabot.com/articles/deploying-private-servers-wireguard-github-actions
- Uses `wg-quick up wg0` with PostUp directive for private key
- Key gotcha: all GH runners share one WireGuard peer identity — concurrent
  workflows conflict. Solution: concurrency groups.

### rkalkani/wireguard-action (Marketplace)
- https://github.com/rkalkani/wireguard-action
- Handles install + config + cleanup via `post` hook
- Accepts plain text or base64 config

### ValdikSS NAT Traversal Hack
- https://github.com/ValdikSS/nat-traversal-github-actions-openvpn-wireguard
- Runs a VPN SERVER on GH Actions (reversing the direction)
- Uses UDP hole-punching + STUN to traverse Azure's NAT
- 217 stars — proves it works

## Recommended Next Step

Try **Tailscale** first — it's what GitHub officially recommends, handles NAT
traversal automatically, and has a first-party GitHub Action. If that fails,
try a **residential HTTP proxy** since the tracker only needs HTTP(S) egress.


---

# Archive: datacenter-IP blocking and ProtonVPN egress (from CLAUDE.md)

> Moved verbatim from the root `CLAUDE.md` on 2026-10-14 to keep that file small. CLAUDE.md keeps a condensed summary and a pointer here. Section cross-references (§"…") refer to the old CLAUDE.md layout; most of those sections now live in docs/ files named in CLAUDE.md.

Cloudflare challenges the runner's Azure IP (`HTTP 403 … <title>Just a moment...</title>`) at
several stores. Per-store fail rate over 2026-07-06→10-05 (645 reports): elbowliquor 99.5%,
colordevino 82%, sherbrooke/gull/highlander ~30% overall but **100% since late Sept** (highlander
since 2026-09-26), rmwsb/maltsandgrains/liberty/wineandbeyond/kwm intermittent. A store whose
categories ALL fail never enters `ranStoreKeys`, so the orphan detector leaves its DB alone — the
data goes stale, it is not corrupted. Check this before "fixing" an adapter: every one of these
scrapes cleanly from a residential IP.

**BCL** is not on the always-blocked list but gets bad runner responses (403 challenge 2026-10-06,
HTTP 200 `Total=0` 2026-10-09). Each one wiped 746 listings until the central zero-scan guard
(`merge.js::guardLargeCategoryOnly`, 2026-10-09) made it a `FAILED` category that the retry re-runs.
See `docs/incident-2026-10-06-bcl-wnb-wipe.md`. The same incident showed that a store renaming its urls looks like a
mass sellout + mass new-listing unless both `merge.js` (rematch removed records by sku) and
`build_viz_index.js` (first-seen keyed by sku, not url) follow the sku; both do now.

**Everything Wine is different:** it is challenged even from a residential IP (2026-10-05), so no
egress change fixes it.

**Routing (the `vpn` dispatch input):** the Worker clock dispatches smalls with `vpn=true` (the small list
carries highlander + colordevino); bigs with `vpn=false`; the one-shot retry re-dispatches the
failed stores with the OPPOSITE egress (`-f vpn=`). Tunnel bring-up is `scripts/vpn_up.sh`
(manual `wg setconf` + `ip rule`, secret `PROTONVPN_WG_CONF`, exit 212.104.215.146 / AS212238);
best-effort, falls back to direct with a `::warning::` and a `vpn:` line in the commit body.

**The 2026-07 "handshake never completes / Azure filters WireGuard" conclusion was WRONG.** All 5
July-15 cron runs that got `wg` installed handshook in 1-2 s and scraped through the tunnel (they
were cancelled by hand mid-scrape); the earlier failures were `apt-get` hangs / `wg` missing. The
diag on 2026-10-05 again handshook in 2 s and Highlander's API returned real content via Proton.
