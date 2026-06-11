/**
 * Fase 3: endpoint de chat sobre el RagAgent.
 *
 *   POST /chat  { "question": "...", "session_id": "opcional" }
 *     -> { "answer": "...", "session_id": "..." }
 *
 * Las sesiones (historial de conversación) viven en memoria — suficiente para
 * el MVP; persistencia de sesiones viene post-validación.
 */
import express from "express";
import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { RagAgent } from "./rag.js";

export interface ServeOptions {
  dbPath: string;
  port?: number;
  model?: string;
}

export function serve(opts: ServeOptions) {
  const agent = new RagAgent({ dbPath: opts.dbPath, model: opts.model });
  const sessions = new Map<string, Anthropic.MessageParam[]>();
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ ok: true, db: opts.dbPath });
  });

  app.post("/chat", async (req, res) => {
    const { question, session_id } = req.body ?? {};
    if (typeof question !== "string" || !question.trim())
      return res.status(400).json({ error: "Falta el campo 'question' (string)." });

    const id = typeof session_id === "string" && sessions.has(session_id) ? session_id : randomUUID();
    try {
      const result = await agent.ask(question, sessions.get(id) ?? [], {
        onTool: (name, input) =>
          console.log(`  [${id.slice(0, 8)}] herramienta: ${name} ${JSON.stringify(input)}`),
      });
      sessions.set(id, result.history);
      res.json({ answer: result.answer, session_id: id, usage: result.usage });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  const port = opts.port ?? 3000;
  app.listen(port, () => {
    console.log(`fred escuchando en http://localhost:${port}`);
    console.log(`  Base: ${opts.dbPath}`);
    console.log(`  Prueba: curl -X POST http://localhost:${port}/chat -H "Content-Type: application/json" -d "{\\"question\\": \\"¿dónde está la regla de descuentos?\\"}"`);
  });
}
