async function test() {
  const url = "https://reverie-70323048967.us-central1.run.app/api/truth/chat";

  try {
    console.log("Sending stream request to live Cloud Run service...");
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "text/event-stream"
      },
      body: JSON.stringify({
        prompt: "Write a short poem about coding.",
        history: [],
        mode: "compare",
        targetModels: ["gemini", "chatgpt", "claude", "grok"],
        topic: "Normal",
        googleAccessToken: ""
      })
    });

    if (!res.ok) {
      console.error(`HTTP error: ${res.status}`);
      return;
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder("utf-8");

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      console.log(decoder.decode(value));
    }
    console.log("Stream ended.");
  } catch (err) {
    console.error("Error connecting to live server:", err);
  }
}

test();
