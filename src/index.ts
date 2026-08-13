/*
  Public surface of @diffbot/langchain.

  Every user-facing class is re-exported here. New public surfaces go in their
  own module under src/ and get added to this barrel — tests/imports.test.ts
  and tests/readme_parity.test.ts both assert against this list.
*/

export { ChatDiffbot, type ChatDiffbotFields } from "./chat_models.js";

export {
  DiffbotExtractLoader,
  type DiffbotExtractLoaderFields,
  type ExtractDocumentMapper,
} from "./loaders/extract.js";
export {
  DiffbotCrawlLoader,
  defaultCrawlMapper,
  type CrawlEventMapper,
  type DiffbotCrawlLoaderFields,
} from "./loaders/crawl.js";

export {
  DiffbotKnowledgeGraphRetriever,
  type DiffbotKnowledgeGraphRetrieverFields,
} from "./retrievers/knowledge-graph.js";
export {
  DiffbotWebSearchRetriever,
  type DiffbotWebSearchRetrieverFields,
} from "./retrievers/web-search.js";

export {
  DiffbotExtractTool,
  type DiffbotExtractToolError,
  type DiffbotExtractToolFields,
  type DiffbotExtractToolOutput,
} from "./tools/extract.js";
export { DiffbotWebSearchTool, type DiffbotWebSearchToolFields } from "./tools/web-search.js";
export { DiffbotEntitiesTool, type DiffbotEntitiesToolFields } from "./tools/entities.js";
export {
  DiffbotKnowledgeGraphTool,
  type DiffbotKnowledgeGraphToolFields,
} from "./tools/knowledge-graph.js";
export {
  DiffbotOntologyTool,
  type DiffbotOntologyToolFields,
  type OntologyLookupError,
  type OntologyLookupResult,
} from "./tools/ontology.js";
export { DiffbotAskTool, type DiffbotAskToolFields } from "./tools/ask.js";
export {
  DiffbotDQLProbeTool,
  type DiffbotDQLProbeToolFields,
  type DQLProbeResult,
} from "./tools/dql-probe.js";

export {
  assertClient,
  dictToDocument,
  resolveK,
  shapeExtractResponse,
  DEFAULT_KG_CONTENT_FIELDS,
  DEFAULT_WEB_CONTENT_FIELDS,
  type DictToDocumentOptions,
  type DiffbotComponentFields,
  type DocumentMapper,
  type ShapedExtractResponse,
} from "./base.js";
