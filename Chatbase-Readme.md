# 🏗️ Architecture Overview

This service acts as a multi-tenant proxy, routing chat messages from clients to the correct Chatbase assistant using a combination of AWS API Gateway, Lambda, and Redis for fast tenant-to-assistant mapping.

## 📡 Traffic Flow

- **Client** sends a chat message (`tenant_id`, `message`, `chat_session_id`) to the API Gateway endpoint.
- **API Gateway** forwards the request to the Lambda (`handler.js`).
- **Lambda**:
  - Looks up `tenant_id` in Redis to get `assistant_id`
  - Sends the message to the Chatbase API
  - Returns the Chatbase response back to the client

### ASCII Flowchart

+--------+ HTTPS POST +-------------+ Lambda Invoke +-----------+
| Client | -----------------> | API Gateway | --------------------> | Lambda |
+--------+ +-------------+ +-----------+
|
| 1. Parse request
| 2. Lookup tenant_id in Redis
v
+-------------+
| Redis |
+-------------+
|
| assistant_id
v
+-----------------+
| Chatbase API |
+-----------------+
|
| response
v
+--------+ <----------------- +-------------+ <----------------- +-----------+
| Client | JSON resp | API Gateway | Lambda resp | Lambda |
+--------+ +-------------+ +-----------+

## 🗃️ Redis-Cached Fields (per Registry)

The following fields are actively cached in Redis for fast access, as defined in the schema registry. TTL for all fields is 3600 seconds (1 hour).

### Chatbase_Conversations
| Field Name                  | Field Type         |
|----------------------------|-------------------|
| AT_Chatbase_Conversation_ID | formula           |
| Start_Time                  | dateTime          |
| Created_Time                | createdTime       |
| Chatbase_Messages           | multipleRecordLinks |
| Org_ID                      | singleLineText    |
| Chatbase_Assistant_ID       | singleLineText    |
| IE_All_Users                | multipleRecordLinks |
| Chatbase_Conversation_ID    | singleLineText    |

### Chatbase_Messages
| Field Name                  | Field Type         |
|----------------------------|-------------------|
| Chatbase_Conversation_ID    | multipleRecordLinks |
| Start_Time                  | dateTime          |
| Created_Time                | createdTime       |
| Message_Tags                | multipleRecordLinks |
| Last_Updated                | lastModifiedTime  |
| Message_Text                | multilineText     |
| Log_This_Thread             | checkbox          |
| Role                        | singleSelect      |
| Message_Attachment          | multipleAttachments |
| Chatbase_Conversations      | multipleRecordLinks |
| Chatbase_Message_ID         | singleLineText    |

## 📦 `chatbase-proxy` — Multi-Tenant Chatbase Lambda

A minimal AWS Lambda + API Gateway setup to proxy chat messages to tenant-specific Chatbase assistants. Supports Redis lookup for tenant-to-assistant mapping.

---

## 🧰 Features

- Routes user input to correct Chatbase assistant per `tenant_id`
- Fast lookup with Redis
- Deployed via AWS SAM / CloudFormation
- Returns structured JSON for frontend display

---

## 📁 Project Structure

chatbase-proxy/
├── handler.js
├── lambda.yaml
├── .env (optional for local)
└── seed-redis.js (optional setup script)

yaml
Copy
Edit

---

## 🚀 Deployment via AWS SAM

```bash
sam build
sam deploy --guided
🧾 lambda.yaml
yaml
Copy
Edit
AWSTemplateFormatVersion: '2010-09-09'
Transform: AWS::Serverless-2016-10-31
Description: Multi-tenant Chatbase Proxy Lambda

Globals:
  Function:
    Timeout: 10
    Runtime: nodejs18.x
    Environment:
      Variables:
        CHATBASE_API_KEY: your-chatbase-api-key
        REDIS_URL: your-redis-connection-url

Resources:
  ChatbaseProxyFunction:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: .
      Handler: handler.handler
      Events:
        ProxyAPI:
          Type: Api
          Properties:
            Path: /chatbase/proxy
            Method: POST
            RestApiId: !Ref ChatbaseApi

  ChatbaseApi:
    Type: AWS::Serverless::Api
    Properties:
      Name: ChatbaseProxyAPI
      StageName: prod
      Cors:
        AllowMethods: "'POST,OPTIONS'"
        AllowHeaders: "'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Tenant-Id'"
        AllowOrigin: "'*'"

Outputs:
  ApiUrl:
    Description: "API Gateway endpoint URL"
    Value: !Sub "https://${ChatbaseApi}.execute-api.${AWS::Region}.amazonaws.com/prod/chatbase/proxy"
🧠 handler.js
js
Copy
Edit
const fetch = require('node-fetch');
const Redis = require('ioredis');

const redis = new Redis(process.env.REDIS_URL);

exports.handler = async (event) => {
  try {
    const { tenant_id, message, chat_session_id } = JSON.parse(event.body || '{}');

    if (!tenant_id || !message || !chat_session_id) {
      return { statusCode: 400, body: JSON.stringify({ error: "Missing parameters" }) };
    }

    const assistant_id = await redis.get(`chatbase:tenant:${tenant_id}`);
    if (!assistant_id) {
      return { statusCode: 404, body: JSON.stringify({ error: "Assistant not found for tenant" }) };
    }

    const res = await fetch("https://www.chatbase.co/api/v1/chat", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.CHATBASE_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        assistant_id,
        message,
        chat_session_id,
        stream: false
      })
    });

    const json = await res.json();
    return {
      statusCode: 200,
      body: JSON.stringify(json)
    };

  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: "Internal error" }) };
  }
};
🪄 seed-redis.js (Optional Redis Seeder)
js
Copy
Edit
const Redis = require('ioredis');
const redis = new Redis(process.env.REDIS_URL);

// Example mapping
const seed = async () => {
  await redis.set('chatbase:tenant:elpl', 'cb-asst-123456');
  await redis.set('chatbase:tenant:merit', 'cb-asst-789abc');
  console.log("Redis seed complete.");
  process.exit(0);
};

seed();
Run it:

bash
Copy
Edit
REDIS_URL=redis://... node seed-redis.js
🔒 Security Notes
Protect Redis with VPC, auth, or IP allowlist

Use AWS Secrets Manager for API keys in production

Add custom request auth headers if this API will be publicly exposed

# 🚧 Deployment Status & Current Blockers

**Last updated:** $(date)

## What is Working
- AWS Lambda function is deployed and accessible via API Gateway.
- Lambda is configured with environment variables for Chatbase, Redis, and Airtable.
- Redis (ElastiCache) cluster is provisioned and available.
- NAT Gateway is set up and private subnet route table points to it for internet access.
- Lambda can be invoked via API Gateway and receives requests.

## Current Blockers
- Lambda **cannot connect to Redis**: `connect ETIMEDOUT` error in CloudWatch logs.
  - Likely cause: Redis security group does not allow inbound 6379 from Lambda's security group, or subnet association/routing issue.
- Lambda **cannot reach Chatbase API**: `connect ETIMEDOUT` error in logs.
  - Indicates Lambda may still not have outbound internet access, or NAT Gateway/subnet association is not fully correct.

## Next Steps
- Double-check Redis security group inbound rules (allow 6379 from Lambda SG).
- Confirm Lambda and Redis are in the same VPC and routable subnets.
- Verify Lambda's subnets are associated with the route table pointing to the NAT Gateway.
- Test Lambda again after making these changes.

