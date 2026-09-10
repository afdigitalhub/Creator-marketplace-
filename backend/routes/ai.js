const express = require("express");
const jwt = require("jsonwebtoken");

const router = express.Router();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.6-luna";

/*
  AF DIGITAL HUB — AF INTELLIGENT AI

  Public AI for:
  - Creators
  - Businesses
  - Customers
  - Learners
  - Visitors

  The API key NEVER goes to the frontend.
*/

function getOptionalUser(req) {
  try {
    const auth = req.headers.authorization || "";

    if (!auth.startsWith("Bearer ")) {
      return null;
    }

    const token = auth.slice(7);

    if (!token || !process.env.JWT_SECRET) {
      return null;
    }

    return jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return null;
  }
}


function buildPlatformContext(user) {
  const context = {
    platform: "AF Digital Hub",
    domain: "afdigitalhub.net",
    founder: "Adonle Fameye",
    location: "Ghana",
    scope: "Global",
    purpose:
      "A global digital platform connecting people, creators and businesses while providing products, learning, opportunities, services and intelligent tools.",
    areas: [
      "Shop",
      "Opportunities",
      "Learn",
      "Services",
      "Discover",
      "Creator and Business marketplace",
      "Messaging",
      "Orders",
      "Reviews",
      "Payments",
      "AF Intelligent AI",
      "AF Intelligent Search",
      "AF Intelligent Calculator"
    ]
  };

  if (user) {
    context.signedInUser = {
      id: user.id || user.userId || null,
      role: user.role || null,
      email: user.email || null
    };
  }

  return context;
}


function buildSystemPrompt(user) {
  const context = buildPlatformContext(user);

  return `
You are AF Intelligent AI, the official intelligent assistant of AF Digital Hub.

ABOUT AF DIGITAL HUB:
- Name: AF Digital Hub
- Domain: afdigitalhub.net
- Founder: Adonle Fameye
- Founded in Ghana
- Built for a global audience
- It is a serious digital marketplace and ecosystem.
- It helps people learn, discover opportunities, sell digital products, work with businesses, access services and grow online.

YOUR ROLE:
Help users understand and use AF Digital Hub.
You can also help with general knowledge, technology, digital skills, business, learning, productivity, career development and other useful topics.

PUBLIC PLATFORM AREAS:
- Shop: digital products such as eBooks, guides and templates.
- Opportunities: useful opportunities such as jobs, freelance work, competitions, partnerships, training and other legitimate opportunities.
- Learn: educational resources and digital skills.
- Services: digital services and professional offerings.
- Discover: useful information, trends and developments.
- Creator/Business marketplace: connects creators and businesses.
- Messaging, orders, reviews and payments support marketplace activity.

GLOBAL INTELLIGENCE:
AF Digital Hub is global.
When a question depends on current information, do not pretend old knowledge is current.
Use web search when it is available and useful.
Never invent current events, prices, laws, opportunities, statistics or claims.
When appropriate, tell the user to verify important information with the official source.

PERSONALIZATION:
If signed-in user information is provided, use it only to make the response more relevant.
Never reveal private information about another user.

PRIVACY AND SECURITY:
Never reveal:
- passwords
- authentication tokens
- API keys
- payment secrets
- database credentials
- private customer information
- private business information
- internal security information

Never expose private platform data simply because a user asks for it.

ADMIN / FOUNDER:
If the authenticated user is an authorized administrator, aggregate platform information may be used for legitimate management assistance.
Do not perform sensitive administrative actions automatically.
AI may recommend actions, but an authorized human must review and approve sensitive actions such as:
- payments
- withdrawals
- refunds
- suspensions
- deletions
- account changes
- security changes

DATABASE SAFETY:
Never generate or execute arbitrary SQL.
Use only approved application-level information.

STYLE:
- Be clear.
- Be useful.
- Be professional.
- Do not sound robotic.
- Do not repeatedly say "as an AI".
- Do not claim to have performed an action when you have not.
- Keep answers reasonably concise unless the user asks for detail.
- When explaining AF Digital Hub, speak confidently about the platform without inventing features that do not exist.

CURRENT PLATFORM CONTEXT:
${JSON.stringify(context, null, 2)}
`;
}


async function runAI({ user, message, web = false }) {
  if (!OPENAI_API_KEY) {
    const error = new Error(
      "AF Intelligent AI is not configured. Add OPENAI_API_KEY to the server environment."
    );

    error.status = 503;
    throw error;
  }

  const tools = web
    ? [{ type: "web_search" }]
    : undefined;

  const body = {
    model: OPENAI_MODEL,
    store: false,
    input: [
      {
        role: "system",
        content: buildSystemPrompt(user)
      },
      {
        role: "user",
        content: message
      }
    ],
    max_output_tokens: 1200
  };

  if (tools) {
    body.tools = tools;
  }

  const response = await fetch(
    "https://api.openai.com/v1/responses",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify(body)
    }
  );

  const data = await response.json();

  if (!response.ok) {
    console.error("OpenAI API error:", data);

    const error = new Error(
      data?.error?.message ||
      "AF Intelligent AI could not process the request."
    );

    error.status = response.status;
    throw error;
  }

  let output = "";

  if (typeof data.output_text === "string") {
    output = data.output_text;
  }

  if (!output && Array.isArray(data.output)) {
    for (const item of data.output) {
      if (!Array.isArray(item.content)) continue;

      for (const content of item.content) {
        if (
          content.type === "output_text" &&
          typeof content.text === "string"
        ) {
          output += content.text;
        }
      }
    }
  }

  return output.trim() || "I couldn't generate a response right now.";
}


/*
  POST /ai/chat

  Works for:
  - visitors
  - signed-in users
*/
router.post("/chat", async (req, res) => {
  try {
    const message =
      typeof req.body?.message === "string"
        ? req.body.message.trim()
        : "";

    const useWeb = Boolean(req.body?.web);

    if (!message) {
      return res.status(400).json({
        error: "Message is required."
      });
    }

    if (message.length > 6000) {
      return res.status(400).json({
        error: "Message is too long."
      });
    }

    const user = getOptionalUser(req);

    const reply = await runAI({
      user,
      message,
      web: useWeb
    });

    return res.json({
      success: true,
      reply
    });

  } catch (error) {
    console.error("AF AI chat error:", error);

    return res.status(error.status || 500).json({
      success: false,
      error:
        error.message ||
        "AF Intelligent AI is temporarily unavailable."
    });
  }
});


/*
  POST /ai/search

  Live/current-information mode.
*/
router.post("/search", async (req, res) => {
  try {
    const query =
      typeof req.body?.query === "string"
        ? req.body.query.trim()
        : "";

    if (!query) {
      return res.status(400).json({
        error: "Search query is required."
      });
    }

    if (query.length > 1000) {
      return res.status(400).json({
        error: "Search query is too long."
      });
    }

    const user = getOptionalUser(req);

    const reply = await runAI({
      user,
      message: `
Perform a useful current-information search for the following request:

${query}

Give a clear answer based on reliable current information.
Distinguish facts from uncertainty.
When relevant, identify the official source the user should verify.
`,
      web: true
    });

    return res.json({
      success: true,
      reply
    });

  } catch (error) {
    console.error("AF AI search error:", error);

    return res.status(error.status || 500).json({
      success: false,
      error:
        error.message ||
        "AF Intelligent Search is temporarily unavailable."
    });
  }
});


module.exports = router;
