# JIL Presenter + ONLYOFFICE

## Changes in this build

- File Transfer now has one **View cloud files** button.
- The cloud-file modal includes a **PPTX files only** toggle.
- PPTX results provide **Open in ONLYOFFICE** and **Add to Scene** actions.
- The **Present in ONLYOFFICE** button and the second-editor presenter page were removed.
- The frontend automatically uses `http://127.0.0.1:3000` locally and `https://bridge.jilwanman.xyz` on the production website.
- `CNAME` is included for GitHub Pages at `presentation.jilwanman.xyz`.

## Important hosting architecture

GitHub Pages can host only the static frontend (`index.html`, `app.js`, and `onlyoffice-integration.js`). It cannot run Docker containers. Run ONLYOFFICE Document Server and the Node bridge on a VPS or cloud server, using:

- `https://office.jilwanman.xyz` for ONLYOFFICE
- `https://bridge.jilwanman.xyz` for the bridge
- `https://presentation.jilwanman.xyz` for the GitHub-hosted frontend

## GitHub Pages frontend

Commit the project-root frontend files and `CNAME` to the GitHub repository. In GitHub, enable Pages for the deployment branch and configure the DNS record for `presentation.jilwanman.xyz`.

## Online Docker server

On a Linux VPS with Docker installed:

```bash
cd onlyoffice-server
cp .env.production.example .env
# Put the same strong JWT secret in .env
docker compose -f docker-compose.production.yml up -d --build
```

Install Caddy or configure an equivalent reverse proxy. `Caddyfile.example` routes the two HTTPS domains to the local Docker ports. Ensure DNS A/AAAA records for `office.jilwanman.xyz` and `bridge.jilwanman.xyz` point to the VPS.

Never commit `.env`.

## Local development

```bash
cd onlyoffice-server
cp .env.example .env
docker compose up -d --build
cd ..
python3 -m http.server 5500
```

Open `http://127.0.0.1:5500/index.html`.
