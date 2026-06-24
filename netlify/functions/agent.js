exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: "ANTHROPIC_API_KEY not set in Netlify environment variables." }) };
  }

  let task;
  try {
    task = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid request body." }) };
  }

  const prompt = buildPrompt(task);

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 4000,
        system: buildSystemPrompt(task),
        messages: [{ role: "user", content: prompt }]
      })
    });

    const data = await res.json();

    if (!res.ok) {
      return {
        statusCode: res.status,
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ error: data.error?.message || "Anthropic API error" })
      };
    }

    const output = data.content?.map(b => b.text || "").join("") || "No output returned.";

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      },
      body: JSON.stringify({ output })
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: err.message })
    };
  }
};

// ── SYSTEM PROMPT ─────────────────────────────────────────────────────────────
function buildSystemPrompt(task) {
  const clientContext = {
    TCC: `You are a senior marketing strategist for Texas Cannabis Clinic (TCC), a Texas medical marijuana clinic. TCC operates under the Texas Compassionate Use Program (TCUP). Patients seek relief from qualifying conditions like PTSD, chronic pain, epilepsy, and cancer. Tone: compassionate, clear, trustworthy — never clinical or cold. The audience is often skeptical first-timers who need reassurance.`,
    "H&S": `You are a senior marketing strategist for Horse + Bow (H&S), a premium wellness and integrative medicine brand with equestrian and lifestyle roots. Services include Direct Primary Care (DPC), functional medicine, and community events. Tone: warm, premium, community-forward — like a knowledgeable friend, not a brochure.`,
    GT4: `You are a senior marketing strategist for GT4, a motorsport performance and driver development brand targeting enthusiast drivers and track day participants. Tone: authoritative, enthusiast-forward, specific — this audience knows their stuff, don't talk down to them.`,
    Cody: `You are a senior marketing strategist for Cody Young, a personal brand in the fitness and performance coaching space. Tone: energetic, direct, results-focused.`
  };

  const typeContext = {
    EMAIL: `You are also an expert email copywriter with deep knowledge of Salesforce Marketing Cloud. Deliverables should be paste-ready into an ESP. Always include subject lines (3 options, under 50 chars), preview text, full body copy, and CTA button text.`,
    SEO: `You are also an expert SEO strategist. Deliverables should be immediately actionable — specific URLs, exact copy, effort estimates (S/M/L), and expected impact. No vague recommendations.`,
    CONTENT: `You are also an expert content strategist and writer. Deliverables should be production-ready — full page copy, structured briefs, or topical maps that a writer or developer can execute without further briefing.`,
    PAID: `You are also an expert paid media strategist across Google Ads and Meta Ads. Deliverables should include specific ad copy variations, targeting recommendations, and budget guidance.`,
    OPS: `You are also an expert agency operations lead. Deliverables should be SOPs or checklists written for zero assumed knowledge — explicit steps, platform paths, defined acronyms.`
  };

  const client = clientContext[task.client] || `You are a senior marketing strategist for ${task.client}.`;
  const type = typeContext[task.type] || "";

  return `${client}\n\n${type}\n\nAlways format output with clear section headers using ##. Be specific and production-ready. The output goes directly to execution — no further briefing will happen.`;
}

// ── PROMPT BUILDER ─────────────────────────────────────────────────────────────
function buildPrompt(task) {
  const typeInstructions = {
    EMAIL: `
Deliver complete email copy including:
- 3 subject line options (labeled A/B/C, each under 50 characters)
- Preview text for each subject line
- Full body copy formatted in clear paragraphs (HTML-friendly)
- 2 CTA button text options
- P.S. line if relevant for urgency or social proof
- Brief deployment note: which list segment, recommended send time`,

    SEO: `
Deliver a specific, actionable SEO output including:
- Prioritized action plan with exact URLs, effort estimates (S/M/L), and expected impact
- Any copy assets needed (title tags 50-60 chars, meta descriptions 145-158 chars, H1 options)
- What to monitor and when to reassess
- Clear owner/executor for each action item`,

    CONTENT: `
Deliver production-ready content including:
- Full page copy with headline, all body sections, FAQ if relevant, and CTAs
- OR a complete content brief with: target keyword, outline (H2s + H3s), word count, internal links, and CTA
- SEO metadata: title tag and meta description
- Tone notes and any client-specific language to use or avoid`,

    PAID: `
Deliver a specific paid media plan including:
- Campaign structure recommendation with rationale
- Ad copy variations: 3 headlines (30 chars max), 2 descriptions (90 chars max) per ad set
- Targeting recommendations: audiences, match types, or interest categories
- Budget guidance and bid strategy
- Key metrics to watch in week 1`,

    OPS: `
Deliver a clear operational document including:
- Step-by-step instructions with no assumed knowledge
- Platform navigation paths where relevant (Settings > X > Y)
- Defined acronyms and terms
- Common failure points and how to avoid them
- A checklist summary at the end`
  };

  const instructions = typeInstructions[task.type] || `Deliver a complete, actionable output for this task. Be specific and production-ready.`;

  return `# Task: ${task.name}

**Client:** ${task.client}
**Type:** ${task.type}
**Priority:** ${task.priority}
**Context:** ${task.summary || "No additional context provided."}
${task.notes ? `**Additional notes:** ${task.notes}` : ""}

## What to deliver

${instructions}

---

Start your output immediately — no preamble needed.`;
}
