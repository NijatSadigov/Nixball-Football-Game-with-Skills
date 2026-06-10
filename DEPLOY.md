# Deploying NixBall to a subdomain

NixBall is one Node.js process that serves both the static client and the game
WebSocket on a single port. That makes it ideal for a subdomain reverse proxy,
e.g. `nixball.yourdomain.com` next to your portfolio.

Ready-made config files live in [`deploy/`](deploy/): `nixball.service` (systemd),
`nginx-nixball.conf` (reverse proxy), and `update.sh` (pull + rebuild + restart).

> **Hosting requirement:** you need somewhere you can run a long-lived Node 20+
> process (a VPS, or your own server). Plain static/shared hosting (cPanel file
> hosting, GitHub Pages, etc.) cannot host the game server because it needs
> WebSockets. If your portfolio is on static hosting, run NixBall on a small VPS
> or a Node-friendly platform and point the subdomain's DNS there.

## 1. Build

```bash
npm ci
npm run build
```

This produces a self-contained `dist/` folder:

```
dist/
  server.cjs    # the whole server, dependencies bundled — no node_modules needed
  public/       # the built client (index.html + assets)
```

## 2. Copy to the server and run

```bash
# on the server, e.g. /opt/nixball
scp -r dist/ user@yourserver:/opt/nixball/dist/

# run (from /opt/nixball so the server finds dist/public)
cd /opt/nixball
PORT=3001 node dist/server.cjs
```

Environment variables:

| Var          | Default              | Meaning                          |
| ------------ | -------------------- | -------------------------------- |
| `PORT`       | `3000`               | HTTP + WebSocket port            |
| `PUBLIC_DIR` | `<cwd>/dist/public`  | Where the built client lives     |

### Keep it running — systemd

`/etc/systemd/system/nixball.service`:

```ini
[Unit]
Description=NixBall game server
After=network.target

[Service]
WorkingDirectory=/opt/nixball
ExecStart=/usr/bin/node /opt/nixball/dist/server.cjs
Environment=PORT=3001
Restart=always
RestartSec=3
User=www-data

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now nixball
```

(Or with pm2: `pm2 start dist/server.cjs --name nixball` + `pm2 save`.)

## 3. nginx reverse proxy for the subdomain

`/etc/nginx/sites-available/nixball.conf`:

```nginx
server {
    listen 80;
    server_name nixball.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;

        # WebSocket upgrade (required for /ws)
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # game sockets are long-lived
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/nixball.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### HTTPS

```bash
sudo certbot --nginx -d nixball.yourdomain.com
```

The client automatically uses `wss://` when the page is served over HTTPS —
no config needed.

### DNS

Add an `A` record for `nixball` pointing at your server's IP (or a `CNAME` to the
host that already serves your portfolio, if it's the same machine).

## 4. Verify

- `https://nixball.yourdomain.com/healthz` → `ok`
- Open the page in two browsers, create a room in one, join by code in the other.

## Docker (alternative)

```bash
docker build -t nixball .
docker run -d --name nixball -p 3001:3000 --restart unless-stopped nixball
```

Then reverse-proxy the subdomain to port 3001 as above.

## Notes

- Rooms live in memory; restarting the server clears them (players just recreate —
  there are no accounts or persistence by design).
- One small process handles many rooms; a 1-vCPU VPS is plenty to start.
