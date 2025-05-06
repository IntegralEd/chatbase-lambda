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
    const { assistant_id, message, chat_session_id, tenant_id, flush } = JSON.parse(event.body || '{}');

    if (!assistant_id || !message || !chat_session_id) {
      return { statusCode: 400, body: JSON.stringify({ error: "Missing required fields" }) };
    }

    // Call Chatbase
    const chatbaseRes = await fetch("https://www.chatbase.co/api/v1/chat", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${CHATBASE_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ assistant_id, message, chat_session_id, stream: false })
    });
    const response = await chatbaseRes.json();
    const bot_response = response.text || JSON.stringify(response);

    // Cache message pair in Redis
    const logItem = JSON.stringify({
      user: message,
      bot: bot_response,
      timestamp: new Date().toISOString()
    });
    const redisKey = `chatlog:${chat_session_id}`;
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
              Chat_Session_ID: chat_session_id,
              Assistant_ID: assistant_id,
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
