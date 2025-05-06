const fetch = require('node-fetch');
const Redis = require('ioredis');

const redis = new Redis(process.env.REDIS_URL);

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE_NAME = process.env.AIRTABLE_TABLE_NAME;
const CHATBASE_API_KEY = process.env.CHATBASE_API_KEY;

const LOG_THRESHOLD = 3; // Write to Airtable after this many message pairs

exports.handler = async (event) => {
  try {
    const {
      chatbotId, // allow override, but default to env
      messages,
      conversationId,
      stream = false,
      temperature = 0,
      model,
      tenant_id,
      flush
    } = JSON.parse(event.body || '{}');

    const resolvedChatbotId = chatbotId || process.env.GOALSETTER_ASSISTANT_ID;

    if (!resolvedChatbotId || !messages || !Array.isArray(messages) || messages.length === 0) {
      return { statusCode: 400, body: JSON.stringify({ error: "Missing required fields" }) };
    }

    // Build Chatbase API payload
    const chatbasePayload = {
      chatbotId: resolvedChatbotId,
      messages,
      stream,
      temperature,
    };
    if (model) chatbasePayload.model = model;
    if (conversationId) chatbasePayload.conversationId = conversationId;

    console.log('Using Chatbase API key:', CHATBASE_API_KEY ? 'set' : 'NOT SET');

    // Call Chatbase
    const chatbaseRes = await fetch("https://www.chatbase.co/api/v1/chat", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${CHATBASE_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(chatbasePayload)
    });
    const response = await chatbaseRes.json();
    const bot_response = response.text || JSON.stringify(response);

    // Cache message pair in Redis (optional: you may want to cache the whole messages array)
    const logItem = JSON.stringify({
      user: messages[messages.length - 1].content,
      bot: bot_response,
      timestamp: new Date().toISOString()
    });
    const redisKey = `chatlog:${conversationId}`;
    await redis.rpush(redisKey, logItem);

    // Check if we should flush
    const logLen = await redis.llen(redisKey);
    if (flush || logLen >= LOG_THRESHOLD) {
      const fullLog = await redis.lrange(redisKey, 0, -1);
      await redis.del(redisKey); // Clear cache after flush

      const airtablePayload = {
        records: fullLog.map((entry, idx) => {
          const parsed = JSON.parse(entry);
          return {
            fields: {
              Chat_Session_ID: conversationId,
              Assistant_ID: resolvedChatbotId,
              User_Message: parsed.user,
              Assistant_Response: parsed.bot,
              Tenant_ID: tenant_id || "unknown",
              Message_Index: idx + 1,
              Source: "chatbase"
            }
          };
        })
      };

      // Write to Airtable
      await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE_NAME)}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${AIRTABLE_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(airtablePayload)
      });
    }

    // Return live response to frontend
    return {
      statusCode: 200,
      body: JSON.stringify(response)
    };

  } catch (err) {
    console.error(err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Internal error" })
    };
  }
};
