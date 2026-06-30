Feature: Hybrid Browser Lane Shared Execution

  Scenario: AI and Human share the identical session
    Given the application requests a Hybrid Browser Lane session
    When the system launches a real Chrome process with port 9222 enabled
    And the frontend UI connects to the stream endpoint
    Then the human user must see the browser viewport rendered in the app
    And the AI Agent must successfully connect to "ws://localhost:9222"

  Scenario: Human handles secure authentication
    Given the Browser Lane session is at "https://secure-vendor.com/login"
    When the AI encounters a login wall
    Then the AI triggers "pauseForHumanAuth"
    And the system awaits the human to input credentials and solve CAPTCHA
    When the human completes authentication and the URL changes to "/dashboard"
    Then the AI resumes operations on the authenticated DOM state

  Scenario: AI actions are visible and logged
    Given an active Hybrid Browser Lane session
    When the AI executes "click" on "#export-data"
    Then the human must see the mouse interaction and subsequent UI changes visually
    And a ToolTraceLog event with action "CLICK" and target "#export-data" must be emitted

  Scenario: Browser core is not a hidden crawler
    Given the human asks to inspect "https://example.com"
    When the assistant opens the page
    Then the assistant uses one browser page session by default
    And the rendered page status, active URL, title, DOM, screenshot, and errors are exposed
    And the assistant must not secretly crawl, parallel-fetch, retry-loop, fan out, stealth, or bypass site challenges
    When the human explicitly asks for multi-source research
    Then the assistant may switch to a bounded research or crawler layer with audit logs
