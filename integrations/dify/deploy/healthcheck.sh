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
# Exit status is non-zero if any check fails.

set -uo pipefail

BASE="${1:-https://dify.kadindustries.org}"
BASE="${BASE%/}"
FAILED=0

pass() { printf '  \033[32mok\033[0m   %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAILED=1; }
info() { printf '  --   %s\n' "$1"; }

printf '\nDify healthcheck: %s\n\n' "$BASE"

host="${BASE#*://}"
host="${host%%/*}"
host="${host%%:*}"

# --- DNS ---------------------------------------------------------------------
printf 'DNS\n'
if addresses="$(getent ahosts "$host" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ')" && [ -n "$addresses" ]; then
   pass "$host resolves to: $addresses"
else
   fail "$host does not resolve"
fi

# --- Reachability and TLS ----------------------------------------------------
printf '\nHTTP\n'
headers="$(curl -sS -I --max-time 20 "$BASE/" 2>&1)"
if [ $? -ne 0 ]; then
   fail "cannot reach $BASE — $headers"
else
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
fi

if [ "${BASE#https://}" != "$BASE" ]; then
   if expiry="$(echo | openssl s_client -servername "$host" -connect "$host:443" 2>/dev/null \
      | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)"; then
      if [ -n "$expiry" ]; then
         pass "TLS certificate valid until $expiry"
      else
         fail "could not read the TLS certificate"
      fi
   else
      fail "TLS handshake failed"
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
   info_body="$(curl -sS --max-time 20 -H "Authorization: Bearer $DIFY_API_KEY" "$BASE/v1/info" 2>&1)"
   if printf '%s' "$info_body" | grep -q '"name"'; then
      pass "GET /v1/info authenticated: $(printf '%s' "$info_body" | head -c 160)"
   else
      fail "GET /v1/info failed: $(printf '%s' "$info_body" | head -c 200)"
   fi

   # time_starttransfer on a streaming request is the buffering test: an
   # unbuffered SSE stream delivers its first byte in a second or two, while a
   # buffered one only "starts" once the whole answer is generated.
   printf '\nStreaming\n'
   timing="$(curl -sS -o /dev/null --max-time 60 \
      -w '%{http_code} %{time_starttransfer}' \
      -H "Authorization: Bearer $DIFY_API_KEY" \
      -H 'Content-Type: application/json' \
      -d '{"query":"Reply with the single word: ok","inputs":{},"response_mode":"streaming","user":"healthcheck","conversation_id":""}' \
      "$BASE/v1/chat-messages" 2>&1)"
   code="$(printf '%s' "$timing" | awk '{print $1}')"
   ttfb="$(printf '%s' "$timing" | awk '{print $2}')"
   if [ "$code" = "200" ]; then
      if awk "BEGIN{exit !($ttfb < 10)}" 2>/dev/null; then
         pass "streaming first byte after ${ttfb}s — not buffered"
      else
         fail "streaming first byte after ${ttfb}s — a proxy is buffering the SSE response"
      fi
   elif [ "$code" = "404" ]; then
      info "chat streaming returned 404 — this key belongs to a workflow or completion app, not a chat app"
   else
      fail "streaming request returned $code"
   fi
fi

printf '\n'
if [ "$FAILED" -eq 0 ]; then
   printf 'All checks passed.\n\n'
else
   printf 'One or more checks failed. See integrations/dify/RUNBOOK.md.\n\n'
fi
exit "$FAILED"
