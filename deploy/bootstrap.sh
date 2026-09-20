#!/usr/bin/env bash
# Run as root once, from the repository root; normal deployments use deploy.
set -euo pipefail
[[ $(id -u) = 0 ]]
id deploy >/dev/null
install -d -o deploy -g deploy -m 700 /srv/debate-bot/releases /srv/debate-bot/incoming
install -d -o root -g root -m 755 /etc/debate-bot
if [[ ! -f /etc/debate-bot/webhook.key && ! -f /etc/debate-bot/webhook.pem ]]; then
  umask 077
  openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 365 \
    -keyout /etc/debate-bot/webhook.key -out /etc/debate-bot/webhook.pem \
    -subj '/CN=185.183.157.185' -addext 'subjectAltName=IP:185.183.157.185'
fi
chmod 600 /etc/debate-bot/webhook.key
chmod 644 /etc/debate-bot/webhook.pem
install -o root -g root -m 644 deploy/debate-bot.service /etc/systemd/system/debate-bot.service
install -o root -g root -m 644 deploy/nginx.conf /etc/nginx/sites-available/debate-bot
ln -sfn /etc/nginx/sites-available/debate-bot /etc/nginx/sites-enabled/debate-bot
if [[ -L /etc/nginx/sites-enabled/default ]]; then rm /etc/nginx/sites-enabled/default; fi
nginx -t
systemd-analyze verify /etc/systemd/system/debate-bot.service
systemctl daemon-reload
systemctl enable debate-bot.service
systemctl enable --now nginx.service
systemctl reload nginx.service
openssl x509 -in /etc/debate-bot/webhook.pem -noout -dates -ext subjectAltName
