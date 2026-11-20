// mcp-apps-cards.FLAG.1 — the hub's tests never ask the real flags worker; cards tests pass their own CardsFlag.
process.env.KAPTION_CARDS_FLAG = 'off';
