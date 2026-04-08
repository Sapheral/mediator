const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');

const app = express();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(express.json());
app.use(express.static('public'));

app.post('/api/analyze', async (req, res) => {
  const { inputA, inputB, nameA, nameB } = req.body;
  if (!inputA || !inputB) return res.status(400).json({ error: 'missing input' });

  const nA = nameA || 'A';
  const nB = nameB || 'B';

  const prompt = `你是一位专业的关系调解顾问。两个人（${nA} 和 ${nB}）在某件事上产生了分歧，他们分别描述了各自的感受。

${nA} 的描述：${inputA}

${nB} 的描述：${inputB}

请完成三部分分析，用温和、中立的语言，不要引用对方原话，转化为感受和需求的描述。直接用第二人称跟当前这方说话，永远用"你"，不要用"她/他"来指代当前读者。提到另一方时用对方的名字。

【给${nA}看】
直接跟 ${nA} 说话（用"你"），帮助 ${nA} 理解 ${nB} 在这件事里的感受和需求。不评判任何一方。

【给${nB}看】
直接跟 ${nB} 说话（用"你"），帮助 ${nB} 理解 ${nA} 在这件事里的感受和需求。不评判任何一方。

【给双方】
简短指出双方各自在意的核心，以及一个可能的前进方向。不超过100字。

请用中文回答，语气温和、克制、真诚。`;

  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }]
    });

    const text = message.content[0].text;

    const extract = (tag) => {
      const re = new RegExp(`【${tag}】\\s*([\\s\\S]*?)(?=【|$)`);
      const m = text.match(re);
      return m ? m[1].trim() : '';
    };

    // Generate initial feeling summaries for both parties
    const summaryPrompt = `基于以下两个人的描述，分别生成一份简短的感受摘要。摘要只包含情绪、需求和在意的核心点，不包含任何具体事件细节、对话原文或指向性描述。每份摘要不超过80字。

${nA} 的描述：${inputA}
${nB} 的描述：${inputB}

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

    res.json({
      forA: extract(`给${nA}看`),
      forB: extract(`给${nB}看`),
      forBoth: extract('给双方'),
      feelingSummaryA: extractSummary(nA),
      feelingSummaryB: extractSummary(nB)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/followup', async (req, res) => {
  const { who, question, inputA, inputB, ownHistory, ownFeelingSummary, otherFeelingSummary, nameA, nameB } = req.body;

  const nA = nameA || 'A';
  const nB = nameB || 'B';
  const currentName = who === 'a' ? nA : nB;
  const otherName = who === 'a' ? nB : nA;
  const ownInput = who === 'a' ? inputA : inputB;

  // Build own history text (only this party's previous follow-ups)
  const historyText = (ownHistory || []).map(h =>
    `${currentName} 说：${h.question}\nAI 回应：${h.answer}`
  ).join('\n\n');

  const prompt = `你是一位专业的关系调解顾问。以下是背景：

${currentName} 最初的描述：${ownInput}

${otherName} 目前的感受状态（抽象摘要，不含原话）：${otherFeelingSummary || '暂无'}

${historyText ? `${currentName} 之前的追问记录：\n${historyText}` : ''}

现在，${currentName} 有新的想法：
${question}

请直接跟 ${currentName} 说话，用"你"。提到另一方时用"${otherName}"。

重要规则：
- 你可以基于 ${otherName} 的感受摘要来帮助 ${currentName} 理解对方，但不要编造摘要中没有的具体细节。
- 不要透露 ${otherName} 说过的任何具体原话或事件描述。
- 语气温和、中立、真诚，不超过150字。用中文回答。`;

  try {
    // Step 1: Generate response to this party
    const message = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }]
    });
    const answer = message.content[0].text.trim();

    // Step 2: Update this party's feeling summary based on new input
    const updatePrompt = `以下是 ${currentName} 在一次关系调解对话中的最新表述：

${currentName} 之前的感受摘要：${ownFeelingSummary || '暂无'}

${currentName} 的新表述：${question}

请基于新表述更新 ${currentName} 的感受摘要。摘要只包含情绪、需求和在意的核心点，不包含任何具体事件细节、对话原文或指向性描述。不超过80字。只输出摘要内容，不要加标题或前缀。`;

    const updateMsg = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 256,
      messages: [{ role: 'user', content: updatePrompt }]
    });
    const updatedFeelingSummary = updateMsg.content[0].text.trim();

    res.json({ answer, updatedFeelingSummary });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
