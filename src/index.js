const express = require('express');
const { port, host, cliPath } = require('./config');
const cli = require('./cli');

const app = express();

// CORS: allow browser extensions / web pages to call this local service.
// Reflect the request Origin (or *) so both simple and credentialed calls work,
// and answer preflight (OPTIONS) requests which the browser sends for the
// JSON POST /v1/chat/completions with custom headers.
app.use((req, res, next) => {
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Requested-With');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

app.use(express.json({ limit: '10mb' }));

// The CLI subprocess transport (/v0) is deprecated for performance (per-request
// process spawn) and hidden by default; opt back in with QODER_ENABLE_CLI=1.
const CLI_ENABLED = process.env.QODER_ENABLE_CLI === '1';
if (CLI_ENABLED) {
  registerV0Routes();
} else {
  app.use('/v0', (_req, res) => {
    res.status(404).json({
      error: {
        message: 'CLI transport /v0 is disabled (slow subprocess path). Use /v1 instead; set QODER_ENABLE_CLI=1 to re-enable.',
        type: 'transport_disabled',
      },
    });
  });
}

function registerV0Routes() {

  function completionId() {
    return `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  // GET /v0/models (CLI transport)
  app.get('/v0/models', async (_req, res) => {
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

  // POST /v0/chat/completions (CLI transport)
  app.post('/v0/chat/completions', async (req, res) => {
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

  // GET /v0/quota
  app.get('/v0/quota', async (_req, res) => {
    try {
      const status = await cli.getStatus();
      res.json(status);
    } catch (e) {
      res.status(500).json({ error: { message: e.message, type: 'server_error' } });
    }
  });

}

// GET /health
app.get('/health', (_req, res) => res.json({ status: 'ok', primary: '/v1 (direct http)', cli: CLI_ENABLED ? cliPath : 'disabled' }));

// GET / — built-in demo chat console (single self-contained page, no CDN).
app.use('/', require('./playground').router);

// /v1: direct-HTTP transport with its own device-flow OAuth (no qodercli).
// /v2 stays as a compatibility alias of the same router.
app.use(['/v1', '/v2'], require('./api'));

app.listen(port, host, () => {
  console.log(`qoder-proxy listening on http://${host}:${port}`);
  console.log(`  GET  /                      demo chat console (open in a browser)`);
  console.log(`  GET  /v1/models            (model id = Name-product@alias, e.g. Qwen3.8-Flash-qoder@a1)`);
  console.log(`  POST /v1/chat/completions`);
  console.log(`  GET  /v1/accounts           GET /v1/auth/status`);
  console.log(`  authorize with \`pnpm run login\` (add --product qodercn for the China version)`);
  console.log(`  (/v2 = alias of /v1; /v0 CLI transport ${CLI_ENABLED ? `enabled, CLI: ${cliPath}` : 'hidden — QODER_ENABLE_CLI=1 to re-enable'})`);
});
