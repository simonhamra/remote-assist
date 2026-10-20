# Deploying the server

One small VPS runs everything the apps need from the internet:

| Service | Role | Ports |
|---|---|---|
| **Caddy** | HTTPS certificate, TLS for the signaling WebSocket, and app updates under `/updates/` | TCP 80, 443 |
| **signaling** | Session codes, relaying WebRTC negotiation, minting TURN credentials | internal only (8787) |
| **coturn** | TURN relay for networks where a direct connection fails | TCP+UDP 3478, UDP 49160–49260 |

The server never sees screen content. Video goes peer to peer, or through coturn as encrypted packets it cannot read.

> **Status:** written but not yet deployed. Docker isn't installed on the development Mac, so these files haven't run as containers. The server image's install step was checked by hand, and the relay path is covered by the end-to-end tests using a stand-in TURN server.

## 1. Get a server and a domain

- A VPS with a public IPv4 address: 1 vCPU and 1–2 GB of RAM is plenty (for example Hetzner CX22 or a DigitalOcean basic droplet). Ubuntu 24.04 LTS.
- A domain or subdomain, for example `assist.example.com`, with a DNS **A record** pointing at the VPS's IP address.

## 2. Install Docker and open the firewall

Install Docker Engine and the Compose plugin by following [Docker's guide for Ubuntu](https://docs.docker.com/engine/install/ubuntu/). Then open the ports:

```bash
sudo ufw allow 22/tcp && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
```

```bash
sudo ufw allow 3478 && sudo ufw allow 49160:49260/udp && sudo ufw enable
```

If your provider also has a cloud firewall (Hetzner, DigitalOcean and AWS all do), open the same ports there.

## 3. Configure and start

```bash
git clone https://github.com/simonhamra/remote-assist.git && cd remote-assist/infra
```

```bash
cp .env.example .env && openssl rand -hex 32
```

Edit `.env`: set `DOMAIN` to your domain, and paste the random string from `openssl` as `TURN_SECRET`. Then:

```bash
docker compose up -d --build
```

Check that it works:

```bash
curl https://assist.example.com/healthz
```

It should print `ok`. If not, `docker compose logs -f` shows what each service is doing. Caddy needs ports 80 and 443 reachable to get its certificate.

## 4. Point the apps at it

```bash
RA_SIGNALING_URL=wss://assist.example.com/ws npm run dev:host
```

```bash
RA_SIGNALING_URL=wss://assist.example.com/ws npm run dev:helper
```

To check that the relay works, add `RA_FORCE_RELAY=1` to **both** commands. The helper's stats overlay should then show **Path: relay**.

## App updates

Caddy serves `infra/updates/host` and `infra/updates/helper` at `https://<domain>/updates/host/` and `…/helper/`, where the installed apps look for new versions. `infra/publish-update.sh` fills them from a drafted GitHub release; see [Releases and updates](../docs/06-releases.md). Nothing else is served, and folders aren't listed.

## Backups

Pairings live in the `signaling-data` volume (`/data/remote-assist.db`). If it's lost, everyone pairs again: nothing else breaks, and nobody gains access. To back it up:

```bash
docker compose cp signaling:/data/remote-assist.db ./remote-assist-backup.db
```

## Updating

```bash
git pull && docker compose up -d --build
```

## Notes

- **Cloud servers behind NAT** (AWS, GCP) need coturn to know its public address. Add `- --external-ip=$(detect-external-ip)` to the coturn `command` in `docker-compose.yml`.
- **TURN over TLS on port 443** helps on very strict networks (some hotels and offices) but needs a second IP address or SNI routing, because Caddy already uses 443. It's planned for later.
- **Logs** contain no IP addresses, session codes or message contents, only room IDs and counts.
