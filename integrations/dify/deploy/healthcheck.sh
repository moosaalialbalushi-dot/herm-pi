#!/usr/bin/env bash
# Diagnose a Dify deployment from the outside.
#
#   ./healthcheck.sh                                    # checks https://dify.kadindustries.org
#   ./healthcheck.sh https://dify.kadindustries.org
#   ./healthcheck.sh http://127.0.0.1:8080              # from the VM, behind the proxy
#
# Set DIFY_API_KEY to a Service API key (app-...) to also exercise /v1, which
# is the only way to tell whether streaming is being buffered somewhere.
#
#   DIFY_API_KEY=app-xxxx ./healthcheck.sh
#
# The key is passed to curl through a config on stdin, never on the command
# line, so it does not show up in the process table.
#
# Exit status is non-zero if any check fails.

set -uo pipefail

BASE="${1:-https://dify.kadindustries.org}"
BASE="${BASE%/}"
FAILED=0

pass() { printf '  \033[32mok\033[0m   %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAILED=1; }
info() { printf '  --   %s\n' "$1"; }

printf '\nDify healthcheck: %s\n\n' "$BASE"

# Split the authority into host and port, keeping a bracketed IPv6 literal
# intact. A non-default port must survive into the TLS check, or it inspects
# the wrong endpoint.
authority="${BASE#*://}"
authority="${authority%%/*}"
case "$authority" in
   \[*\]:*) host="${authority%]:*}"; host="${host#[}"; port="${authority##*]:}" ;;
   \[*\])   host="${authority#[}"; host="${host%]}"; port="" ;;
   *:*)     host="${authority%:*}"; port="${authority##*:}" ;;
   *)       host="$authority"; port="" ;;
esac
if [ -n "$port" ]; then connect_target="$authority"; else connect_target="$authority:443"; fi

# Emit a curl config carrying the auth header, for `curl -K -`.
auth_config() { printf 'header = "Authorization: Bearer %s"\n' "$DIFY_API_KEY"; }

# --- DNS ---------------------------------------------------------------------
printf 'DNS\n'
if addresses="$(getent ahosts "$host" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ')" && [ -n "$addresses" ]; then
   pass "$host resolves to: $addresses"
else
   fail "$host does not resolve"
fi

# --- Reachability and TLS ----------------------------------------------------
printf '\nHTTP\n'
if headers="$(curl -sS -I --max-time 20 "$BASE/" 2>&1)"; then
   status="$(printf '%s' "$headers" | head -1 | awk '{print $2}')"
   case "$status" in
      200|301|302|307|308) pass "root responds $status" ;;
      502|503|504) fail "root responds $status — the proxy is up but Dify is not answering" ;;
      *) fail "root responds $status" ;;
   esac

   # A cf-ray header means Cloudflare is proxying, which brings its own limits:
   # ~100s to first byte (524) and a request-body cap.
   if printf '%s' "$headers" | grep -qi '^cf-ray:'; then
      info "Cloudflare is proxying this hostname (cf-ray present)"
      info "  -> blocking calls slower than ~100s to first byte return 524; prefer streaming"
   else
      info "no Cloudflare proxy headers seen (DNS-only, tunnel, or direct origin)"
   fi
else
   fail "cannot reach $BASE — $headers"
fi

if [ "${BASE#https://}" != "$BASE" ]; then
   # openssl s_client waits forever on a stalled handshake without a timeout.
   if expiry="$(echo | timeout 20s openssl s_client -servername "$host" -connect "$connect_target" 2>/dev/null \
      | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)" && [ -n "$expiry" ]; then
      pass "TLS certificate for $connect_target valid until $expiry"
   else
      fail "TLS handshake with $connect_target failed or timed out"
   fi
fi

# --- Console API -------------------------------------------------------------
printf '\nConsole API\n'
setup="$(curl -sS --max-time 20 "$BASE/console/api/setup" 2>&1)"
if printf '%s' "$setup" | grep -q '"step"'; then
   if printf '%s' "$setup" | grep -q '"finished"'; then
      pass "console API reachable, installation finished"
   else
      info "console API reachable, setup not finished — open $BASE/install"
   fi
else
   fail "console API did not return a setup status: $(printf '%s' "$setup" | head -c 200)"
fi

# --- Service API -------------------------------------------------------------
printf '\nService API\n'
if [ -z "${DIFY_API_KEY:-}" ]; then
   info "DIFY_API_KEY not set — skipping /v1 checks (set it to test keys and streaming)"
else
   info_body="$(auth_config | curl -K - -sS --max-time 20 "$BASE/v1/info" 2>&1)"
   if printf '%s' "$info_body" | grep -q '"name"'; then
      pass "GET /v1/info authenticated: $(printf '%s' "$info_body" | head -c 160)"
   else
      fail "GET /v1/info failed: $(printf '%s' "$info_body" | head -c 200)"
   fi

   # Time the first byte of the response BODY, not the headers. A buffering
   # proxy forwards the headers immediately and holds the events back, so
   # curl's time_starttransfer would call a buffered stream unbuffered.
   printf '\nStreaming\n'
   stream_started=$SECONDS
   first_byte="$(
      auth_config | curl -K - -sS -N --max-time 60 \
         -H 'Content-Type: application/json' \
         -d '{"query":"Reply with the single word: ok","inputs":{},"response_mode":"streaming","user":"healthcheck","conversation_id":""}' \
         "$BASE/v1/chat-messages" 2>/dev/null \
         | head -c 1
   )"
   stream_elapsed=$((SECONDS - stream_started))

   if [ -n "$first_byte" ]; then
      if [ "$stream_elapsed" -lt 10 ]; then
         pass "first SSE body byte after ${stream_elapsed}s — not buffered"
      else
         fail "first SSE body byte after ${stream_elapsed}s — a proxy is buffering the SSE response"
      fi
   else
      fail "streaming request returned no body (wrong app type for chat, auth failure, or a proxy error)"
   fi
fi

printf '\n'
if [ "$FAILED" -eq 0 ]; then
   printf 'All checks passed.\n\n'
else
   printf 'One or more checks failed. See integrations/dify/RUNBOOK.md.\n\n'
fi
exit "$FAILED"
