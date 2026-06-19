  /** Block type — maps to a deterministic BlockRenderer */
  type: z.enum(["standings_table", "empty_state", "odds_table", "form_table", "form_pills", "squad_list", "venues_grid", "venue_card", "match_list", "match_card"]),
  /** Owning agent domain — enforced by PatchEngine */
  domain: z.enum(["standings", "odds", "form", "squad", "venues", "matches"]),