const express = require('express');
const { port, host, cliPath } = require('./config');
const cli = require('./cli');

const app = express();
app.use(express.json({ limit: '10mb' }));

function completionId() {
  return `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// GET /v1/models
app.get('/v1/models', async (_req, res) => {
  try {
    const models = await cli.listModels();
    res.json({
      object: 'list',
      data: models.map(m => ({
        id: m.id,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'qoder',
        name: m.name || m.id,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: { message: e.message, type: 'server_error' } });
  }
});

// POST /v1/chat/completions
app.post('/v1/chat/completions', async (req, res) => {
  const { model, messages, stream } = req.body;

  if (!model || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: { message: 'model and messages are required', type: 'invalid_request' } });
  }

  const id = completionId();
  const created = Math.floor(Date.now() / 1000);

  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    let closed = false;
    let sentText = false;
    let errMsg = null;

    send({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });

    const child = cli.chatStream(model, messages, event => {
      if (closed) return;

      if (event.type === 'delta') {
        sentText = true;
        send({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: event.text }, finish_reason: null }] });
      } else if (event.type === 'error') {
        // stderr noise (init/warnings) is not terminal; only surface it if nothing
        // streamed by the time the child closes (handled in the 'close' branch).
        if (!errMsg) errMsg = event.message;
      } else if (event.type === 'close') {
        if (errMsg && !sentText) {
          send({ error: { message: errMsg, type: 'server_error' } });
        } else {
          send({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        }
        res.write(`data: [DONE]\n\n`);
        closed = true;
        res.end();
      }
    });

    // res (not req): req 'close' fires once the request body is consumed,
    // which would abort the stream prematurely. res 'close' = client disconnected.
    res.on('close', () => { if (!res.writableEnded) { closed = true; child.kill(); } });
  } else {
    try {
      const { text, usage } = await cli.chatComplete(model, messages);
      res.json({
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    } catch (e) {
      res.status(500).json({ error: { message: e.message, type: 'server_error' } });
    }
  }
});

// GET /v1/quota
app.get('/v1/quota', async (_req, res) => {
  try {
    const status = await cli.getStatus();
    res.json(status);
  } catch (e) {
    res.status(500).json({ error: { message: e.message, type: 'server_error' } });
  }
});

app.get('/health', (_req, res) => res.json({ status: 'ok', cli: cliPath }));

app.listen(port, host, () => {
  console.log(`qoder-proxy listening on http://${host}:${port}`);
  console.log(`  CLI: ${cliPath}`);
  console.log(`  GET  /v1/models`);
  console.log(`  POST /v1/chat/completions`);
  console.log(`  GET  /v1/quota`);
});
