export interface EmbeddingClient {
  embed(texts: string[]): Promise<number[][]>;
}

interface EmbeddingClientConfig {
  apiBase: string;
  apiKey: string;
  model: string;
}

export function createEmbeddingClient(config: EmbeddingClientConfig): EmbeddingClient {
  return {
    async embed(texts: string[]): Promise<number[][]> {
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
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Embedding API error ${response.status}: ${body}`);
      }

      const json = (await response.json()) as {
        data: { embedding: number[]; index: number }[];
      };

      // Sort by index to ensure consistent ordering
      return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
    },
  };
}
