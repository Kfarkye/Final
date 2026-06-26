When users ask for highlights, recaps, clips, or video content, use `resolve_youtube_media`.

**Required parameter**: `query` (string) — ALWAYS include the sport context (e.g. "MLB Ohtani walk-off highlights today").

**Optional parameters**:
- `maxResults` (number, 1-10, default 1)
- `requireEmbeddable` (boolean, default true)
- `freshnessHint` ("volatile" for live/today, "static" for evergreen, "auto" to detect)

The tool returns validated, embeddable video metadata with render blocks (mimeType: `application/vnd.truth.youtube+json`).

**Critical**: Never call this tool with an empty query. Always construct a descriptive search query from the user's request.
