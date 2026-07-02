exports.handler = async (event) => {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

  if (!ANTHROPIC_KEY) {
    return {
      statusCode: 500,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "ANTHROPIC_API_KEY not set." })
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 50000);

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 2000,
        system: `You fetch tasks from a Notion database and return ONLY a raw JSON array — no markdown, no backticks, no explanation, no code fences. Just the raw JSON array starting with [ and ending with ].

Each task object must have exactly these fields:
- id: the Notion page ID
- name: the task title
- client: the client name (e.g. TCC, H&S, GT4, Cody)
- type: the Task Type property (SEO, CONTENT, EMAIL, PAID, OPS)
- priority: High, Medium, or Low
- status: "Not started", "In progress", or "Done"
- week: the Week property value
- due: due date as YYYY-MM-DD string or ""
- url: the Notion page URL
- summary: a brief description from the page content or properties
- notes: any additional notes

Return ONLY the JSON array. No other text.`,
        mcp_servers: [{
          type: "url",
          url: "https://mcp.notion.com/mcp",
          name: "notion"
        }],
        messages: [{
          role: "user",
          content: `Fetch all tasks from Notion data source collection://92fdc628-cd81-41c5-a510-16c799e0de78. Include all tasks regardless of status. Return ONLY the raw JSON array.`
        }]
      })
    });

    clearTimeout(timeout);
    const data = await res.json();

    if (!res.ok) {
      return {
        statusCode: res.status,
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ error: data.error?.message || "Anthropic API error" })
      };
    }

    const text = data.content?.map(b => b.text || "").join("") || "";

    // Extract JSON array from response
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) {
      return {
        statusCode: 500,
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ error: "Could not parse task list from Notion response." })
      };
    }

    const tasks = JSON.parse(match[0]);

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      },
      body: JSON.stringify({ tasks })
    };

  } catch (err) {
    clearTimeout(timeout);
    return {
      statusCode: 500,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({
        error: err.name === "AbortError"
          ? "Notion sync timed out — try again"
          : err.message
      })
    };
  }
};
