#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
export PATH=/usr/local/bin:/usr/bin:/bin
release=${1:?release required}
revision=${2:?revision required}
run_url=${3:?GitHub run URL required}
[[ "$release" =~ ^[a-f0-9]{40}-[0-9]+-[0-9]+$ ]]
[[ "$revision" =~ ^[a-f0-9]{40}$ ]]
[[ "$run_url" =~ ^https://github.com/ismiranova-gif/debate-bot/actions/runs/[0-9]+$ ]]
base=/srv/debate-bot
exec 9>"$base/deploy.lock"
flock -w 300 9
folder="$base/releases/$release"
[[ ! -e "$folder" ]]
mkdir -p "$folder"
tar -xzf "$base/incoming/$release.tar.gz" -C "$folder"
install -m 600 "$base/incoming/$release.env" "$folder/.env"
rm "$base/incoming/$release.env" "$base/incoming/$release.tar.gz"
cd "$folder"
[[ "$(node -p 'process.versions.node.split(".")[0]')" = 24 ]]
npm ci --omit=dev --ignore-scripts --no-fund --no-audit
npm run check
npm test
node deploy/verify-apis.js --snapshot
previous=$(readlink "$base/current" || true)
switched=0
health() {
  local response
  response=$(curl --silent --show-error --fail --max-time 5 --cacert /etc/debate-bot/webhook.pem https://185.183.157.185/healthz) || return 1
  node -e 'const d=JSON.parse(process.argv[1]); if (!d.ready || d.revision!==process.argv[2]) process.exit(1)' "$response" "$revision"
}
rollback() {
  trap - ERR INT TERM
  if [[ "$switched" = 1 ]]; then
    if [[ -n "$previous" ]]; then
      ln -s "$previous" "$base/current.rollback"
      mv -Tf "$base/current.rollback" "$base/current"
      sudo -n /usr/local/sbin/debate-deploy-admin bot-restart
      echo 'Previous release restored.' >&2
    else
      sudo -n /usr/local/sbin/debate-deploy-admin bot-stop
      rm "$base/current"
      node deploy/restore-webhook.js
      echo 'First deployment failed; service stopped.' >&2
    fi
  fi
  exit 1
}
trap rollback ERR INT TERM
ln -s "$folder" "$base/current.next"
mv -Tf "$base/current.next" "$base/current"
switched=1
sudo -n /usr/local/sbin/debate-deploy-admin bot-restart
healthy=0
for attempt in $(seq 1 30); do
  if health; then healthy=1; break; fi
  sleep 2
done
[[ "$healthy" = 1 ]]
node -e 'const fs=require("node:fs"); fs.writeFileSync(process.argv[1],JSON.stringify({revision:process.argv[2],run_url:process.argv[3],release:process.argv[4],deployed_at:new Date().toISOString()},null,2)+"\n")' "$base/deployment.json" "$revision" "$run_url" "$release"
trap - ERR INT TERM
printf 'Deployment successful: %s\n' "$revision"
