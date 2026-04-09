const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { Redis } = require('@upstash/redis');
const path = require('path');
const crypto = require('crypto');

const app = express();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

app.use(express.json());
app.use(express.static('public'));

const ROOM_TTL = 86400; // 24 hours in seconds

// Helper: generate random code/token
function randomCode(len) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
  let result = '';
  const bytes = crypto.randomBytes(len);
  for (let i = 0; i < len; i++) result += chars[bytes[i] % chars.length];
  return result;
}

function randomToken() {
  return crypto.randomBytes(24).toString('hex');
}

// Helper: get room from Redis
async function getRoom(code) {
  const room = await redis.get(`room:${code}`);
  return room || null;
}

// Helper: save room to Redis with TTL
async function saveRoom(code, room) {
  await redis.set(`room:${code}`, room, { ex: ROOM_TTL });
}

// Helper: identify role from token
function getRoleByToken(room, token) {
  if (room.tokenA === token) return 'a';
  if (room.tokenB === token) return 'b';
  return null;
}

// Helper: simple rate limiting per IP
// Returns true if allowed, false if rate limited
async function checkRateLimit(ip, action, maxPerHour) {
  const key = `rate:${action}:${ip}`;
  try {
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, 3600); // 1 hour window
    }
    return count <= maxPerHour;
  } catch (e) {
    return true; // fail open if Redis is down
  }
}

// Get client IP (works behind Vercel proxy)
function getIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown';
}

// ─── API: Create Room ───
app.post('/api/room/create', async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: '请输入昵称' });

  // Rate limit: 10 rooms per IP per hour
  if (!await checkRateLimit(getIP(req), 'create', 10)) {
    return res.status(429).json({ error: '操作过于频繁，请稍后再试' });
  }

  const code = randomCode(4);
  const token = randomToken();

  const room = {
    code,
    createdAt: Date.now(),
    nameA: name.trim(),
    nameB: null,
    tokenA: token,
    tokenB: null,
    inputA: null,
    inputB: null,
    forA: null,
    forB: null,
    forBoth: null,
    consentA: false,
    consentB: false,
    feelingSummaryA: null,
    feelingSummaryB: null,
    historyA: [],
    historyB: [],
    status: 'waiting',   // waiting | analyzed
    analyzing: false,
  };

  await saveRoom(code, room);
  res.json({ code, token, role: 'a' });
});

// ─── API: Join Room ───
app.post('/api/room/join', async (req, res) => {
  const { code, name } = req.body;
  if (!code || !name || !name.trim()) return res.status(400).json({ error: '请输入房间码和昵称' });

  const room = await getRoom(code.toUpperCase());
  if (!room) return res.status(404).json({ error: '房间不存在或已过期' });
  if (room.tokenB) return res.status(400).json({ error: '房间已满' });

  const token = randomToken();
  room.nameB = name.trim();
  room.tokenB = token;
  await saveRoom(room.code, room);

  res.json({ code: room.code, token, role: 'b', nameA: room.nameA });
});

// ─── API: Submit Input ───
app.post('/api/room/submit', async (req, res) => {
  const { code, token, input } = req.body;
  if (!code || !token || !input || !input.trim()) return res.status(400).json({ error: '缺少必要信息' });

  const room = await getRoom(code);
  if (!room) return res.status(404).json({ error: '房间不存在或已过期' });

  const role = getRoleByToken(room, token);
  if (!role) return res.status(403).json({ error: '身份验证失败' });

  // Store input
  if (role === 'a') room.inputA = input.trim();
  else room.inputB = input.trim();

  // Check if both submitted
  if (room.inputA && room.inputB && !room.analyzing && room.status !== 'analyzed') {
    // Try to acquire analysis lock atomically
    // Use setnx: only one request can set this key
    const lockKey = `lock:${code}`;
    const acquired = await redis.setnx(lockKey, '1');
    if (acquired) {
      await redis.expire(lockKey, 120); // lock expires in 2 min max
      room.analyzing = true;
      await saveRoom(code, room);

      try {
        // Run analysis
        const result = await runAnalysis(room);
        room.forA = result.forA;
        room.forB = result.forB;
        room.forBoth = result.forBoth;
        room.feelingSummaryA = result.feelingSummaryA;
        room.feelingSummaryB = result.feelingSummaryB;
        room.status = 'analyzed';
        room.analyzing = false;
        await saveRoom(code, room);
        await redis.del(lockKey);
        return res.json({ status: 'analyzed' });
      } catch (e) {
        room.analyzing = false;
        await saveRoom(code, room);
        await redis.del(lockKey);
        return res.status(500).json({ error: '分析失败：' + e.message });
      }
    } else {
      // Another request is already analyzing, just save and return
      await saveRoom(code, room);
      return res.json({ status: 'analyzing' });
    }
  }

  await saveRoom(code, room);
  res.json({ status: room.status === 'analyzed' ? 'analyzed' : 'waiting' });
});

// ─── API: Poll Status ───
app.get('/api/room/status', async (req, res) => {
  const { code, token } = req.query;
  if (!code || !token) return res.status(400).json({ error: '缺少参数' });

  const room = await getRoom(code);
  if (!room) return res.status(404).json({ error: '房间不存在或已过期' });

  const role = getRoleByToken(room, token);
  if (!role) return res.status(403).json({ error: '身份验证失败' });

  const otherJoined = !!room.tokenB;
  const otherSubmitted = role === 'a' ? !!room.inputB : !!room.inputA;
  const mySubmitted = role === 'a' ? !!room.inputA : !!room.inputB;

  // Only return what this role is allowed to see
  const result = {
    status: room.analyzing ? 'analyzing' : room.status,
    nameA: room.nameA,
    nameB: room.nameB,
    otherJoined,
    mySubmitted,
    otherSubmitted,
    myName: role === 'a' ? room.nameA : room.nameB,
    otherName: role === 'a' ? room.nameB : room.nameA,
    consentA: room.consentA,
    consentB: room.consentB,
  };

  if (room.status === 'analyzed') {
    result.myAnalysis = role === 'a' ? room.forA : room.forB;
    result.forBoth = (room.consentA && room.consentB) ? room.forBoth : null;
    result.myHistory = role === 'a' ? room.historyA : room.historyB;
  }

  res.json(result);
});

// ─── API: Consent ───
app.post('/api/room/consent', async (req, res) => {
  const { code, token } = req.body;
  const room = await getRoom(code);
  if (!room) return res.status(404).json({ error: '房间不存在或已过期' });

  const role = getRoleByToken(room, token);
  if (!role) return res.status(403).json({ error: '身份验证失败' });

  if (role === 'a') room.consentA = true;
  else room.consentB = true;
  await saveRoom(room.code, room);

  res.json({ consentA: room.consentA, consentB: room.consentB, forBoth: (room.consentA && room.consentB) ? room.forBoth : null });
});

// ─── API: Follow-up ───
app.post('/api/room/followup', async (req, res) => {
  const { code, token, question } = req.body;
  if (!question || !question.trim()) return res.status(400).json({ error: '请输入内容' });

  // Rate limit: 30 follow-ups per IP per hour
  if (!await checkRateLimit(getIP(req), 'followup', 30)) {
    return res.status(429).json({ error: '追问过于频繁，请稍后再试' });
  }
  const room = await getRoom(code);
  if (!room) return res.status(404).json({ error: '房间不存在或已过期' });
  if (room.status !== 'analyzed') return res.status(400).json({ error: '请等待分析完成' });

  const role = getRoleByToken(room, token);
  if (!role) return res.status(403).json({ error: '身份验证失败' });

  const currentName = role === 'a' ? room.nameA : room.nameB;
  const otherName = role === 'a' ? room.nameB : room.nameA;
  const ownInput = role === 'a' ? room.inputA : room.inputB;
  const ownHistory = role === 'a' ? room.historyA : room.historyB;
  const ownFeelingSummary = role === 'a' ? room.feelingSummaryA : room.feelingSummaryB;
  const otherFeelingSummary = role === 'a' ? room.feelingSummaryB : room.feelingSummaryA;

  const historyText = ownHistory.map(h =>
    `${currentName} 说：${h.question}\nAI 回应：${h.answer}`
  ).join('\n\n');

  const prompt = `你是一位专业的关系调解顾问。以下是背景：

${currentName} 最初的描述：${ownInput}

${otherName} 目前的感受状态（抽象摘要，不含原话）：${otherFeelingSummary || '暂无'}

${historyText ? `${currentName} 之前的追问记录：\n${historyText}` : ''}

现在，${currentName} 有新的想法：
${question.trim()}

请直接跟 ${currentName} 说话，用"你"。提到另一方时用"${otherName}"。

重要规则：
- 你可以基于 ${otherName} 的感受摘要来帮助 ${currentName} 理解对方，但不要编造摘要中没有的具体细节。
- 不要透露 ${otherName} 说过的任何具体原话或事件描述。不要引用、转述、复述任何一方的原话，不要用引号包裹来自对方的表述，不要出现"${otherName}说过……""${otherName}提到……"这样的句式。用你自己的语言重新描述感受和需求。
- 要具体、有洞察力。不要说正确的废话（"沟通很重要""你的感受是合理的"）。如果 ${currentName} 表达了困惑，试着帮 ta 理清困惑背后的心理逻辑。如果 ${currentName} 表达了愤怒或委屈，先接住这个情绪，再帮 ta 看到可能忽略的角度。
- 150-200 字。用中文回答。语气温和、真诚、有洞察力。`;

  try {
    // Step 1: Generate response
    const message = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 768,
      messages: [{ role: 'user', content: prompt }]
    });
    const answer = message.content[0].text.trim();

    // Step 2: Update this party's feeling summary
    const updatePrompt = `以下是 ${currentName} 在一次关系调解对话中的最新表述：

${currentName} 之前的感受摘要：${ownFeelingSummary || '暂无'}

${currentName} 的新表述：${question.trim()}

请基于新表述更新 ${currentName} 的感受摘要。摘要只包含情绪、需求和在意的核心点，不包含任何具体事件细节、对话原文或指向性描述。不超过80字。只输出摘要内容，不要加标题或前缀。`;

    const updateMsg = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 256,
      messages: [{ role: 'user', content: updatePrompt }]
    });
    const updatedSummary = updateMsg.content[0].text.trim();

    // Save to room
    const entry = { question: question.trim(), answer, ts: Date.now() };
    if (role === 'a') {
      room.historyA.push(entry);
      room.feelingSummaryA = updatedSummary;
    } else {
      room.historyB.push(entry);
      room.feelingSummaryB = updatedSummary;
    }
    await saveRoom(room.code, room);

    res.json({ answer });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Analysis Logic ───
async function runAnalysis(room) {
  const nA = room.nameA;
  const nB = room.nameB;

  const prompt = `你是一位专业的关系调解顾问。两个人（${nA} 和 ${nB}）在某件事上产生了分歧，他们分别描述了各自的感受。

${nA} 的描述：${room.inputA}

${nB} 的描述：${room.inputB}

请完成三部分分析。

隐私和引用规则（最高优先级，违反即失败）：
- 绝对不要引用、转述、复述任何一方的原话，包括加引号的直接引用和不加引号的间接引用。
- 不要出现类似"${nA}说过……""${nB}提到……""${nB}的原话是……""${nB}表示……"这样的句式。
- 不要用引号包裹任何来自双方描述中的表述。
- 你的任务是把对方的原话消化、理解之后，用你自己的语言重新描述对方的感受和需求。读者不应该能从你的分析中还原出对方说过的任何一句具体的话。

语气和风格要求（极其重要）：
- 像一个真正懂人的朋友在说话，不像一个咨询师在念教材。
- 要具体，不要抽象。不要说"对方感到受伤"就停下来——说清楚对方可能是在什么地方、因为什么心理机制而感到受伤的。尝试还原对方的内心过程，而不是给情绪贴标签。
- 可以做合理的心理推测（"也许""可能是"），但不要编造对方没有表达过的具体事实。
- 绝对不要说正确的废话，比如"你的感受是合理的""每个人都有自己的立场""沟通很重要"。这些话谁都会说，对理解没有任何帮助。
- 如果双方的描述里有互相矛盾的地方，不要回避，温和地指出来。
- 【给${nA}看】和【给${nB}看】每段 300 字以上，写充分，不要惜字。
- 【给双方】保持简短，150 字以内。

人称规则（极其重要，请严格遵守）：
- 在【给${nA}看】部分：读者是 ${nA}，用"你"指代 ${nA}，用"${nB}"指代另一方。绝对不要把"你"用来指代 ${nB}。
- 在【给${nB}看】部分：读者是 ${nB}，用"你"指代 ${nB}，用"${nA}"指代另一方。绝对不要把"你"用来指代 ${nA}。
- 描述"对方的视角"时，主语必须是对方的名字，不能用"你"。例如："${nB}意识到了自己的行为给你带来了困扰"（正确），而不是"你意识到了自己的行为给你带来了困扰"（错误，主语混乱）。
- 每写完一句话，检查一下："你"是否指向当前的读者？如果不是，改成对方的名字。

【给${nA}看】
直接跟 ${nA} 说话（用"你"指代 ${nA}），帮助 ${nA} 理解 ${nB} 在这件事里的感受和需求。不评判任何一方。300 字以上。

【给${nB}看】
直接跟 ${nB} 说话（用"你"指代 ${nB}），帮助 ${nB} 理解 ${nA} 在这件事里的感受和需求。不评判任何一方。300 字以上。

【给双方】
指出双方各自在意的核心，以及一个具体的（不是泛泛的）前进方向。150 字以内。

请用中文回答，语气温和、真诚、有洞察力。`;

  const message = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2048,
    messages: [{ role: 'user', content: prompt }]
  });

  const text = message.content[0].text;
  const extract = (tag) => {
    const re = new RegExp(`【${tag}】\\s*([\\s\\S]*?)(?=【|$)`);
    const m = text.match(re);
    return m ? m[1].trim() : '';
  };

  // Generate initial feeling summaries
  const summaryPrompt = `基于以下两个人的描述，分别生成一份简短的感受摘要。摘要只包含情绪、需求和在意的核心点，不包含任何具体事件细节、对话原文或指向性描述。每份摘要不超过80字。

${nA} 的描述：${room.inputA}
${nB} 的描述：${room.inputB}

请用以下格式输出：

【${nA}的感受摘要】
（摘要内容）

【${nB}的感受摘要】
（摘要内容）`;

  const summaryMsg = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 512,
    messages: [{ role: 'user', content: summaryPrompt }]
  });

  const sText = summaryMsg.content[0].text;
  const extractSummary = (name) => {
    const re = new RegExp(`【${name}的感受摘要】\\s*([\\s\\S]*?)(?=【|$)`);
    const m = sText.match(re);
    return m ? m[1].trim() : '';
  };

  return {
    forA: extract(`给${nA}看`),
    forB: extract(`给${nB}看`),
    forBoth: extract('给双方'),
    feelingSummaryA: extractSummary(nA),
    feelingSummaryB: extractSummary(nB),
  };
}

// ─── Fallback: serve frontend ───
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
