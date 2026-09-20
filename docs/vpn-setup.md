# VPN / IP Blocking on GitHub Actions

## The Problem

GitHub Actions runners use Azure datacenter IPs. Several liquor store websites
(liberty, highlander, coop, colordevino, maltsandgrains) are behind Cloudflare
and block datacenter IPs with JavaScript challenges or 403s.

## What We Tried

### WireGuard (ProtonVPN) — DISABLED

Set up a ProtonVPN WireGuard tunnel in `cron_tracker.yaml`. Manual bring-up
(`wg setconf` + `ip/route`) to avoid `wg-quick` hang issues on GH runners.

**Status: Handshake never completes on cron runner.**

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
