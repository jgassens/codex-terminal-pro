#!/usr/bin/with-contenv bashio

# Home Assistant API Examples for Codex Terminal Pro
# This script demonstrates how to interact with Home Assistant APIs

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║        Home Assistant API Examples for Codex                ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

if ! command -v supervisor-api >/dev/null 2>&1; then
    echo -e "${RED}Error: supervisor-api helper not found${NC}"
    echo "This script must be run from within Codex Terminal Pro"
    exit 1
fi

echo -e "${GREEN}✓ Brokered Supervisor API helper available${NC}"
echo ""

# Function to make API calls
api_call() {
    local endpoint=$1
    local method=${2:-GET}
    local data=${3:-}

    if [ "$method" = "GET" ]; then
        supervisor-api "/${endpoint}"
    else
        supervisor-api -X "$method" "/${endpoint}" \
            -H "Content-Type: application/json" \
            -d "$data"
    fi
}

# Example 1: Get add-on info
echo "1. Getting current add-on information:"
echo "   Endpoint: /addons/self/info"
echo ""
api_call "addons/self/info" | jq '.data | {name, version, state}'
echo ""

# Example 2: Get Home Assistant info
echo "2. Getting Home Assistant information:"
echo "   Endpoint: /core/info"
echo ""
api_call "core/info" | jq '.data | {version, machine, operating_system}'
echo ""

# Example 3: List all add-ons
echo "3. Listing installed add-ons:"
echo "   Endpoint: /addons"
echo ""
api_call "addons" | jq '.data.addons[] | {name, slug, version, state}'
echo ""

# Example 4: Get network info
echo "4. Getting network information:"
echo "   Endpoint: /network/info"
echo ""
api_call "network/info" | jq '.data.interfaces[0] | {interface, ip_address: .ipv4.address}'
echo ""

# Example 5: Home Assistant API (entities)
echo "5. Getting Home Assistant entities (via WebSocket):"
echo "   Note: For full entity access, use the WebSocket API"
echo ""

# Function to call Home Assistant API
ha_api_call() {
    local endpoint=$1
    supervisor-api "/core/api/${endpoint}"
}

echo "   Getting system health:"
ha_api_call "system_health/info" | jq '.'
echo ""

# Example usage in scripts
echo "════════════════════════════════════════════════════════════════"
echo "Usage in your scripts:"
echo ""
echo -e "${YELLOW}# Get add-on configuration:${NC}"
echo 'CONFIG=$(bashio::config)'
echo ""
echo -e "${YELLOW}# Get specific config value:${NC}"
echo 'AUTO_LAUNCH=$(bashio::config "auto_launch_codex")'
echo ""
echo -e "${YELLOW}# Call Supervisor API:${NC}"
echo 'supervisor-api /core/info'
echo ""
echo -e "${YELLOW}# Use bashio for logging:${NC}"
echo 'bashio::log.info "Message"'
echo 'bashio::log.error "Error message"'
echo ""

# WebSocket example (requires additional setup)
echo "════════════════════════════════════════════════════════════════"
echo "For advanced Home Assistant integration (entities, automations):"
echo ""
echo "1. Use the WebSocket API for real-time entity access"
echo "2. Install 'websocat' or use Node.js WebSocket libraries"
echo "3. Connect to: ws://supervisor/core/websocket"
echo ""
echo "Example WebSocket authentication flow:"
echo "Use Home Assistant-supported clients that can read credentials securely."
echo ""

# Python example for entity control
echo "════════════════════════════════════════════════════════════════"
echo "Shell example for entity control through the brokered helper:"
echo ""
cat << 'EOF'
supervisor-api /core/api/states
supervisor-api -X POST /core/api/services/light/turn_on \
  -H 'Content-Type: application/json' \
  -d '{"entity_id":"light.living_room"}'
EOF

echo ""
echo "════════════════════════════════════════════════════════════════"
echo -e "${GREEN}✓ API access is now enabled for this add-on!${NC}"
echo ""
echo "Use supervisor-api or ha for brokered Home Assistant/Supervisor access."
echo ""
