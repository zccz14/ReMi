import { logger } from "../logger.js";

const log = logger.child({ module: "embedding" });

export interface EmbeddingClient {
  embed(texts: string[], options?: { signal?: AbortSignal }): Promise<number[][]>;
}

interface EmbeddingClientConfig {
  apiBase: string;
  apiKey: string;
  model: string;
}

export function createEmbeddingClient(config: EmbeddingClientConfig): EmbeddingClient {
  return {
    async embed(texts: string[], options?: { signal?: AbortSignal }): Promise<number[][]> {
      const start = Date.now();
      log.debug({ model: config.model, textCount: texts.length }, "Embedding request");

      const response = await fetch(`${config.apiBase}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          input: texts,
          model: config.model,
        }),
        signal: options?.signal,
      });

      if (!response.ok) {
        const body = await response.text();
        const ms = Date.now() - start;
        log.error({ model: config.model, status: response.status, ms }, "Embedding API error");
        throw new Error(`Embedding API error ${response.status}: ${body}`);
      }

      const json = (await response.json()) as {
        data: { embedding: number[]; index: number }[];
      };

      const ms = Date.now() - start;
      log.info({ model: config.model, textCount: texts.length, ms }, "Embedding completed");

      // Sort by index to ensure consistent ordering
      return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
    },
  };
}
