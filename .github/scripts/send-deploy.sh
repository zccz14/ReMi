#!/usr/bin/env bash
set -euo pipefail

instance_id="${1:?EC2 instance ID is required}"
tag="${2:?release tag is required}"
repository="${GITHUB_REPOSITORY:?GitHub repository is required}"
github_token="${GITHUB_TOKEN:?GitHub token is required}"
release_json="$(mktemp)"
headers="$(mktemp)"
cleanup() { rm -f "$release_json" "$headers"; }
trap cleanup EXIT

curl --fail --silent --show-error \
  --header "Accept: application/vnd.github+json" \
  --header "Authorization: Bearer $github_token" \
  --header "X-GitHub-Api-Version: 2022-11-28" \
  --output "$release_json" \
  "https://api.github.com/repos/$repository/releases/tags/$tag"

asset_url() {
  local name="$1"
  local asset_id status location
  asset_id="$(jq -r --arg name "$name" '.assets[] | select(.name == $name) | .id' "$release_json")"
  test -n "$asset_id" && test "$asset_id" != null
  status="$(curl --silent --show-error --request GET --max-redirs 0 \
    --header 'Accept: application/octet-stream' \
    --header "Authorization: Bearer $github_token" \
    --header 'X-GitHub-Api-Version: 2022-11-28' \
    --dump-header "$headers" --output /dev/null --write-out '%{http_code}' \
    "https://api.github.com/repos/$repository/releases/assets/$asset_id")"
  test "$status" = 302
  location="$(awk 'tolower(substr($0,1,9)) == "location:" {sub(/^[^:]*:[[:space:]]*/, ""); sub(/\r$/, ""); print; exit}' "$headers")"
  test -n "$location"
  printf '%s' "$location"
}

archive_url="$(asset_url remi-x86_64-unknown-linux-gnu.tar.gz)"
checksum_url="$(asset_url remi-x86_64-unknown-linux-gnu.tar.gz.sha256)"
unset GITHUB_TOKEN github_token
script_base64="$(base64 < deploy/deploy-release.sh | tr -d '\n')"
printf -v quoted_tag '%q' "$tag"
printf -v quoted_archive_url '%q' "$archive_url"
printf -v quoted_checksum_url '%q' "$checksum_url"
install_command="printf '%s' '$script_base64' | base64 -d > /tmp/remi-deploy.sh"
run_command="bash /tmp/remi-deploy.sh $quoted_tag $quoted_archive_url $quoted_checksum_url"
parameters="$(jq -cn --arg install "$install_command" --arg run "$run_command" '{commands:[$install,$run]}')"
command_id="$(aws ssm send-command --instance-ids "$instance_id" --document-name AWS-RunShellScript --comment "Deploy ReMi $tag" --parameters "$parameters" --query 'Command.CommandId' --output text)"
for _ in $(seq 1 120); do
  status="$(aws ssm get-command-invocation --command-id "$command_id" --instance-id "$instance_id" --query Status --output text 2>/dev/null || true)"
  case "$status" in
    Success) aws ssm get-command-invocation --command-id "$command_id" --instance-id "$instance_id" --query '{Status:Status,StandardOutput:StandardOutputContent,StandardError:StandardErrorContent}'; exit 0 ;;
    Failed|Cancelled|TimedOut) aws ssm get-command-invocation --command-id "$command_id" --instance-id "$instance_id" --query '{Status:Status,StandardOutput:StandardOutputContent,StandardError:StandardErrorContent}'; exit 1 ;;
  esac
  sleep 2
done
aws ssm get-command-invocation --command-id "$command_id" --instance-id "$instance_id" --query '{Status:Status,StandardOutput:StandardOutputContent,StandardError:StandardErrorContent}' || true
exit 1
