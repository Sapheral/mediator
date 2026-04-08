const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');

const app = express();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(express.json());
app.use(express.static('public'));

app.post('/api/analyze', async (req, res) => {
  const { inputA, inputB } = req.body;
  if (!inputA || !inputB) return res.status(400).json({ error: 'missing input' });

  const prompt = `你是一位专业的关系调解顾问。两个人（A 和 B）在某件事上产生了分歧，他们分别描述了各自的感受。

A 的描述：${inputA}

B 的描述：${inputB}

请完成三部分分析，用温和、中立的语言，不要引用对方原话，转化为感受和需求的描述。直接用第二人称跟当前这方说话，永远用"你"，不要用"她/他"来指代当前读者。

【给A看】
直接跟 A 说话（用"你"），帮助 A 理解 B 在这件事里的感受和需求。不评判任何一方。

【给B看】
直接跟 B 说话（用"你"），帮助 B 理解 A 在这件事里的感受和需求。不评判任何一方。

【给双方】
简短指出双方各自在意的核心，以及一个可能的前进方向。不超过100字。

请用中文回答，语气温和、克制、真诚。`;

  try {
    const message = await client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }]
    });

    const text = message.content[0].text;

    const extract = (tag) => {
      const re = new RegExp(`【${tag}】\\s*([\\s\\S]*?)(?=【|$)`);
      const m = text.match(re);
      return m ? m[1].trim() : '';
    };

    res.json({
      forA: extract('给A看'),
      forB: extract('给B看'),
      forBoth: extract('给双方')
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/followup', async (req, res) => {
  const { who, question, inputA, inputB, summaryA, summaryB, history } = req.body;

  const historyText = (history || []).map(h =>
    `${h.who.toUpperCase()} 追问：${h.question}\nAI 回应：${h.answer}`
  ).join('\n\n');

  const prompt = `你是一位专业的关系调解顾问。以下是背景：

${who === 'a' ? `A 的原始描述：${inputA}\nA 的分析摘要：${summaryA}` : `B 的原始描述：${inputB}\nB 的分析摘要：${summaryB}`}

${historyText ? `之前的追问记录：\n${historyText}` : ''}

现在，${who.toUpperCase()} 有一个追问：
${question}

请直接跟 ${who.toUpperCase()} 说话，用"你"。语气温和、中立、真诚，不超过150字。用中文回答。`;

  try {
    const message = await client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }]
    });
    res.json({ answer: message.content[0].text.trim() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
