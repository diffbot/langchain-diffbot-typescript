import { DiffbotClient, resolveTokenFromEnv } from "@diffbot/typescript";
import { DiffbotKnowledgeGraphRetriever } from "@diffbot/langchain";

interface Env {
  DIFFBOT_API_TOKEN?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const client = new DiffbotClient({ token: resolveTokenFromEnv(undefined, env) });
    const retriever = new DiffbotKnowledgeGraphRetriever({ client, k: 1 });
    const docs = await retriever.invoke('type:Organization name:"Diffbot"');
    return Response.json(docs);
  },
};
